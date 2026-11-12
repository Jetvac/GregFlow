"""First-run setup done from the browser: download the recipe snapshot, remember the
Minecraft folder, find GTNH installations of common launchers.

Downloads go only into the planner's own data/ folder and are checked against the
SHA-256 values pinned in data/datasets.json. Minecraft folders are only listed and read.
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import threading
import urllib.request

from . import install_check

CHUNK = 256 * 1024


def settings_path(data_dir: str) -> str:
    return os.path.join(data_dir, "settings.json")


def load_settings(data_dir: str) -> dict:
    try:
        with open(settings_path(data_dir), encoding="utf-8") as f:
            v = json.load(f)
            return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(data_dir: str, values: dict) -> dict:
    s = load_settings(data_dir)
    s.update(values)
    tmp = settings_path(data_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, settings_path(data_dir))
    return s


def missing_files(data_dir: str) -> list[dict]:
    """Built-in dataset files that are absent or do not match their pinned SHA-256."""
    with open(os.path.join(data_dir, "datasets.json"), encoding="utf-8") as f:
        reg = json.load(f)
    out = []
    for d in reg["datasets"]:
        if d.get("origin") != "builtin":
            continue
        for url_key, file_key, sha_key in (("downloadUrl", "file", "sha256"), ("atlasDownloadUrl", "atlas", "atlasSha256")):
            if not d.get(url_key):
                continue
            dest = os.path.join(data_dir, d[file_key])
            ok = False
            if os.path.isfile(dest):
                h = hashlib.sha256()
                with open(dest, "rb") as f:
                    for b in iter(lambda: f.read(1 << 20), b""):
                        h.update(b)
                ok = h.hexdigest() == d[sha_key]
            if not ok:
                out.append({"dataset": d["id"], "url": d[url_key], "dest": dest, "file": d[file_key], "sha256": d[sha_key]})
    return out


def download(item: dict, progress=None) -> None:
    """Download one file to a temp name, verify SHA-256, then move it in place."""
    req = urllib.request.Request(item["url"], headers={"User-Agent": "gtnh-planner"})
    tmp = item["dest"] + ".part"
    os.makedirs(os.path.dirname(item["dest"]), exist_ok=True)
    h = hashlib.sha256()
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            b = r.read(CHUNK)
            if not b:
                break
            f.write(b); h.update(b); done += len(b)
            if progress:
                progress(done, total)
    if h.hexdigest() != item["sha256"]:
        os.remove(tmp)
        raise ValueError(f"SHA-256 mismatch for {item['file']}: {h.hexdigest()[:12]}… ≠ {item['sha256'][:12]}…")
    os.replace(tmp, item["dest"])


class DataDownload:
    """Background download of the built-in recipe snapshot with progress for the UI."""

    def __init__(self, data_dir: str, on_done):
        self.data_dir = data_dir
        self.on_done = on_done
        self.lock = threading.Lock()
        self.state = {"running": False, "file": None, "index": 0, "count": 0, "done": 0, "total": 0, "error": None, "finished": False}

    def status(self) -> dict:
        with self.lock:
            return dict(self.state)

    def start(self) -> dict:
        with self.lock:
            if self.state["running"]:
                return dict(self.state)
            self.state.update(running=True, error=None, finished=False, done=0, total=0)
        threading.Thread(target=self._run, daemon=True).start()
        return self.status()

    def _run(self):
        try:
            todo = missing_files(self.data_dir)
            with self.lock:
                self.state["count"] = len(todo)
            for i, item in enumerate(todo):
                with self.lock:
                    self.state.update(file=item["file"], index=i + 1, done=0, total=0)

                def prog(done, total):
                    with self.lock:
                        self.state.update(done=done, total=total)
                download(item, prog)
            self.on_done()
            with self.lock:
                self.state.update(running=False, finished=True)
        except Exception as e:  # surfaced to the UI
            with self.lock:
                self.state.update(running=False, error=f"{type(e).__name__}: {e}")


def _candidates() -> list[str]:
    home = os.path.expanduser("~")
    appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    roots = [
        # Prism / PolyMC / MultiMC style launchers: <root>/instances/<name>/(.minecraft|minecraft)
        os.path.join(appdata, "PrismLauncher", "instances"),
        os.path.join(appdata, "PolyMC", "instances"),
        os.path.join(home, ".local", "share", "PrismLauncher", "instances"),
        os.path.join(home, ".local", "share", "PolyMC", "instances"),
        os.path.join(home, ".var", "app", "org.prismlauncher.PrismLauncher", "data", "PrismLauncher", "instances"),
        os.path.join(home, "Library", "Application Support", "PrismLauncher", "instances"),
        os.path.join(home, "MultiMC", "instances"),
        os.path.join(home, "Desktop", "MultiMC", "instances"),
        os.path.join(appdata, "ATLauncher", "instances"),
        os.path.join(home, "curseforge", "minecraft", "Instances"),
        os.path.join(appdata, "gdlauncher_next", "instances"),
        os.path.join(appdata, "com.modrinth.theseus", "profiles"),
    ]
    out = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        for inst in glob.glob(os.path.join(r, "*")):
            for sub in (".minecraft", "minecraft", ""):
                out.append(os.path.join(inst, sub) if sub else inst)
    out += [os.path.join(appdata, ".minecraft"), os.path.join(home, ".minecraft"),
            os.path.join(home, "Library", "Application Support", "minecraft")]
    return out


def find_installs(extra: list[str] | None = None) -> list[dict]:
    """GTNH installations found in common launcher folders (read-only listing)."""
    seen, found = set(), []
    for p in (extra or []) + _candidates():
        if not p:
            continue
        p = os.path.abspath(p)
        if p in seen or not install_check.looks_like_install(p):
            continue
        seen.add(p)
        info = install_check.inspect(p)
        gtnh = bool(info.get("packVersion")) or "gregtech" in info.get("jars", {})
        if gtnh:
            found.append({"path": p, "packVersion": info.get("packVersion"), "gregtech": info.get("jars", {}).get("gregtech", {}).get("version")})
    return found
