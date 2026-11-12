"""Read-only inspection of a Minecraft/GTNH installation.

Only opens files for reading (mode "r"/"rb") and lists directories. Never
writes, renames or locks anything inside the installation folder.
"""
from __future__ import annotations

import os
import re

PACK_CFG = os.path.join("config", "GTNewHorizons", "dreamcraft.cfg")
KEY_JARS = {
    "gregtech": re.compile(r"^gregtech-([\d.]+)\.jar$", re.I),
    "coremod": re.compile(r"^GTNewHorizonsCoreMod-([\d.]+)\.jar$", re.I),
    "nei": re.compile(r"^NotEnoughItems-([\w.\-]+)\.jar$", re.I),
}


def looks_like_install(path: str) -> bool:
    return os.path.isdir(os.path.join(path, "mods")) and os.path.isdir(os.path.join(path, "config"))


def find_install(start: str, max_up: int = 4) -> str | None:
    p = os.path.abspath(start)
    for _ in range(max_up + 1):
        if looks_like_install(p):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    return None


def inspect(path: str | None) -> dict:
    if not path:
        return {"found": False, "reason": "Папка установки Minecraft не найдена (запустите с --mc-dir)."}
    path = os.path.abspath(path)
    if not looks_like_install(path):
        return {"found": False, "path": path, "reason": "В папке нет mods/ и config/."}
    info = {"found": True, "path": path, "readOnly": True, "packVersion": None,
            "packVersionSource": None, "jars": {}, "modCount": 0}
    cfg = os.path.join(path, PACK_CFG)
    if os.path.isfile(cfg):
        with open(cfg, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = re.match(r"\s*S:ModPackVersion=(\S+)", line)
                if m:
                    info["packVersion"] = m.group(1)
                    info["packVersionSource"] = PACK_CFG.replace(os.sep, "/") + " (S:ModPackVersion)"
                    break
    try:
        jars = [e.name for e in os.scandir(os.path.join(path, "mods")) if e.is_file() and e.name.endswith(".jar")]
    except OSError:
        jars = []
    info["modCount"] = len(jars)
    for key, rx in KEY_JARS.items():
        for name in jars:
            m = rx.match(name)
            if m:
                info["jars"][key] = {"file": name, "version": m.group(1)}
    nesql = os.path.join(path, "nesql")
    info["nesqlExport"] = os.path.isdir(nesql)
    return info
