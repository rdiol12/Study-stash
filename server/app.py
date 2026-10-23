"""HTTP API wrapper around main.py so a browser extension can drive downloads.

Runs inside the container next to main.py. Jobs are subprocesses; stdout is
tailed into a ring buffer that the extension polls with a cursor.
"""

import os
import re
import signal
import subprocess
import threading
import time
import uuid
from collections import deque

from flask import Flask, jsonify, request
from waitress import serve

APP_DIR = os.environ.get("UD_APP_DIR", "/app")
OUT_DIR = os.environ.get("UD_OUT_DIR", os.path.join(APP_DIR, "out_dir"))
# Host drive bind-mounted here; the extension browses it to pick a destination.
LIBRARY = os.environ.get("UD_LIBRARY", "/library")
COOKIE_PATH = os.path.join(APP_DIR, "cookies.txt")
API_TOKEN = os.environ.get("UD_API_TOKEN", "").strip()
MAX_JOBS = max(1, int(os.environ.get("UD_MAX_JOBS", "1")))
LOG_CAP = max(200, int(os.environ.get("UD_LOG_CAP", "4000")))
PORT = int(os.environ.get("UD_PORT", "8787"))

COURSE_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+\.udemy\.com/[^\s]*$")
LANG_RE = re.compile(r"^(all|[A-Za-z]{2}(?:[-_][A-Za-z0-9]{2,8})?)$")
CHAPTER_RE = re.compile(r"^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$")
ORIGIN_RE = re.compile(r"^(chrome-extension://[a-z]{32}|moz-extension://[0-9a-f-]+)$")
PROGRESS_RE = re.compile(r"Processing lecture (\d+) of (\d+)")
TOTAL_RE = re.compile(r"Lecture\(s\) \((\d+)\)")
PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)%")

H265_PRESETS = {
    "ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow", "placebo",
}
# nvenc rejects the x265 preset names outright, which fails the mux. Its own
# set is p1-p7 plus the legacy aliases.
NVENC_PRESETS = {
    "p1", "p2", "p3", "p4", "p5", "p6", "p7",
    "default", "slow", "medium", "fast", "hp", "hq", "ll", "llhq", "llhp", "lossless",
}
LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}

BOOL_FLAGS = {
    "skip_lectures": "--skip-lectures",
    "download_assets": "--download-assets",
    "download_captions": "--download-captions",
    "download_quizzes": "--download-quizzes",
    "keep_vtt": "--keep-vtt",
    "skip_hls": "--skip-hls",
    "info": "--info",
    "id_as_course_name": "--id-as-course-name",
    "subscription_course": "-sc",
    "save_to_file": "--save-to-file",
    "load_from_file": "--load-from-file",
    "use_h265": "--use-h265",
    "use_nvenc": "--use-nvenc",
    "continue_lecture_numbers": "-n",
}


class BadRequest(Exception):
    pass


def _int_in(value, name, low, high):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{name} must be an integer")
    if not low <= n <= high:
        raise BadRequest(f"{name} must be between {low} and {high}")
    return n


def resolve_dest(rel):
    """Map a client-supplied relative path to a real directory under LIBRARY.

    Everything the extension sends is untrusted, so this never accepts an
    absolute path and never resolves outside the mounted root.
    """
    rel = (rel or "").strip().replace("\\", "/")
    parts = [p for p in rel.split("/") if p]
    if ".." in parts:
        raise BadRequest("dest must be a relative path without '..'")
    root = os.path.realpath(LIBRARY)
    full = os.path.realpath(os.path.join(root, *parts)) if parts else root
    if full != root and not full.startswith(root + os.sep):
        raise BadRequest("dest resolves outside the library root")
    return full


def build_argv(body):
    """Whitelist the request body into an argv list. No shell, ever."""
    course_url = (body.get("course_url") or "").strip()
    if not COURSE_URL_RE.match(course_url):
        raise BadRequest("course_url must be a https://<portal>.udemy.com/... URL")

    dest = body.get("dest")
    if dest:
        out_dir = resolve_dest(dest)
        # /library itself is only a parent for the per-drive mounts; writing
        # there lands in the container's own filesystem and is lost on restart
        if out_dir == os.path.realpath(LIBRARY):
            raise BadRequest(
                "that is the library root, not a drive — pick a folder inside one (e.g. A/Courses)"
            )
    else:
        out_dir = OUT_DIR
    if not os.path.isdir(out_dir):
        raise BadRequest(f"destination does not exist: {out_dir}")
    if not os.access(out_dir, os.W_OK):
        raise BadRequest(f"destination is not writable: {out_dir}")

    argv = ["python", "main.py", "-c", course_url, "-o", out_dir]

    if body.get("quality") not in (None, "", "best"):
        argv += ["-q", str(_int_in(body["quality"], "quality", 1, 4320))]

    lang = (body.get("lang") or "").strip()
    if lang:
        if not LANG_RE.match(lang):
            raise BadRequest("lang must be a locale like 'en', 'pt_BR', or 'all'")
        argv += ["-l", lang]

    if body.get("concurrent_downloads"):
        argv += ["-cd", str(_int_in(body["concurrent_downloads"], "concurrent_downloads", 1, 30))]

    chapter = (body.get("chapter") or "").replace(" ", "")
    if chapter:
        if not CHAPTER_RE.match(chapter):
            raise BadRequest("chapter must look like '1,3-5,7'")
        argv += ["--chapter", chapter]

    if body.get("use_h265"):
        argv += ["--h265-crf", str(_int_in(body.get("h265_crf", 28), "h265_crf", 0, 51))]
        preset = (body.get("h265_preset") or "medium").strip()
        if body.get("use_nvenc"):
            if preset not in NVENC_PRESETS:
                raise BadRequest(
                    f"'{preset}' is an x265 preset; nvenc needs one of: "
                    + ", ".join(sorted(NVENC_PRESETS))
                )
        elif preset not in H265_PRESETS:
            raise BadRequest("h265_preset is not a valid x265 preset")
        argv += ["--h265-preset", preset]

    if body.get("use_nvenc"):
        # main.py only builds a transcode command when use_h265 is set
        # (main.py:1317), so --use-nvenc on its own is silently a no-op.
        if not body.get("use_h265"):
            raise BadRequest("use_nvenc only applies when use_h265 is also set")
        gpu = gpu_info()
        if not gpu["nvenc_ready"]:
            # fail now rather than after the whole course has downloaded
            raise BadRequest(f"NVENC is not usable in this container: {gpu['detail']}")

    log_level = (body.get("log_level") or "INFO").strip().upper()
    if log_level not in LOG_LEVELS:
        raise BadRequest("log_level is not valid")
    argv += ["--log-level", log_level]

    for key, flag in BOOL_FLAGS.items():
        if body.get(key):
            argv.append(flag)

    # cookies.txt is written per-job; tell main.py to read it instead of a browser
    if (body.get("cookies_txt") or "").strip():
        argv += ["--browser", "file"]

    return argv, course_url


class Job:
    def __init__(self, body):
        self.argv, self.course_url = build_argv(body)
        self.id = uuid.uuid4().hex[:12]
        self.bearer = (body.get("bearer") or "").strip()
        self.cookies_txt = (body.get("cookies_txt") or "").strip()
        self.status = "queued"
        self.created = time.time()
        self.started = None
        self.finished = None
        self.returncode = None
        self.error = None
        self.current = ""
        self.lecture = None
        self.total_lectures = None
        self.percent = None
        self.proc = None
        self.cancelled = False
        self._lines = deque(maxlen=LOG_CAP)
        self._dropped = 0
        self._seq = 0
        self._lock = threading.Lock()

    # ---------- logging ----------

    def _redact(self, text):
        if self.bearer and len(self.bearer) > 8:
            text = text.replace(self.bearer, "<bearer redacted>")
        return text

    def add_line(self, line):
        line = self._redact(line.rstrip())
        if not line:
            return
        with self._lock:
            if len(self._lines) == self._lines.maxlen:
                self._dropped += 1
            self._seq += 1
            self._lines.append((self._seq, line))
        m = PROGRESS_RE.search(line)
        if m:
            self.lecture, self.total_lectures = int(m.group(1)), int(m.group(2))
        m = TOTAL_RE.search(line)
        if m:
            self.total_lectures = int(m.group(1))

    def lines_since(self, cursor):
        with self._lock:
            out = [(s, t) for s, t in self._lines if s > cursor]
            return out, self._seq, self._dropped

    # ---------- lifecycle ----------

    def run(self):
        self.status = "running"
        self.started = time.time()
        env = dict(os.environ)
        if self.bearer:
            env["UDEMY_BEARER"] = self.bearer
        else:
            env.pop("UDEMY_BEARER", None)
        env["PYTHONUNBUFFERED"] = "1"

        if self.cookies_txt:
            with open(COOKIE_PATH, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(self.cookies_txt if self.cookies_txt.endswith("\n") else self.cookies_txt + "\n")
            os.chmod(COOKIE_PATH, 0o600)

        self.add_line("$ " + " ".join(self.argv))
        try:
            self.proc = subprocess.Popen(
                self.argv,
                cwd=APP_DIR,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            self.status, self.error = "failed", str(exc)
            self.finished = time.time()
            return

        # main.py:2198 is the only input() in the program: a y/n confirmation
        # on --info for large courses. With no stdin it raises EOFError and
        # kills the run, so pre-answer it and close the pipe.
        try:
            self.proc.stdin.write(b"y\n" * 20)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self.proc.stdin.close()
        except OSError:
            pass

        self._pump(self.proc)
        self.returncode = self.proc.wait()
        self.finished = time.time()
        self.current = ""
        if self.cancelled:
            self.status = "cancelled"
        elif self.returncode == 0:
            self.status = "done"
        else:
            self.status = "failed"
            self.error = f"main.py exited with code {self.returncode}"

    def _pump(self, proc):
        """Split on \\r as well as \\n so tqdm progress bars show up live."""
        buf = ""
        fd = proc.stdout.fileno()
        while True:
            try:
                raw = os.read(fd, 8192)
            except OSError:
                break
            if not raw:
                break
            buf += raw.decode("utf-8", "replace")
            parts = re.split(r"[\r\n]", buf)
            buf = parts.pop()
            for part in parts:
                self.add_line(part)
            # always reassign, even when empty: otherwise an unterminated line
            # (e.g. main.py's "(y/n): " prompt) stays pinned in the status
            # field for the rest of the job
            self.current = self._redact(buf.strip()) if buf else ""
            if buf:
                pct = PERCENT_RE.search(buf)
                if pct:
                    self.percent = float(pct.group(1))
        if buf.strip():
            self.add_line(buf)
        proc.stdout.close()

    def cancel(self):
        if self.status == "queued":
            self.cancelled = True
            self.status = "cancelled"
            self.finished = time.time()
            return True
        if self.status != "running" or not self.proc:
            return False
        self.cancelled = True
        self.add_line("> cancellation requested")
        try:
            # kill the whole group: main.py spawns yt-dlp, aria2c and ffmpeg
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            return False
        threading.Timer(10.0, self._hard_kill).start()
        return True

    def _hard_kill(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def summary(self):
        return {
            "id": self.id,
            "course_url": self.course_url,
            "status": self.status,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "returncode": self.returncode,
            "error": self.error,
            "current": self.current,
            "lecture": self.lecture,
            "total_lectures": self.total_lectures,
            "percent": self.percent,
            "argv": self.argv,
        }


class Runner:
    def __init__(self):
        self.jobs = {}
        self.order = deque(maxlen=100)
        self.pending = deque()
        self.active = 0
        self.lock = threading.Lock()

    def submit(self, body):
        job = Job(body)
        with self.lock:
            self.jobs[job.id] = job
            self.order.append(job.id)
            self._prune()
            self.pending.append(job)
        self._drain()
        return job

    def _prune(self):
        live = set(self.order)
        for jid in [j for j in self.jobs if j not in live]:
            self.jobs.pop(jid, None)

    def _drain(self):
        with self.lock:
            if self.active >= MAX_JOBS or not self.pending:
                return
            job = self.pending.popleft()
            while job.cancelled and self.pending:
                job = self.pending.popleft()
            if job.cancelled:
                return
            self.active += 1
        threading.Thread(target=self._run, args=(job,), daemon=True).start()

    def _run(self, job):
        try:
            job.run()
        except Exception as exc:  # keep the worker slot recoverable
            job.status, job.error = "failed", repr(exc)
            job.finished = time.time()
        finally:
            with self.lock:
                self.active -= 1
            self._drain()

    def list(self):
        with self.lock:
            return [self.jobs[j].summary() for j in reversed(self.order) if j in self.jobs]

    def _forget(self, job_id):
        """Caller must hold the lock."""
        self.jobs.pop(job_id, None)
        try:
            self.order.remove(job_id)
        except ValueError:
            pass

    def remove(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return "missing"
            if job.status == "running":
                return "running"
            if job.status == "queued":
                # drop it from the queue so _drain never picks it up
                job.cancelled = True
                job.status = "cancelled"
                try:
                    self.pending.remove(job)
                except ValueError:
                    pass
            self._forget(job_id)
            return "removed"

    def clear_finished(self):
        with self.lock:
            stale = [
                jid for jid, job in self.jobs.items()
                if job.status in ("done", "failed", "cancelled")
            ]
            for jid in stale:
                self._forget(jid)
            return len(stale)


runner = Runner()
app = Flask(__name__)


@app.after_request
def cors(resp):
    origin = request.headers.get("Origin", "")
    if ORIGIN_RE.match(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Api-Token"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Max-Age"] = "600"
    return resp


@app.before_request
def auth():
    if request.method == "OPTIONS" or request.path == "/api/health":
        return None
    if API_TOKEN and request.headers.get("X-Api-Token", "") != API_TOKEN:
        return jsonify(error="bad or missing X-Api-Token"), 401
    return None


@app.errorhandler(BadRequest)
def bad_request(exc):
    return jsonify(error=str(exc)), 400


def _which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return True
    return False


_gpu_cache = None
_gpu_lock = threading.Lock()


def gpu_info(refresh=False):
    """Probe NVENC. Listing the encoder isn't proof it initialises, so this
    actually encodes a couple of synthetic frames."""
    global _gpu_cache
    with _gpu_lock:
        if _gpu_cache is not None and not refresh:
            return _gpu_cache

        info = {
            "nvidia_smi": False,
            "name": None,
            "driver": None,
            "encoders": [],
            "nvenc_ready": False,
            "detail": "",
        }

        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=15,
            )
            if out.returncode == 0 and out.stdout.strip():
                info["nvidia_smi"] = True
                parts = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
                info["name"] = parts[0]
                if len(parts) > 1:
                    info["driver"] = parts[1]
            else:
                info["detail"] = "nvidia-smi ran but reported no GPU"
        except FileNotFoundError:
            info["detail"] = "no nvidia-smi in container: GPU is not passed through"
        except Exception as exc:
            info["detail"] = f"nvidia-smi failed: {exc}"

        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-encoders"],
                capture_output=True, text=True, timeout=30,
            )
            info["encoders"] = sorted(set(re.findall(r"\b(\w+_nvenc)\b", out.stdout)))
        except Exception as exc:
            info["detail"] = f"{info['detail']}; ffmpeg -encoders failed: {exc}".strip("; ")

        if info["nvidia_smi"] and "hevc_nvenc" in info["encoders"]:
            try:
                probe = subprocess.run(
                    ["ffmpeg", "-hide_banner", "-nostdin", "-f", "lavfi",
                     "-i", "testsrc=duration=0.2:size=256x256:rate=10",
                     # testsrc is rgb24; nvenc wants yuv420p. Be explicit so the
                     # probe tests the encoder, not ffmpeg's auto-conversion.
                     "-pix_fmt", "yuv420p",
                     "-c:v", "hevc_nvenc", "-f", "null", "-"],
                    capture_output=True, text=True, timeout=60,
                )
                if probe.returncode == 0:
                    info["nvenc_ready"] = True
                    info["detail"] = "ready (encode probe passed)"
                else:
                    # the last stderr line is just "Conversion failed!"; the
                    # actionable cause is further up (driver/API mismatch etc.)
                    lines = (probe.stderr or "").splitlines()
                    keys = ("nvenc API", "minimum required", "Error while opening",
                            "No capable devices", "OpenEncodeSessionEx")
                    hits = [l.strip() for l in lines if any(k in l for k in keys)]
                    why = hits[0] if hits else (lines[-1].strip() if lines else "unknown")
                    info["detail"] = f"hevc_nvenc present but the encode probe failed: {why[:240]}"
            except Exception as exc:
                info["detail"] = f"encode probe error: {exc}"
        elif info["nvidia_smi"] and not info["encoders"]:
            info["detail"] = "GPU visible but this ffmpeg build has no nvenc encoders"

        _gpu_cache = info
        return info


@app.get("/api/health")
def health():
    return jsonify(
        ok=True,
        auth_required=bool(API_TOKEN),
        out_dir=OUT_DIR,
        max_jobs=MAX_JOBS,
        active=runner.active,
        tools={n: _which(n) for n in ("ffmpeg", "aria2c", "yt-dlp")},
        gpu=gpu_info(refresh=request.args.get("refresh") == "1"),
        library={
            "path": LIBRARY,
            "mounted": os.path.isdir(LIBRARY),
            "writable": os.path.isdir(LIBRARY) and os.access(LIBRARY, os.W_OK),
        },
    )


@app.get("/api/browse")
def browse():
    """List subdirectories under the mounted library so the popup can offer a
    folder picker. Directories only: the extension never needs file listings."""
    full = resolve_dest(request.args.get("path", ""))
    if not os.path.isdir(full):
        return jsonify(error="not a directory"), 404
    try:
        with os.scandir(full) as it:
            dirs = [e.name for e in it if e.is_dir() and not e.name.startswith(".")]
    except PermissionError:
        return jsonify(error="permission denied"), 403

    root = os.path.realpath(LIBRARY)
    rel = "" if full == root else os.path.relpath(full, root).replace(os.sep, "/")
    return jsonify(
        path=rel,
        parent="" if not rel else os.path.dirname(rel),
        dirs=sorted(dirs, key=str.lower),
        writable=os.access(full, os.W_OK),
        mounted=os.path.isdir(root),
    )


@app.post("/api/folders")
def make_folder():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise BadRequest("invalid folder name")
    if re.search(r'[<>:"|?*\x00-\x1f]', name):
        raise BadRequest("folder name contains characters Windows will reject")
    parent = resolve_dest(body.get("path"))
    target = os.path.join(parent, name)
    try:
        os.makedirs(target, exist_ok=True)
    except OSError as exc:
        raise BadRequest(f"could not create folder: {exc}")
    root = os.path.realpath(LIBRARY)
    return jsonify(path=os.path.relpath(target, root).replace(os.sep, "/")), 201


@app.post("/api/jobs")
def create_job():
    body = request.get_json(silent=True) or {}
    job = runner.submit(body)
    return jsonify(job.summary()), 201


@app.get("/api/jobs")
def list_jobs():
    return jsonify(jobs=runner.list())


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = runner.jobs.get(job_id)
    if not job:
        return jsonify(error="no such job"), 404
    cursor = request.args.get("cursor", type=int, default=0)
    lines, seq, dropped = job.lines_since(cursor)
    data = job.summary()
    data["log"] = [t for _, t in lines]
    data["cursor"] = seq
    data["dropped"] = dropped
    return jsonify(data)


@app.post("/api/jobs/clear")
def clear_jobs():
    """Forget every finished job. Running and queued jobs are left alone."""
    return jsonify(removed=runner.clear_finished())


@app.delete("/api/jobs/<job_id>")
def delete_job(job_id):
    result = runner.remove(job_id)
    if result == "missing":
        return jsonify(error="no such job"), 404
    if result == "running":
        return jsonify(error="job is still running — cancel it first"), 409
    return jsonify(removed=job_id)


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id):
    job = runner.jobs.get(job_id)
    if not job:
        return jsonify(error="no such job"), 404
    return jsonify(cancelled=job.cancel(), status=job.status)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    banner = f"udemy-downloader API on :{PORT} -> {OUT_DIR}"
    print(banner, flush=True)
    if not API_TOKEN:
        print("WARNING: UD_API_TOKEN is unset; any local page can queue jobs", flush=True)
    serve(app, host="0.0.0.0", port=PORT, threads=8, channel_timeout=120)
