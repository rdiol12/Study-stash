"""Self-update for the install folder, used by ud_host.py.

The extension is loaded unpacked from this folder and the helper runs from it,
so updating means replacing the folder's files with the latest master. The
extension then reloads itself; the helper picks up its own new code on the
next spawn.

Two kinds of install:
  git clone    -> fetch + fast-forward; refuses on local edits/commits/branch
  ZIP download -> fetch master's ZIP from GitHub and copy it over the folder.
                  A state file remembers the installed commit and file hashes,
                  so local edits still block and removed files get cleaned up.
Either way, files git ignores (ud_host.bat, the host .json, .wvd) are never
touched: they aren't in the repo, so nothing overwrites them.

Ops:
  {"op": "update-check"}  -> report how far behind master we are
  {"op": "update-apply"}  -> update to master, refusing anything risky

Never prints: stdout belongs to the native messaging protocol, so every git
call captures its output.
"""

import fnmatch
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE = "origin"
BRANCH = "master"
GITHUB = "rdiol12/Study-stash"
STATE = os.path.join(REPO, ".update-state.json")
# never written or deleted by a ZIP update, whatever the archive holds
PROTECTED = [".update-state.json", "*.wvd", "*.prd", "native/ud_host.bat",
             "native/com.udemy_bridge.host.json", ".git", ".git/*"]
# GitHub allows 60 unauthenticated API calls an hour; the popup checks on open
CHECK_CACHE_SECS = 300


def _git(*args, timeout=60):
    exe = shutil.which("git")
    if not exe:
        raise ValueError("git is not installed or not on PATH")
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    proc = subprocess.run(
        [exe, "-C", REPO, *args],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=flags,
    )
    if proc.returncode != 0:
        raise ValueError((proc.stderr or proc.stdout).strip() or f"git {args[0]} failed")
    return proc.stdout.strip()


def _status(fetch=True):
    # ask git rather than looking for a .git folder: worktrees and some clients
    # use a .git file, and git's own error (e.g. dubious ownership) is useful
    try:
        top = _git("rev-parse", "--show-toplevel")
    except ValueError as exc:
        raise ValueError(f"the helper runs from {REPO}, which git can't use: {exc}")
    if not os.path.samefile(top, REPO):
        raise ValueError(f"the helper runs from {REPO}, which is not the top of a git clone")
    if fetch:
        _git("fetch", "--quiet", REMOTE, BRANCH)
    upstream = f"{REMOTE}/{BRANCH}"
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    behind = int(_git("rev-list", "--count", f"HEAD..{upstream}") or 0)
    ahead = int(_git("rev-list", "--count", f"{upstream}..HEAD") or 0)
    # untracked files don't block a fast-forward; edits to tracked ones can
    dirty = bool(_git("status", "--porcelain", "--untracked-files=no"))
    log = _git("log", "--format=%h %s", "-n", "15", f"HEAD..{upstream}") if behind else ""
    blocker = None
    if branch != BRANCH:
        blocker = f"on branch '{branch}', not '{BRANCH}'"
    elif ahead:
        blocker = f"{ahead} local commit(s) not on {upstream}"
    elif dirty:
        blocker = "files in the install folder were edited locally"
    return {
        "head": _git("rev-parse", "--short", "HEAD"),
        "branch": branch,
        "behind": behind,
        "ahead": ahead,
        "dirty": dirty,
        "blocker": blocker,
        "commits": [line for line in log.splitlines() if line],
    }


# --- ZIP installs -------------------------------------------------------------

def _http(url, accept="application/vnd.github+json"):
    req = urllib.request.Request(url, headers={"User-Agent": "udemy-bridge-updater", "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ValueError(f"GitHub can't find {GITHUB} (is the repo private?)")
        if exc.code in (403, 429):
            raise ValueError("GitHub rate limit reached; try again in an hour")
        raise ValueError(f"GitHub returned HTTP {exc.code}")
    except urllib.error.URLError as exc:
        raise ValueError(f"can't reach GitHub: {exc.reason}")


def _api(path):
    return json.loads(_http(f"https://api.github.com/repos/{GITHUB}/{path}"))


def _load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def _protected(rel):
    return any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(os.path.basename(rel), pat) for pat in PROTECTED)


def _hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _edited(files):
    """Installed files whose content no longer matches what the last update wrote."""
    out = []
    for rel, digest in files.items():
        full = os.path.join(REPO, rel)
        try:
            if os.path.isfile(full) and _hash(full) != digest:
                out.append(rel)
        except OSError:
            continue
    return out


def _zip_status(use_cache=True):
    state = _load_state()
    cached = state.get("last")
    if use_cache and cached and time.time() - state.get("checked", 0) < CHECK_CACHE_SECS:
        return cached
    latest = _api(f"commits/{BRANCH}")
    sha = latest["sha"]
    have = state.get("sha")
    unknown = not have
    if have == sha:
        behind, commits = 0, []
    elif have:
        cmp = _api(f"compare/{have}...{sha}")
        behind = cmp.get("ahead_by", 1)
        commits = [f"{c['sha'][:7]} {c['commit']['message'].splitlines()[0]}" for c in cmp.get("commits", [])][-15:][::-1]
    else:
        # first update of a ZIP install: we can't tell which commit it came from
        behind = 1
        commits = [f"{sha[:7]} {latest['commit']['message'].splitlines()[0]}"]
    edited = _edited(state.get("files", {}))
    st = {
        "mode": "zip",
        "head": have[:7] if have else "unknown",
        "latest": sha,
        "branch": BRANCH,
        "behind": behind,
        "unknown": unknown,
        "ahead": 0,
        "dirty": bool(edited),
        "blocker": f"files in the install folder were edited locally ({', '.join(edited[:3])})" if edited else None,
        "commits": commits,
    }
    state.update({"checked": time.time(), "last": st})
    _save_state(state)
    return st


def _zip_apply():
    st = _zip_status(use_cache=False)
    if st["blocker"]:
        raise ValueError(f"not updating: {st['blocker']}")
    if not st["behind"]:
        return {**st, "updated": False}
    sha = st["latest"]
    data = _http(f"https://codeload.github.com/{GITHUB}/zip/{sha}", accept="application/zip")
    state = _load_state()
    old_files = state.get("files", {})
    new_files = {}
    with tempfile.TemporaryDirectory() as tmp:
        # unpack everything first, so a bad download never leaves a half-updated folder
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                parts = info.filename.replace("\\", "/").split("/", 1)
                if len(parts) < 2 or not parts[1] or info.is_dir():
                    continue  # GitHub wraps everything in one <repo>-<sha>/ folder
                rel = os.path.normpath(parts[1]).replace(os.sep, "/")
                if rel.startswith("../") or os.path.isabs(rel) or _protected(rel):
                    continue
                dest = os.path.join(tmp, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                new_files[rel] = _hash(dest)
        if "native/updater.py" not in new_files:
            raise ValueError("the downloaded archive doesn't look like this project; not updating")
        for rel in new_files:
            target = os.path.join(REPO, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(os.path.join(tmp, rel), target)
    # files the previous update installed that master no longer has
    for rel, digest in old_files.items():
        full = os.path.join(REPO, rel)
        if rel in new_files or _protected(rel) or not os.path.isfile(full):
            continue
        try:
            if _hash(full) == digest:
                os.remove(full)
        except OSError:
            pass
    _save_state({"sha": sha, "files": new_files})
    return {**st, "head": sha[:7], "behind": 0, "commits": [], "updated": True, "from": st["head"]}


# --- ops ----------------------------------------------------------------------

def _is_clone():
    return os.path.exists(os.path.join(REPO, ".git"))


def op_update_check(msg):
    return _status(fetch=True) if _is_clone() else _zip_status()


def op_update_apply(msg):
    if not _is_clone():
        return _zip_apply()
    st = _status(fetch=True)
    if st["blocker"]:
        raise ValueError(f"not updating: {st['blocker']}")
    if not st["behind"]:
        return {**st, "updated": False}
    old = st["head"]
    _git("merge", "--ff-only", "--quiet", f"{REMOTE}/{BRANCH}", timeout=120)
    return {**_status(fetch=False), "updated": True, "from": old}


HANDLERS = {
    "update-check": op_update_check,
    "update-apply": op_update_apply,
}
