"""Self-update for a git-cloned install, used by ud_host.py.

The extension is loaded unpacked from this repo and the helper runs from it,
so updating means fast-forwarding the checkout. The extension then reloads
itself; the helper picks up its own new code on the next spawn.

Ops:
  {"op": "update-check"}  -> fetch, report how far behind origin we are
  {"op": "update-apply"}  -> fast-forward to origin, refusing anything risky

Never prints: stdout belongs to the native messaging protocol, so every git
call captures its output.
"""

import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE = "origin"
BRANCH = "master"


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
    if not os.path.isdir(os.path.join(REPO, ".git")):
        raise ValueError("this install is not a git clone; re-install with git clone to get updates")
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


def op_update_check(msg):
    return _status(fetch=True)


def op_update_apply(msg):
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
