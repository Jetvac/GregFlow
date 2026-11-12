"""GregFlow (GTNH production line planner) - local HTTP server (Python stdlib only).

Binds to 127.0.0.1. All writes go to the planner's own data/ and projects/
folders. The Minecraft installation (if any) is only read by install_check.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import catalog as catmod
from . import install_check
from . import lang as langmod
from . import energy as energymod
from . import setup as setupmod

APP_VERSION = "1.1.1"


def _code_stamp() -> tuple:
    """Sizes and times of the server's own .py files: changes when the code on disk is updated."""
    here = os.path.dirname(os.path.abspath(__file__))
    out = []
    for f in sorted(os.listdir(here)):
        if f.endswith(".py"):
            st = os.stat(os.path.join(here, f))
            out.append((f, st.st_size, st.st_mtime_ns))
    return tuple(out)


# taken when the server starts; Python keeps running this code even if the files are replaced
_CODE_AT_START = _code_stamp()
MAX_UPLOAD = 200 * 1024 * 1024
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8"}


def _slug(s: str) -> str:
    # keep Unicode letters (Cyrillic project names); drop path/reserved characters
    s = re.sub(r"[^\w.\- ]+", "-", s, flags=re.UNICODE).strip(" .-")
    s = re.sub(r"\s+", " ", s)[:60]
    return s or "проект"


def _tier(v):
    try:
        return int(v) if v not in (None, "") else None
    except ValueError:
        return None


def custom_passes(r: dict, q: str, side: str, max_tier) -> bool:
    """Same filter semantics as Catalog.filter_recipes, for user recipes."""
    gt = r.get("gt") or {}
    if max_tier is not None and gt.get("tier") is not None and gt["tier"] > max_tier:
        return False
    names = {"in": [], "out": []}
    for key, side_key in (("inputs", "in"), ("outputs", "out")):
        for e in r.get(key, []):
            names[side_key] += [str(e.get("name", "")).lower(), str(e.get("id", "")).lower()]
            names[side_key] += [str(v.get("name", "")).lower() for v in e.get("variants") or []]
    names["any"] = names["in"] + names["out"]
    return all(any(t in n for n in names[s]) for t, s in catmod.Catalog.parse_terms(q, side))


class Planner:
    """Application state: dataset registry, loaded catalog, custom recipes, projects."""

    def __init__(self, root: str, data_dir: str | None = None, projects_dir: str | None = None,
                 mc_dir: str | None = None):
        self.root = root
        self.web_dir = os.path.join(root, "web")
        self.data_dir = data_dir or os.path.join(root, "data")
        self.projects_dir = projects_dir or os.path.join(root, "projects")
        os.makedirs(os.path.join(self.data_dir, "custom"), exist_ok=True)
        os.makedirs(self.projects_dir, exist_ok=True)
        self.lock = threading.RLock()
        self.settings = setupmod.load_settings(self.data_dir)
        if not mc_dir and self.settings.get("mcDir") and install_check.looks_like_install(self.settings["mcDir"]):
            mc_dir = self.settings["mcDir"]
        self.install = install_check.inspect(mc_dir)
        self.downloader = setupmod.DataDownload(self.data_dir, self._after_download)
        try:
            self.missing = setupmod.missing_files(self.data_dir)
        except (OSError, ValueError, KeyError):
            self.missing = []
        self.catalog: catmod.Catalog | None = None
        self.catalog_error: str | None = None
        self.names_status: dict | None = None
        self.energy_data: dict | None = None
        self.custom_path = os.path.join(self.data_dir, "custom", "recipes.json")
        self.custom = self._read_json(self.custom_path, {"format": "gtnh-planner-recipes", "version": 1, "recipes": []})
        self.load_active()

    # ---------------- persistence helpers ----------------
    @staticmethod
    def _read_json(path, default):
        if not os.path.isfile(path):
            return default
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def _write_json(path, obj):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    # ---------------- datasets ----------------
    @property
    def registry_path(self):
        return os.path.join(self.data_dir, "datasets.json")

    def registry(self) -> dict:
        return self._read_json(self.registry_path, {"schemaVersion": 1, "active": None, "datasets": []})

    def dataset_entry(self, did: str | None):
        for d in self.registry()["datasets"]:
            if d["id"] == did:
                return d
        return None

    def load_active(self):
        reg = self.registry()
        entry = self.dataset_entry(reg.get("active"))
        self.catalog = None
        self.catalog_error = None
        if not entry or not entry.get("available"):
            self.catalog_error = "Активный набор данных не выбран или недоступен."
            return
        path = os.path.join(self.data_dir, entry["file"])
        if not os.path.isfile(path):
            self.catalog_error = (f"Файл {entry['file']} не найден — скачайте данные рецептов в окне «Настройка».")
            return
        with open(path, "rb") as f:
            raw = f.read()
        sha = hashlib.sha256(raw).hexdigest()
        if entry.get("sha256") and sha != entry["sha256"]:
            self.catalog_error = (f"Контрольная сумма {entry['file']} не совпадает с зафиксированной "
                                  f"({sha[:12]}… ≠ {entry['sha256'][:12]}…). Данные не загружены.")
            return
        try:
            cat = catmod.Catalog(raw, entry["id"], entry)
        except catmod.CatalogError as e:
            self.catalog_error = str(e)
            return
        counts = entry.get("counts")
        if counts:
            st = cat.stats()
            for k in ("items", "fluids", "recipes"):
                if st[k] != counts[k]:
                    self.catalog_error = f"Число записей {k} = {st[k]}, ожидалось {counts[k]}."
                    return
        self.catalog = cat
        self.attach_names()

    def install_path(self):
        return self.install.get("path") if self.install.get("found") else None

    # ---------------- setup from the UI ----------------
    def _after_download(self):
        with self.lock:
            self.missing = setupmod.missing_files(self.data_dir)
            self.load_active()
            self.energy_data = None

    def set_install(self, path: str) -> dict:
        """Remember a Minecraft folder (read-only use). Empty path forgets it."""
        with self.lock:
            path = (path or "").strip().strip('"')
            if not path:
                self.settings = setupmod.save_settings(self.data_dir, {"mcDir": None})
                self.install = install_check.inspect(None)
            else:
                info = install_check.inspect(path)
                if not info.get("found"):
                    raise ValueError(info.get("reason") or "Папка установки Minecraft не найдена (запустите с --mc-dir).")
                self.install = info
                self.settings = setupmod.save_settings(self.data_dir, {"mcDir": info["path"]})
            self.energy_data = None
            if self.catalog:
                self.attach_names()
            return self.status()

    def save_settings(self, values: dict) -> dict:
        allowed = {k: v for k, v in (values or {}).items() if k in ("welcomed",)}
        with self.lock:
            self.settings = setupmod.save_settings(self.data_dir, allowed)
        return self.settings

    def attach_names(self):
        """Russian names (best effort: the planner works without them)."""
        try:
            n = langmod.Names(self.data_dir, self.install_path()).build(self.catalog)
            self.catalog.attach_names(n.goods, n.machines)
            self.names_status = n.status()
        except Exception as e:  # pragma: no cover
            self.names_status = {"error": repr(e)}

    def fetch_lang(self):
        with self.lock:
            langmod.fetch_translations(self.data_dir, log=lambda *_: None)
            if self.catalog:
                self.attach_names()
            return self.names_status

    def machine_slots(self) -> dict:
        """Item slot counts of GT single-block machines (data/gt-machine-slots.json, from the GT source)."""
        if getattr(self, "_machine_slots", None) is None:
            path = os.path.join(self.root, "data", "gt-machine-slots.json")
            try:
                with open(path, encoding="utf-8") as f:
                    self._machine_slots = json.load(f)
            except (OSError, ValueError):
                self._machine_slots = {"machines": {}}
        return self._machine_slots

    def energy(self) -> dict:
        if self.energy_data is None:
            self.energy_data = energymod.load(self.data_dir, self.install_path(), self.catalog)
        return self.energy_data

    def activate(self, did: str):
        with self.lock:
            reg = self.registry()
            e = self.dataset_entry(did)
            if not e or not e.get("available"):
                raise ValueError("Набор данных недоступен: " + did)
            reg["active"] = did
            self._write_json(self.registry_path, reg)
            self.load_active()

    def import_dataset(self, raw: bytes, label: str, pack_version: str) -> dict:
        try:
            cat = catmod.Catalog(raw, "probe")
        except catmod.CatalogError as e:
            raise ValueError(str(e))
        except Exception as e:  # malformed file
            raise ValueError("Файл не распознан как data.bin GTNH Calculator: " + str(e))
        sha = hashlib.sha256(raw).hexdigest()
        did = "user-" + _slug(pack_version or "x") + "-" + sha[:8]
        folder = os.path.join(self.data_dir, "datasets", did)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "data.bin"), "wb") as f:
            f.write(raw)
        st = cat.stats()
        entry = {
            "id": did, "label": label or f"Импорт {pack_version}", "packVersion": pack_version or None,
            "available": True, "verified": False, "origin": "user-import", "format": st["format"],
            "file": f"datasets/{did}/data.bin", "atlas": None, "sha256": sha,
            "uncompressedSha256": st["uncompressedSha256"],
            "counts": {"items": st["items"], "fluids": st["fluids"], "recipes": st["recipes"]},
            "importedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "verification": "Импортирован пользователем; происхождение не проверено планировщиком.",
        }
        with self.lock:
            reg = self.registry()
            reg["datasets"] = [d for d in reg["datasets"] if d["id"] != did] + [entry]
            self._write_json(self.registry_path, reg)
        return entry

    def import_atlas(self, did: str, raw: bytes):
        if raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
            raise ValueError("Атлас должен быть файлом WebP (atlas.webp).")
        with self.lock:
            reg = self.registry()
            for d in reg["datasets"]:
                if d["id"] == did and d.get("origin") == "user-import":
                    folder = os.path.join(self.data_dir, "datasets", did)
                    with open(os.path.join(folder, "atlas.webp"), "wb") as f:
                        f.write(raw)
                    d["atlas"] = f"datasets/{did}/atlas.webp"
                    d["atlasSha256"] = hashlib.sha256(raw).hexdigest()
                    self._write_json(self.registry_path, reg)
                    return d
        raise ValueError("Атлас можно добавить только к импортированному набору.")

    def status(self) -> dict:
        reg = self.registry()
        active = self.dataset_entry(reg.get("active"))
        return {
            "app": APP_VERSION,
            "stale": _code_stamp() != _CODE_AT_START,
            "datasets": reg["datasets"],
            "active": active,
            "catalog": self.catalog.stats() if self.catalog else None,
            "catalogError": self.catalog_error,
            "install": self.install,
            "customRecipes": len(self.custom["recipes"]),
            "names": self.names_status,
            "setup": {"missing": [m["file"] for m in self.missing], "download": self.downloader.status(),
                      "welcomed": bool(self.settings.get("welcomed")), "mcDirSaved": self.settings.get("mcDir")},
        }

    # ---------------- recipes ----------------
    def need_catalog(self) -> catmod.Catalog:
        if not self.catalog:
            raise LookupError(self.catalog_error or "Каталог не загружен")
        return self.catalog

    def recipe(self, rid: str):
        if rid.startswith("c~"):
            for r in self.custom["recipes"]:
                if r["id"] == rid:
                    return r
            return None
        return self.need_catalog().recipe(rid)

    def custom_matching(self, gid: str, mode: str) -> list:
        key = "outputs" if mode == "production" else "inputs"
        out = []
        for r in self.custom["recipes"]:
            for e in r.get(key, []):
                if e.get("id") == gid or any(v.get("id") == gid for v in e.get("variants", []) or []):
                    out.append(r)
                    break
        return out

    def validate_custom(self, r: dict) -> dict:
        if not isinstance(r, dict):
            raise ValueError("Рецепт должен быть объектом")
        machine = (r.get("machine") or {}).get("name")
        if not machine:
            raise ValueError("Не указана машина / карта рецептов")
        clean = {"id": r.get("id") if str(r.get("id", "")).startswith("c~") else "c~" + uuid.uuid4().hex[:12],
                 "dataset": "custom", "machine": {"name": str(machine)},
                 "targetPackVersion": r.get("targetPackVersion") or None,
                 "source": r.get("source") or {"type": "manual"},
                 "note": r.get("note") or "", "inputs": [], "outputs": [], "warnings": []}
        cat = self.catalog
        for key in ("inputs", "outputs"):
            for e in r.get(key, []) or []:
                kind = e.get("kind")
                if kind not in ("item", "fluid", "oredict"):
                    raise ValueError(f"Неверный тип ресурса: {kind}")
                if kind == "oredict" and key == "outputs":
                    raise ValueError("Выход не может быть словарём руд")
                gid = str(e.get("id") or "")
                if not gid:
                    raise ValueError("У ресурса нет ID")
                amount = e.get("amount")
                if not isinstance(amount, (int, float)) or amount < 0:
                    raise ValueError(f"Неверное количество у {gid}")
                prob = e.get("probability", 1)
                if not isinstance(prob, (int, float)) or not 0 < prob <= 1:
                    raise ValueError(f"Вероятность у {gid} должна быть в (0, 1]")
                item = {"kind": kind, "id": gid, "name": e.get("name") or gid, "icon": e.get("icon", -1),
                        "amount": amount, "probability": prob}
                if key == "inputs":
                    item["consumed"] = bool(e.get("consumed", amount > 0))
                if kind == "oredict":
                    item["variants"] = e.get("variants") or []
                if cat and cat.pos.get(gid) is None:
                    clean["warnings"].append(f"{gid} отсутствует в активном наборе {cat.dataset_id}")
                clean[key].append(item)
        gt = r.get("gt")
        if gt:
            def num(k, integer=False):
                v = gt.get(k)
                if v is None or v == "":
                    return None
                if not isinstance(v, (int, float)) or v < 0:
                    raise ValueError(f"Неверное значение {k}")
                return int(v) if integer else v
            ticks = num("durationTicks", True)
            if ticks is not None and ticks <= 0:
                raise ValueError("Длительность должна быть > 0 тиков")
            eut = num("eut")
            clean["gt"] = {"durationTicks": ticks, "eut": eut, "voltage": num("voltage"),
                           "amperage": num("amperage"), "tier": gt.get("tier"),
                           "tierName": gt.get("tierName"), "specialValue": gt.get("specialValue"),
                           "metadata": gt.get("metadata") or []}
        else:
            clean["gt"] = None
        clean["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        return clean

    def save_custom(self, r: dict) -> dict:
        clean = self.validate_custom(r)
        with self.lock:
            rs = [x for x in self.custom["recipes"] if x["id"] != clean["id"]]
            old = next((x for x in self.custom["recipes"] if x["id"] == clean["id"]), None)
            if old and "createdAt" in old:
                clean["createdAt"] = old["createdAt"]
            else:
                clean.setdefault("createdAt", clean["updatedAt"])
            rs.append(clean)
            self.custom["recipes"] = rs
            self._write_json(self.custom_path, self.custom)
        return clean

    def delete_custom(self, rid: str):
        with self.lock:
            self.custom["recipes"] = [x for x in self.custom["recipes"] if x["id"] != rid]
            self._write_json(self.custom_path, self.custom)

    def import_custom(self, obj: dict) -> dict:
        if not isinstance(obj, dict) or obj.get("format") != "gtnh-planner-recipes":
            raise ValueError("Ожидается файл формата gtnh-planner-recipes")
        added, errors = 0, []
        for i, r in enumerate(obj.get("recipes", [])):
            try:
                r = dict(r)
                src = r.get("source") or {"type": "file-import"}
                r["source"] = src
                self.save_custom(r)
                added += 1
            except ValueError as e:
                errors.append(f"#{i + 1}: {e}")
        return {"added": added, "errors": errors}

    # ---------------- projects ----------------
    def project_path(self, name: str) -> str:
        return os.path.join(self.projects_dir, _slug(name) + ".json")

    def list_projects(self):
        out = []
        for e in sorted(os.scandir(self.projects_dir), key=lambda e: -e.stat().st_mtime):
            if e.name.endswith(".json"):
                try:
                    with open(e.path, "r", encoding="utf-8") as f:
                        p = json.load(f)
                    out.append({"file": e.name[:-5], "name": p.get("name"), "demo": bool(p.get("demo")),
                                "nodes": len(p.get("nodes", [])),
                                "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(e.stat().st_mtime))})
                except (OSError, ValueError):
                    continue
        return out


# ====================================================================
class Handler(BaseHTTPRequestHandler):
    planner: Planner = None  # set by make_server
    server_version = "GregFlow/" + APP_VERSION

    def log_message(self, fmt, *args):  # quieter console
        if os.environ.get("GREGFLOW_VERBOSE") or os.environ.get("GTNH_PLANNER_VERBOSE"):
            super().log_message(fmt, *args)

    # ---- helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("Файл слишком большой")
        return self.rfile.read(n) if n else b""

    def json_body(self):
        return json.loads(self.body().decode("utf-8") or "null")

    def send_file(self, path):
        if not os.path.isfile(path):
            return self.error("Не найдено", 404)
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _check_origin(self):
        # Reject cross-site writes: only same-origin pages may modify local data.
        origin = self.headers.get("Origin")
        if origin and not re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            raise PermissionError("Запрос с чужого источника отклонён")

    # ---- dispatch ----
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path
        P = self.planner
        try:
            if method != "GET":
                self._check_origin()
            if path.startswith("/api/"):
                return self.api(method, path[5:], q)
            if method != "GET":
                return self.error("Метод не поддерживается", 405)
            if path.startswith("/atlas/"):
                e = P.dataset_entry(path[7:].removesuffix(".webp"))
                if not e or not e.get("atlas"):
                    return self.error("Атлас не найден", 404)
                return self.send_file(os.path.join(P.data_dir, e["atlas"]))
            if path in ("/", ""):
                path = "/index.html"
            if path.startswith("/docs/"):
                full = os.path.normpath(os.path.join(P.root, path.lstrip("/")))
                if not full.startswith(os.path.join(P.root, "docs")):
                    return self.error("Запрещено", 403)
                return self.send_file(full)
            full = os.path.normpath(os.path.join(P.web_dir, path.lstrip("/")))
            if not full.startswith(P.web_dir):
                return self.error("Запрещено", 403)
            return self.send_file(full)
        except PermissionError as e:
            return self.error(str(e), 403)
        except LookupError as e:
            return self.error(str(e), 503)
        except ValueError as e:
            return self.error(str(e), 400)
        except Exception as e:  # pragma: no cover - surfaced to UI
            import traceback
            traceback.print_exc()
            return self.error("Внутренняя ошибка: " + repr(e), 500)

    def api(self, method, route, q):
        P = self.planner
        if route == "status" and method == "GET":
            return self.send_json(P.status())
        if route == "search" and method == "GET":
            cat = P.need_catalog()
            text = q.get("q", "")
            if q.get("type") == "machine":
                return self.send_json({"machines": cat.search_machines(text)})
            res = cat.search(text, int(q.get("limit", 60)))
            if text.startswith(("i:", "f:", "o:")) and P.catalog.pos.get(text) is not None:
                g = cat.goods(text)
                if g and g["kind"] != "oredict":
                    res.insert(0, g)
            return self.send_json({"goods": res})
        if route == "names" and method == "POST":
            cat = P.need_catalog()
            ids = (self.json_body() or {}).get("ids", [])[:5000]
            out = {}
            for gid in ids:
                p = cat.pos.get(gid)
                if p is not None and p in cat.names_ru:
                    out[gid] = cat.names_ru[p]
            return self.send_json({"goods": out, "machines": cat.machines_ru})
        if route == "setup/download" and method == "POST":
            return self.send_json(P.downloader.start())
        if route == "setup/progress" and method == "GET":
            return self.send_json(P.downloader.status())
        if route == "setup/installs" and method == "GET":
            return self.send_json({"installs": setupmod.find_installs([P.install_path()] if P.install_path() else None)})
        if route == "setup/mcdir" and method == "POST":
            return self.send_json(P.set_install((self.json_body() or {}).get("path", "")))
        if route == "setup/settings" and method == "POST":
            return self.send_json(P.save_settings(self.json_body() or {}))
        if route == "lang/fetch" and method == "POST":
            return self.send_json(P.fetch_lang())
        if route == "machineslots" and method == "GET":
            return self.send_json(P.machine_slots())
        if route == "energy" and method == "GET":
            return self.send_json(P.energy())
        if route == "energy/fuels" and method == "GET":
            return self.send_json({"fuels": energymod.fuels(P.need_catalog(), q.get("map", ""))})
        if route == "goods" and method == "GET":
            g = P.need_catalog().goods(q.get("id", ""))
            if g is None:
                return self.error("Ресурс не найден в активном наборе", 404)
            return self.send_json(g)
        if route == "recipes" and method == "GET":
            mode = q.get("mode", "production")
            machine = q.get("machine") or None
            off, lim = int(q.get("offset", 0)), int(q.get("limit", 30))
            gid = q.get("id", "")
            text, side, max_tier = q.get("q", ""), q.get("side", "any"), _tier(q.get("maxTier"))
            custom = [r for r in P.custom_matching(gid, mode)
                      if (not machine or r["machine"]["name"] == machine) and custom_passes(r, text, side, max_tier)]
            res = P.need_catalog().recipes_for(gid, mode, machine, off, lim, text, side, max_tier)
            res["custom"] = custom
            return self.send_json(res)
        if route == "machine" and method == "GET":
            return self.send_json(P.need_catalog().recipes_of_machine(
                q.get("name", ""), int(q.get("offset", 0)), int(q.get("limit", 30)), q.get("q", ""),
                q.get("side", "any"), _tier(q.get("maxTier"))))
        if route == "recipe" and method == "GET":
            r = P.recipe(q.get("id", ""))
            if r is None:
                return self.error("Рецепт не найден", 404)
            return self.send_json(r)
        if route == "custom":
            if method == "GET":
                return self.send_json(P.custom)
            if method == "POST":
                return self.send_json(P.save_custom(self.json_body()))
            if method == "DELETE":
                P.delete_custom(q.get("id", ""))
                return self.send_json({"ok": True})
        if route == "custom/import" and method == "POST":
            return self.send_json(P.import_custom(self.json_body()))
        if route == "datasets/import" and method == "POST":
            return self.send_json(P.import_dataset(self.body(), q.get("label", ""), q.get("packVersion", "")))
        if route == "datasets/atlas" and method == "POST":
            return self.send_json(P.import_atlas(q.get("id", ""), self.body()))
        if route == "datasets/activate" and method == "POST":
            P.activate(q.get("id", ""))
            return self.send_json(P.status())
        if route == "projects" and method == "GET":
            return self.send_json({"projects": P.list_projects()})
        if route == "project":
            path = P.project_path(q.get("file", ""))
            if method == "GET":
                if not os.path.isfile(path):
                    return self.error("Проект не найден", 404)
                with open(path, "r", encoding="utf-8") as f:
                    return self.send_json(json.load(f))
            if method == "POST":
                proj = self.json_body()
                if not isinstance(proj, dict) or proj.get("format") != "gtnh-planner-project":
                    raise ValueError("Неверный формат проекта")
                path = P.project_path(proj.get("name") or "проект")
                proj["savedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                P._write_json(path, proj)
                return self.send_json({"ok": True, "file": os.path.basename(path)[:-5]})
            if method == "DELETE":
                if os.path.isfile(path):
                    os.remove(path)
                return self.send_json({"ok": True})
        return self.error("Неизвестный запрос: " + route, 404)


def make_server(planner: Planner, host="127.0.0.1", port=8765) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"planner": planner})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    return srv
