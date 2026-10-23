"""Native messaging host for the Udemy Downloader Bridge extension.

Why this exists: a Chrome/Brave extension can only write beneath the browser's
download folder. chrome.downloads does the downloading (background, no tab),
then this host moves the finished tree anywhere on disk.

Deliberately does NOT move file bytes over the pipe. Native messaging is a
length-prefixed JSON channel; shipping a 300 MB video through it as base64
would be absurd. It receives paths and does filesystem work.

Protocol: each message is a 4-byte little-endian length followed by UTF-8 JSON.
Operations:
  {"op": "ping"}
  {"op": "list",  "path": "A:/"}                 -> subdirectories
  {"op": "mkdir", "path": "A:/Courses/New"}
  {"op": "move",  "from": "...", "to": "..."}     -> merge-move a tree
"""

import json
import os
import shutil
import struct
import sys

VERSION = "1.0.0"

# Refuse to touch locations where a buggy caller could do real damage.
BLOCKED = [
    os.environ.get("SystemRoot", r"C:\Windows"),
    os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), ""),
    os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), ""),
    os.environ.get("ProgramData", r"C:\ProgramData"),
]


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    size = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(size)
    return json.loads(data.decode("utf-8"))


def send_message(payload):
    data = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def normalise(path):
    if not path:
        raise ValueError("path is required")
    full = os.path.abspath(os.path.normpath(str(path).replace("/", os.sep)))
    if not os.path.splitdrive(full)[0]:
        raise ValueError("path must be absolute, e.g. A:/Courses")
    lowered = full.lower()
    for blocked in BLOCKED:
        if blocked and lowered.startswith(str(blocked).lower().rstrip(os.sep) + os.sep):
            raise ValueError(f"refusing to touch a system location: {full}")
    return full


def op_list(msg):
    full = normalise(msg.get("path"))
    if not os.path.isdir(full):
        raise ValueError(f"not a directory: {full}")
    dirs = []
    with os.scandir(full) as it:
        for entry in it:
            try:
                if entry.is_dir() and not entry.name.startswith("$"):
                    dirs.append(entry.name)
            except OSError:
                continue
    parent = os.path.dirname(full.rstrip(os.sep))
    return {
        "path": full,
        "parent": None if parent == full else parent,
        "dirs": sorted(dirs, key=str.lower),
        "writable": os.access(full, os.W_OK),
    }


def op_drives():
    out = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        root = f"{letter}:\\"
        if os.path.isdir(root):
            try:
                usage = shutil.disk_usage(root)
                out.append({"path": root, "free": usage.free, "total": usage.total})
            except OSError:
                out.append({"path": root, "free": None, "total": None})
    return {"drives": out}


def op_mkdir(msg):
    full = normalise(msg.get("path"))
    os.makedirs(full, exist_ok=True)
    return {"path": full}


def merge_move(src, dst):
    """Move src into dst, merging into existing folders and replacing files."""
    moved = 0
    if os.path.isfile(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.move(src, dst)
        return 1

    os.makedirs(dst, exist_ok=True)
    for name in os.listdir(src):
        moved += merge_move(os.path.join(src, name), os.path.join(dst, name))
    try:
        os.rmdir(src)
    except OSError:
        pass  # not empty because something failed; leave it for inspection
    return moved


def op_move(msg):
    src = normalise(msg.get("from"))
    dst = normalise(msg.get("to"))
    if not os.path.exists(src):
        raise ValueError(f"source does not exist: {src}")
    if dst == src or dst.lower().startswith(src.lower() + os.sep):
        raise ValueError("destination is inside the source")
    moved = merge_move(src, dst)
    return {"moved": moved, "from": src, "to": dst}


HANDLERS = {
    "ping": lambda msg: {"version": VERSION, "python": sys.version.split()[0]},
    "list": op_list,
    "drives": lambda msg: op_drives(),
    "mkdir": op_mkdir,
    "move": op_move,
}


def main():
    while True:
        try:
            msg = read_message()
        except Exception as exc:
            send_message({"ok": False, "error": f"bad message: {exc}"})
            return
        if msg is None:
            return  # browser closed the pipe

        op = msg.get("op")
        handler = HANDLERS.get(op)
        if not handler:
            send_message({"ok": False, "id": msg.get("id"), "error": f"unknown op: {op}"})
            continue
        try:
            result = handler(msg)
            send_message({"ok": True, "id": msg.get("id"), **result})
        except Exception as exc:
            send_message({"ok": False, "id": msg.get("id"), "error": str(exc)})


if __name__ == "__main__":
    main()
