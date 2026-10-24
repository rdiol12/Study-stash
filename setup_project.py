#!/usr/bin/env python3
"""Automated setup script to generate the entire VibraVid Bridge structure."""

import os
from pathlib import Path

FILES = {
    "vibravid/__init__.py": '''from __future__ import annotations

__version__ = "1.0.0"
''',

    "vibravid/config.py": '''from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

@dataclass
class Config:
    engine_dir: Path = field(default_factory=lambda: Path("~/.vibravid-bridge/engine").expanduser())
    python: str = "python3"
    auto_update_binaries: bool = True
    media_root: Path = field(default_factory=lambda: Path("~/Videos/VibraVid").expanduser())
    max_concurrent: int = 2
    max_attempts: int = 3
    progress_interval: int = 2
    use_curl_cffi: bool = False
    provider_fallback: list[str] = field(default_factory=lambda: ["streamingcommunity", "animeunity"])
    cdm: str = "search"
    http_port: int = 8765
    token: str = ""
    
    @property
    def state_dir(self) -> Path:
        p = Path("~/.vibravid-bridge").expanduser()
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def db_path(self) -> Path:
        return self.state_dir / "jobs.sqlite3"

    @property
    def log_path(self) -> Path:
        return self.state_dir / "bridge.log"

    @classmethod
    def load(cls) -> Config:
        cfg = cls()
        env_config = os.getenv("VIBRAVID_BRIDGE_CONFIG")
        config_file = Path(env_config).expanduser() if env_config else Path("~/.vibravid-bridge/config.toml").expanduser()
        
        if config_file.is_file():
            import tomllib
            with open(config_file, "rb") as f:
                data = tomllib.load(f)
            
            eng = data.get("engine", {})
            if "dir" in eng: cfg.engine_dir = Path(eng["dir"]).expanduser()
            if "python" in eng: cfg.python = eng["python"]
            if "auto_update_binaries" in eng: cfg.auto_update_binaries = eng["auto_update_binaries"]

            dl = data.get("download", {})
            if "media_root" in dl: cfg.media_root = Path(dl["media_root"]).expanduser()
            if "max_concurrent" in dl: cfg.max_concurrent = dl["max_concurrent"]
            if "max_attempts" in dl: cfg.max_attempts = dl["max_attempts"]
            if "progress_interval" in dl: cfg.progress_interval = dl["progress_interval"]
            if "use_curl_cffi" in dl: cfg.use_curl_cffi = dl["use_curl_cffi"]
            if "provider_fallback" in dl: cfg.provider_fallback = dl["provider_fallback"]

            drm = data.get("drm", {})
            if "cdm" in drm: cfg.cdm = drm["cdm"]

            bridge = data.get("bridge", {})
            if "http_port" in bridge: cfg.http_port = bridge["http_port"]
            if "token" in bridge: cfg.token = bridge["token"]

        return cfg
''',

    "vibravid/engine.py": '''from __future__ import annotations

import json
import logging
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger(__name__)

class EngineError(Exception):
    pass

@dataclass
class Progress:
    percent: int = 0
    done: str = "0"
    total: str = "0"
    speed: str = "0"
    eta: str = "0"
    kind: str = "video"
    resolution: str = "unknown"

@dataclass
class RunResult:
    ok: bool
    returncode: int
    stdout: str
    stderr: str

def parse_size(val: str) -> int:
    if not val:
        return 0
    val = val.strip().upper()
    mult = 1
    if val.endswith("KB"): mult, val = 1024, val[:-2]
    elif val.endswith("MB"): mult, val = 1024**2, val[:-2]
    elif val.endswith("GB"): mult, val = 1024**3, val[:-2]
    elif val.endswith("B"): val = val[:-1]
    try:
        return int(float(val.strip()) * mult)
    except ValueError:
        return 0

class VibraVidEngine:
    def __init__(self, cfg: Any) -> None:
        self.cfg = cfg

    def health(self) -> dict[str, Any]:
        manual = self.cfg.engine_dir / "manual.py"
        return {"installed": manual.is_file(), "dir": str(self.cfg.engine_dir)}

    def cdm_status(self) -> dict[str, Any]:
        cdm_dir = self.cfg.engine_dir / "cdm"
        wvd_files = list(cdm_dir.glob("*.wvd")) if cdm_dir.is_dir() else []
        return {"available": len(wvd_files) > 0, "count": len(wvd_files), "path": str(cdm_dir)}

    def binary_update(self) -> RunResult:
        cmd = [self.cfg.python, "-m", "pip", "install", "--upgrade", "vibravid"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return RunResult(res.returncode == 0, res.returncode, res.stdout, res.stderr)

    def resolve(self, export_path: Path, url: str, **kwargs: Any) -> RunResult:
        cmd = [self.cfg.python, "-m", "vibravid", "resolve", "--url", url, "--export", str(export_path)]
        if kwargs.get("stream_type"): cmd.extend(["--stream-type", kwargs["stream_type"]])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise EngineError(res.stderr.strip() or "Failed to resolve stream")
        return RunResult(True, 0, res.stdout, res.stderr)

    def build_download(self, export_path: Path | None, url: str | None, output: Path, **kwargs: Any) -> list[str]:
        cmd = [self.cfg.python, "-m", "vibravid", "download", "--output", str(output)]
        if export_path and export_path.is_file():
            cmd.extend(["--import", str(export_path)])
        elif url:
            cmd.extend(["--url", url])
        return cmd

    def run_streaming(self, cmd: list[str], on_progress: Callable[[Progress], None], on_line: Callable[[str], None], cancel: threading.Event) -> RunResult:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        stdout_lines = []
        try:
            while True:
                if cancel.is_set():
                    proc.terminate()
                    return RunResult(False, -9, "", "Cancelled by user")
                line = proc.stdout.readline() if proc.stdout else ""
                if not line and proc.poll() is not None:
                    break
                if line:
                    clean = line.strip()
                    stdout_lines.append(clean)
                    on_line(clean)
                    if "%" in clean:
                        try:
                            parts = clean.split()
                            pct = int(parts[0].replace("%", "").strip())
                            on_progress(Progress(percent=pct))
                        except Exception:
                            pass
            code = proc.wait()
            return RunResult(code == 0, code, "\\n".join(stdout_lines), "")
        except Exception as exc:
            proc.kill()
            return RunResult(False, -1, "", str(exc))
''',

    "vibravid/jobs.py": '''from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    url TEXT,
    service TEXT,
    search TEXT,
    season TEXT,
    episode TEXT,
    stream_type TEXT,
    output TEXT,
    export_path TEXT,
    status TEXT NOT NULL,
    phase TEXT,
    percent INTEGER DEFAULT 0,
    bytes_done INTEGER DEFAULT 0,
    bytes_total INTEGER DEFAULT 0,
    speed TEXT,
    eta TEXT,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    meta TEXT DEFAULT '{}',
    created REAL NOT NULL,
    updated REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
"""

TERMINAL = {"done", "failed", "cancelled"}

@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    url: str | None = None
    service: str | None = None
    search: str | None = None
    season: str | None = None
    episode: str | None = None
    stream_type: str | None = None
    output: str | None = None
    export_path: str | None = None
    phase: str | None = None
    percent: int = 0
    bytes_done: int = 0
    bytes_total: int = 0
    speed: str | None = None
    eta: str | None = None
    error: str | None = None
    attempts: int = 0
    meta: dict[str, Any] = field(default_factory=dict)
    created: float = 0.0
    updated: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        data = self.__dict__.copy()
        data["meta"] = self.meta
        return data

class JobStore:
    def __init__(self, db_path: Path) -> None:
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def create(self, kind: str, **fields: Any) -> Job:
        now = time.time()
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, created=now, updated=now, **fields)
        with self._lock:
            self._conn.execute(
                \"\"\"INSERT INTO jobs (id, kind, url, service, search, season, episode,
                       stream_type, output, export_path, status, phase, percent,
                       bytes_done, bytes_total, speed, eta, error, attempts, meta,
                       created, updated)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\"\"\",
                (job.id, job.kind, job.url, job.service, job.search, job.season,
                 job.episode, job.stream_type, job.output, job.export_path, job.status,
                 job.phase, job.percent, job.bytes_done, job.bytes_total, job.speed,
                 job.eta, job.error, job.attempts, json.dumps(job.meta),
                 job.created, job.updated),
            )
            self._conn.commit()
        return job

    def update(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        if "meta" in fields:
            fields["meta"] = json.dumps(fields["meta"])
        fields["updated"] = time.time()
        clause = ", ".join(f"{key} = ?" for key in fields)
        with self._lock:
            self._conn.execute(f"UPDATE jobs SET {clause} WHERE id = ?", (*fields.values(), job_id))
            self._conn.commit()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._row(row) if row else None

    def list(self, statuses: Iterable[str] | None = None, limit: int = 200) -> list[Job]:
        sql, params = "SELECT * FROM jobs", ()
        if statuses:
            marks = ",".join("?" for _ in statuses)
            sql += f" WHERE status IN ({marks})"
            params = tuple(statuses)
        sql += " ORDER BY created DESC LIMIT ?"
        with self._lock:
            rows = self._conn.execute(sql, (*params, limit)).fetchall()
        return [self._row(row) for row in rows]

    def reset_interrupted(self) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE jobs SET status='queued', phase='resumed', updated=? WHERE status IN ('running','resolving')",
                (time.time(),),
            )
            self._conn.commit()
        return cursor.rowcount

    def bump_attempt(self, job_id: str) -> int:
        job = self.get(job_id)
        attempts = (job.attempts if job else 0) + 1
        self.update(job_id, attempts=attempts)
        return attempts

    def clear_history(self) -> int:
        with self._lock:
            cursor = self._conn.execute(
                f"DELETE FROM jobs WHERE status IN ({','.join('?' for _ in TERMINAL)})",
                tuple(TERMINAL),
            )
            self._conn.commit()
        return cursor.rowcount

    @staticmethod
    def _row(row: sqlite3.Row) -> Job:
        data = dict(row)
        data["meta"] = json.loads(data.get("meta") or "{}")
        return Job(**data)
''',

    "vibravid/vault.py": '''from __future__ import annotations

import json
from pathlib import Path
from typing import Any

class KeyVault:
    def __init__(self, cfg: Any) -> None:
        self.cfg = cfg
        self.vault_dir = self.cfg.state_dir / "vault"
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir = self.cfg.state_dir / "exports"
        self.exports_dir.mkdir(parents=True, exist_ok=True)

    def export_slot(self, job_id: str) -> Path:
        return self.exports_dir / f"{job_id}.json"

    def index_export(self, job_id: str, export_path: Path) -> list[dict]:
        if not export_path.is_file():
            return []
        try:
            with open(export_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("keys", [])
        except Exception:
            return []

    def get_export(self, job_id: str) -> Path | None:
        p = self.exports_dir / f"{job_id}.json"
        return p if p.is_file() else None

    def stats(self) -> dict[str, Any]:
        files = list(self.exports_dir.glob("*.json"))
        return {"exports": len(files), "path": str(self.vault_dir)}

    def export_all(self, target: Path) -> Path:
        all_data = []
        for p in self.exports_dir.glob("*.json"):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    all_data.append(json.load(f))
            except Exception:
                pass
        with open(target, "w", encoding="utf-8") as f:
            json.dump(all_data, f, indent=2)
        return target

    def import_all(self, source: Path) -> int:
        if not source.is_file():
            return 0
        count = 0
        try:
            with open(source, "r", encoding="utf-8") as f:
                items = json.load(f)
            for item in items:
                jid = item.get("job_id", "imported")
                target = self.exports_dir / f"{jid}.json"
                with open(target, "w", encoding="utf-8") as f:
                    json.dump(item, f, indent=2)
                count += 1
        except Exception:
            pass
        return count
''',

    "vibravid/service.py": '''from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from .config import Config
from .engine import EngineError, VibraVidEngine, parse_size
from .jobs import JobStore
from .vault import KeyVault

log = logging.getLogger(__name__)

class BridgeService:
    def __init__(self, cfg: Config, emit: Callable[[str, dict], None] | None = None) -> None:
        self.cfg = cfg
        self.engine = VibraVidEngine(cfg)
        self.store = JobStore(cfg.db_path)
        self.vault = KeyVault(cfg)
        self._emit = emit or (lambda _event, _payload: None)
        self._cancels: dict[str, threading.Event] = {}
        self._pool = ThreadPoolExecutor(max_workers=max(1, cfg.max_concurrent))
        resumed = self.store.reset_interrupted()
        if resumed:
            log.info("requeued %d interrupted job(s)", resumed)

    def _event(self, name: str, payload: dict) -> None:
        self._emit(name, payload)

    def _set(self, job_id: str, **fields: Any) -> None:
        self.store.update(job_id, **fields)
        job = self.store.get(job_id)
        if job:
            self._event("job.updated", job.to_dict())

    def engine_status(self) -> dict:
        return self.engine.health()

    def engine_install(self) -> dict:
        if not (self.cfg.engine_dir / "manual.py").is_file():
            raise EngineError(f"engine not found at {self.cfg.engine_dir}")
        return {"installed": True, "dir": str(self.cfg.engine_dir)}

    def engine_update(self) -> dict:
        result = self.engine.binary_update()
        return {"ok": result.ok, "returncode": result.returncode, "tail": result.stderr.strip()[-1000:]}

    def cdm_status(self) -> dict:
        return self.engine.cdm_status()

    def cdm_validate(self) -> dict:
        status = self.engine.cdm_status()
        status["ok"] = status["available"]
        status["hint"] = "place a .wvd or .prd file in the cdm dir"
        return status

    def resolve(self, payload: dict) -> dict:
        job = self.store.create(
            "resolve",
            url=payload.get("url"),
            service=payload.get("service"),
            search=payload.get("search"),
            season=payload.get("season"),
            episode=payload.get("episode"),
            stream_type=payload.get("stream_type"),
            status="resolving",
            meta={"headers": payload.get("headers", [])},
        )
        self._set(job.id, status="resolving")
        self._resolve_job(job.id, payload)
        return self.store.get(job.id).to_dict()

    def _resolve_job(self, job_id: str, payload: dict) -> None:
        export_path = self.vault.export_slot(job_id)
        try:
            self.engine.resolve(
                export_path=export_path,
                url=payload.get("url") or "",
                stream_type=payload.get("stream_type"),
                keys=payload.get("keys", []),
                license_url=payload.get("license_url"),
                drm=payload.get("drm"),
                license_headers=payload.get("license_headers", []),
                headers=payload.get("headers", []),
                cdm=payload.get("cdm"),
                service=payload.get("service"),
                search=payload.get("search"),
                item=payload.get("item"),
                season=payload.get("season"),
                episode=payload.get("episode"),
            )
            keys = self.vault.index_export(job_id, export_path)
            self._set(job_id, status="done", phase="resolved", export_path=str(export_path), meta={"keys": len(keys)})
        except EngineError as exc:
            self._set(job_id, status="failed", error=str(exc))

    def download_start(self, payload: dict) -> dict:
        export = payload.get("export_path")
        if not export and payload.get("job_id"):
            found = self.vault.get_export(payload["job_id"])
            export = str(found) if found else None

        output = Path(payload["output"]) if payload.get("output") else None
        if output is None:
            name = payload.get("filename") or f"{payload.get('title', 'download')}.mkv"
            output = self.cfg.media_root / name
        output.parent.mkdir(parents=True, exist_ok=True)

        if payload.get("skip_existing", True) and output.is_file() and output.stat().st_size > 0:
            job = self.store.create("download", output=str(output), status="done", phase="skipped", meta={"reason": "already exists"})
            return job.to_dict()

        job = self.store.create(
            "download",
            url=payload.get("url"),
            stream_type=payload.get("stream_type"),
            output=str(output),
            export_path=export,
            status="queued",
            meta={"title": payload.get("title"), "headers": payload.get("headers", []), "keys": payload.get("keys", [])},
        )
        self._pool.submit(self._run_download, job.id)
        return self.store.get(job.id).to_dict()

    def _run_download(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if not job:
            return
        cancel = threading.Event()
        self._cancels[job_id] = cancel
        self._set(job_id, status="running", phase="downloading")

        def on_progress(progress) -> None:
            total = parse_size(progress.total) or 0
            done = parse_size(progress.done) or 0
            self._set(job_id, percent=progress.percent, bytes_done=done, bytes_total=total, speed=progress.speed, eta=progress.eta, phase=f"{progress.kind}:{progress.resolution}")

        def on_line(line: str) -> None:
            if "KID" in line or "key" in line.lower():
                self._event("log", {"job_id": job_id, "line": line})

        cmd = self.engine.build_download(
            export_path=Path(job.export_path) if job.export_path else None,
            url=job.url,
            output=Path(job.output),
            stream_type=job.stream_type,
            keys=job.meta.get("keys", []),
            headers=job.meta.get("headers", []),
        )
        try:
            result = self.engine.run_streaming(cmd, on_progress=on_progress, on_line=on_line, cancel=cancel)
        except Exception as exc:
            self._fail(job_id, str(exc))
            return
        finally:
            self._cancels.pop(job_id, None)

        if cancel.is_set():
            self._set(job_id, status="cancelled", phase="cancelled")
            return
        if not result.ok:
            self._fail(job_id, result.stderr.strip()[-2000:] or "engine failed")
            return

        self._set(job_id, status="done", phase="complete", percent=100)
        self._event("job.completed", {"job_id": job_id, "output": job.output, "title": job.meta.get("title"), "meta": job.meta})

    def _fail(self, job_id: str, error: str) -> None:
        attempts = self.store.bump_attempt(job_id)
        if attempts < self.cfg.max_attempts:
            self._set(job_id, status="queued", phase=f"retry {attempts}", error=error)
            self._pool.submit(self._run_download, job_id)
        else:
            self._set(job_id, status="failed", error=error, phase="failed")

    def job_get(self, job_id: str) -> dict:
        job = self.store.get(job_id)
        if not job: raise KeyError(job_id)
        return job.to_dict()

    def job_list(self, payload: dict) -> list[dict]:
        statuses = payload.get("statuses")
        return [job.to_dict() for job in self.store.list(statuses)]

    def job_cancel(self, job_id: str) -> dict:
        event = self._cancels.get(job_id)
        if event: event.set()
        self._set(job_id, status="cancelled", phase="cancelled")
        return {"cancelled": job_id}

    def job_retry(self, job_id: str) -> dict:
        self._set(job_id, status="queued", error=None, phase="retry")
        self._pool.submit(self._run_download, job_id)
        return {"retried": job_id}

    def job_clear(self, payload: dict) -> dict:
        return {"cleared": self.store.clear_history()}

    def queue_drain(self) -> int:
        pending = self.store.list(["queued"])
        for job in pending:
            self._pool.submit(self._run_download, job.id)
        return len(pending)

    def vault_stats(self) -> dict:
        return self.vault.stats()

    def vault_export(self, target: str | None = None) -> dict:
        path = Path(target) if target else self.cfg.state_dir / "vault-export.json"
        return {"path": str(self.vault.export_all(path))}

    def vault_import(self, source: str) -> dict:
        return {"added": self.vault.import_all(Path(source))}

    def dispatch(self, method: str, payload: dict) -> Any:
        handlers = {
            "engine.status": lambda: self.engine_status(),
            "engine.install": lambda: self.engine_install(),
            "engine.update": lambda: self.engine_update(),
            "cdm.status": lambda: self.cdm_status(),
            "cdm.validate": lambda: self.cdm_validate(),
            "resolve": lambda: self.resolve(payload),
            "download.start": lambda: self.download_start(payload),
            "job.get": lambda: self.job_get(payload["job_id"]),
            "job.list": lambda: self.job_list(payload),
            "job.cancel": lambda: self.job_cancel(payload["job_id"]),
            "job.retry": lambda: self.job_retry(payload["job_id"]),
            "job.clear": lambda: self.job_clear(payload),
            "queue.drain": lambda: self.queue_drain(),
            "vault.stats": lambda: self.vault_stats(),
            "vault.export": lambda: self.vault_export(payload.get("target")),
            "vault.import": lambda: self.vault_import(payload["source"]),
        }
        if method not in handlers:
            raise KeyError(f"unknown method: {method}")
        return handlers[method]()
''',

    "vibravid_bridge.py": '''#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vibravid.config import Config
from vibravid.service import BridgeService

log = logging.getLogger("vibravid.bridge")

def read_message() -> dict | None:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

def write_message(payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def serve_stdio(service: BridgeService) -> None:
    def emit(event: str, payload: dict) -> None:
        write_message({"type": "event", "event": event, "payload": payload})
    service._emit = emit
    while True:
        message = read_message()
        if message is None:
            break
        request_id = message.get("id")
        method = message.get("method", "")
        payload = message.get("payload") or {}
        try:
            result = service.dispatch(method, payload)
            write_message({"id": request_id, "ok": True, "result": result})
        except Exception as exc:
            log.exception("dispatch failed: %s", method)
            write_message({"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"})

def serve_http(service: BridgeService, port: int, token: str, shutdown_event: threading.Event) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _auth(self) -> bool:
            return not token or self.headers.get("X-VibraVid-Token") == token
        def do_POST(self) -> None:
            if not self._auth():
                self.send_response(401)
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            try:
                result = service.dispatch(body.get("method", ""), body.get("payload") or {})
                response = {"ok": True, "result": result}
            except Exception as exc:
                response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            blob = json.dumps(response).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
        def log_message(self, *_args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    log.info("HTTP bridge on 127.0.0.1:%d", port)
    
    def worker():
        server.serve_forever()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    shutdown_event.wait()
    server.shutdown()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--http", action="store_true", help="also serve localhost HTTP")
    parser.add_argument("--port", type=int)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    cfg = Config.load()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        filename=str(cfg.log_path),
    )

    service = BridgeService(cfg)
    shutdown_event = threading.Event()

    if args.http:
        threading.Thread(
            target=serve_http,
            args=(service, args.port or cfg.http_port, cfg.token, shutdown_event),
            daemon=True,
        ).start()

    serve_stdio(service)
    shutdown_event.set()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
''',

    "extension/manifest.json": '''{
  "manifest_version": 3,
  "name": "VibraVid Bridge Extension",
  "version": "1.0.0",
  "permissions": ["nativeMessaging", "storage"],
  "background": { "service_worker": "background.js" },
  "web_accessible_resources": [
    { "resources": ["vibravid.js", "vibravid.css"], "matches": ["<all_urls>"] }
  ]
}
''',

    "extension/background.js": '''importScripts("vibravid.js");
''',

    "extension/vibravid.js": '''const HOST = "ai.vibravid.bridge";
const STORAGE_KEY = "vibravid.jobs";

let port = null;
let seq = 0;
const pending = new Map();

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);

  port.onMessage.addListener((message) => {
    if (message.type === "event") {
      handleEvent(message.event, message.payload);
      return;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      message.ok ? resolver.resolve(message.result) : resolver.reject(new Error(message.error));
    }
  });

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "bridge disconnected";
    for (const [, resolver] of pending) resolver.reject(new Error(error));
    pending.clear();
    port = null;
  });

  return port;
}

export function call(method, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      connect().postMessage({ id, method, payload });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

async function readJobs() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {};
}

async function writeJobs(jobs) {
  await chrome.storage.local.set({ [STORAGE_KEY]: jobs });
}

function handleEvent(event, payload) {
  if (event === "job.updated" || event === "job.completed") {
    readJobs().then((jobs) => {
      jobs[payload.id || payload.job_id] = payload;
      return writeJobs(jobs);
    }).then(() => {
      chrome.runtime.sendMessage({ type: "vibravid:update", event, payload }).catch(() => {});
    });
  }
}

export const VibraVid = {
  status: () => call("engine.status"),
  cdm: () => call("cdm.status"),
  resolve: (payload) => call("resolve", payload),
  download: (payload) => call("download.start", payload),
  jobs: () => call("job.list", {}),
  cancel: (jobId) => call("job.cancel", { job_id: jobId }),
  retry: (jobId) => call("job.retry", { job_id: jobId }),

  async grab(payload) {
    const resolved = await VibraVid.resolve(payload);
    if (resolved.status !== "done") throw new Error(resolved.error || "resolve failed");
    return VibraVid.download({
      job_id: resolved.id,
      export_path: resolved.export_path,
      title: payload.title,
      output: payload.output,
      filename: payload.filename,
    });
  },
};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "vibravid:update" && message.event === "job.completed") {
    const { output, title, meta } = message.payload;
    chrome.runtime.sendMessage({
      type: "library:register",
      entry: { path: output, title: title || output, source: "vibravid", ...meta },
    }).catch(() => {});
  }
});
''',

    "config.toml": '''[engine]
dir = "~/.vibravid-bridge/engine"
python = "python3"
auto_update_binaries = true

[download]
media_root = "~/Videos/VibraVid"
max_concurrent = 2
max_attempts = 3
progress_interval = 2
use_curl_cffi = false

[drm]
cdm = "search"

[bridge]
http_port = 8765
''',

    "ai.vibravid.bridge.json": '''{
  "name": "ai.vibravid.bridge",
  "description": "VibraVid DRM bridge",
  "path": "/ABSOLUTE/PATH/TO/vibravid_bridge.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://YOUR_EXTENSION_ID_HERE/"
  ]
}
'''
}

def main():
    print("🚀 Setting up VibraVid Bridge project files...")
    for filepath, content in FILES.items():
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        print(f"  [CREATED] {filepath}")

    # Make bridge entrypoint executable on Unix systems
    bridge_path = Path("vibravid_bridge.py")
    if bridge_path.is_file() and os.name != "nt":
        os.chmod(bridge_path, 0o755)
        print("  [PERMS] Made vibravid_bridge.py executable (+x)")

    print("\\n✨ Setup complete! Everything is built and ready in your repo.")

if __name__ == "__main__":
    main()