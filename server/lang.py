"""Russian item/fluid/machine names.

Sources (later ones override earlier ones, as in the game):
  1. ru_RU.lang inside the mod jars of the Minecraft installation (read-only);
  2. GTNH-Translations (GPL-3.0, https://github.com/GTNewHorizons/GTNH-Translations),
     downloaded into data/lang/ru_RU with a manifest (commit + SHA-256 per file):
       GregTech_ru_RU.lang                      - GregTech materials (Material.*)
       config/txloader/load/*/lang/ru_RU.lang   - mod translations
       config/txloader/forceload/*/lang/ru_RU.lang

GregTech material items have no fixed translated name: the game builds it from a
prefix template (GregTech.lang "gt.metaitem.01.2018.name=%material Dust") and
the translated material. We do the same: the English template comes from the
installation's GregTech.lang, the Russian template from gt.oreprefix.<key> and
the Russian material from Material.<name>. Nothing is invented - if a part is
missing, no Russian name is produced and the English one is used.
"""
from __future__ import annotations

import concurrent.futures
import glob
import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request
import zipfile

REPO = "GTNewHorizons/GTNH-Translations"
LICENSE = "GPL-3.0"
FMT = re.compile(r"§.")
CFG_LINE = re.compile(r"^\s*S:([^=]+)=(.*)$")
INDEX_VERSION = 3


def clean(s: str) -> str:
    return FMT.sub("", s).strip()


def norm(s: str) -> str:
    return (s or "").lower().replace("ё", "е")


def parse_lang(text: str) -> dict:
    out = {}
    for line in text.lstrip("﻿").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v
    return out


def parse_cfg(text: str) -> dict:
    out = {}
    for line in text.lstrip("﻿").splitlines():
        m = CFG_LINE.match(line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _read(path):
    with open(path, "rb") as f:
        return f.read().decode("utf-8", "replace")


# ---------------------------------------------------------------- fetch
def _get(url, timeout=60, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": "GregFlow"})
    for i in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=timeout).read()
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(1 + i * 2)


def fetch_translations(data_dir: str, ref: str = "master", log=print) -> dict:
    """Download the Russian files of GTNH-Translations at a fixed commit."""
    commit = json.loads(_get(f"https://api.github.com/repos/{REPO}/commits/{ref}"))["sha"]
    tree = json.loads(_get(f"https://api.github.com/repos/{REPO}/git/trees/{commit}?recursive=1"))["tree"]
    want = [e for e in tree if e["type"] == "blob" and (
        e["path"] == "ru_RU/GregTech_ru_RU.lang" or
        re.match(r"^ru_RU/config/txloader/(load|forceload)/[^/]+/lang/ru_RU\.lang$", e["path"]))
        and "betterquesting" not in e["path"]]
    base = os.path.join(data_dir, "lang", "ru_RU")
    tmp = base + ".tmp"
    os.makedirs(tmp, exist_ok=True)
    files = {}

    def one(e):
        rel = e["path"][len("ru_RU/"):]
        url = f"https://raw.githubusercontent.com/{REPO}/{commit}/" + urllib.parse.quote(e["path"])
        raw = _get(url)
        if len(raw) != e["size"]:
            raise IOError(f"{rel}: размер {len(raw)} ≠ {e['size']}")
        dest = os.path.join(tmp, *rel.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(raw)
        return rel, {"sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw), "gitBlob": e["sha"]}

    log(f"[..] {REPO}@{commit[:10]}: {len(want)} файлов")
    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        for rel, info in ex.map(one, want):
            files[rel] = info
    manifest = {"repo": REPO, "commit": commit, "ref": ref, "license": LICENSE,
                "source": f"https://github.com/{REPO}/tree/{commit}/ru_RU",
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files}
    with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    if os.path.isdir(base):
        import shutil
        shutil.rmtree(base)
    os.replace(tmp, base)
    log(f"[ok] сохранено в {base}")
    return manifest


def verify_translations(data_dir: str) -> dict | None:
    base = os.path.join(data_dir, "lang", "ru_RU")
    mp = os.path.join(base, "manifest.json")
    if not os.path.isfile(mp):
        return None
    m = json.loads(_read(mp))
    bad = []
    for rel, info in m["files"].items():
        p = os.path.join(base, *rel.split("/"))
        if not os.path.isfile(p) or hashlib.sha256(open(p, "rb").read()).hexdigest() != info["sha256"]:
            bad.append(rel)
    m["verified"] = not bad
    m["badFiles"] = bad
    return m


# ---------------------------------------------------------------- names
class Names:
    """Russian names for a catalog. Built once, cached in data/lang/."""

    def __init__(self, data_dir: str, install_path: str | None):
        self.data_dir = data_dir
        self.install = install_path
        self.ru: dict[str, str] = {}
        self.en_gt: dict[str, str] = {}      # GregTech.lang of the installation (English)
        self.en_jar: dict[str, str] = {}     # gregtech jar en_US.lang (recipe map names)
        self.sources: list[dict] = []
        self.manifest = verify_translations(data_dir)
        self.goods: dict[str, str] = {}      # goods id -> Russian name
        self.machines: dict[str, str] = {}   # English recipe-map name -> Russian
        self.stats = {}

    # -- sources --
    def _signature(self) -> str:
        h = hashlib.sha256(str(INDEX_VERSION).encode())
        if self.install:
            for p in sorted(glob.glob(os.path.join(self.install, "mods", "*.jar"))) + \
                    [os.path.join(self.install, "GregTech.lang")]:
                if os.path.isfile(p):
                    st = os.stat(p)
                    h.update(f"{os.path.basename(p)}:{st.st_size}:{int(st.st_mtime)}".encode())
        if self.manifest:
            h.update((self.manifest["commit"] + str(self.manifest["verified"])).encode())
        return h.hexdigest()

    def load_sources(self):
        ru = {}
        if self.install:
            n = 0
            for jar in sorted(glob.glob(os.path.join(self.install, "mods", "*.jar"))):
                try:
                    with zipfile.ZipFile(jar) as z:  # read-only
                        for name in z.namelist():
                            if name.endswith("/lang/ru_RU.lang"):
                                ru.update(parse_lang(z.read(name).decode("utf-8", "replace")))
                                n += 1
                            elif "gregtech" in os.path.basename(jar).lower() and name == "assets/gregtech/lang/en_US.lang":
                                self.en_jar = parse_lang(z.read(name).decode("utf-8", "replace"))
                except (zipfile.BadZipFile, OSError):
                    continue
            if n:
                self.sources.append({"name": "ru_RU.lang из модов установки (только чтение)", "files": n})
            gl = os.path.join(self.install, "GregTech.lang")
            if os.path.isfile(gl):
                self.en_gt = parse_cfg(_read(gl))
                self.sources.append({"name": "GregTech.lang установки (английские шаблоны)", "files": 1})
        if self.manifest and self.manifest.get("verified"):
            base = os.path.join(self.data_dir, "lang", "ru_RU")
            gp = os.path.join(base, "GregTech_ru_RU.lang")
            if os.path.isfile(gp):
                ru.update(parse_cfg(_read(gp)))
            for sub in ("load", "forceload"):
                for p in sorted(glob.glob(os.path.join(base, "config", "txloader", sub, "*", "lang", "ru_RU.lang"))):
                    ru.update(parse_lang(_read(p)))
            self.sources.append({"name": f"GTNH-Translations @ {self.manifest['commit'][:10]} ({LICENSE})",
                                 "files": len(self.manifest["files"]), "source": self.manifest["source"]})
        self.ru = {k: clean(v) for k, v in ru.items() if v.strip()}

    # -- build --
    def build(self, cat) -> "Names":
        cache = os.path.join(self.data_dir, "lang", f"names-{cat.dataset_id}-ru.json")
        sig = self._signature() + cat.compressed_sha256
        try:
            c = json.loads(_read(cache))
            if c.get("signature") == sig:
                self.goods, self.machines = c["goods"], c["machines"]
                self.sources, self.stats = c["sources"], c["stats"]
                return self
        except (OSError, ValueError, KeyError):
            pass
        self.load_sources()
        ru, en = self.ru, self.en_gt
        # English material display name -> Russian material name
        mat = {}
        for k, v in en.items():
            if k.startswith("Material.") and k.count(".") == 1 and k in ru:
                mat.setdefault(v.lower(), ru[k])
        # Russian prefix templates by normalized English template
        pre = {k[len("gt.oreprefix."):]: v for k, v in ru.items() if k.startswith("gt.oreprefix.")}
        # fallback decomposition: "molten_material" -> ^molten (.+)$
        pre_rx = []
        for key, tmpl in pre.items():
            parts = key.split("material")
            if len(parts) != 2:
                continue
            rx = re.compile("^" + re.escape(parts[0].replace("_", " ")) + "(.+?)" +
                            re.escape(parts[1].replace("_", " ")) + "$")
            pre_rx.append((len(key), rx, tmpl))
        pre_rx.sort(key=lambda t: -t[0])

        def compose(tmpl_en: str, english: str):
            rx = "^" + re.escape(tmpl_en).replace(re.escape("%material"), "(.+?)") + "$"
            m = re.match(rx, english)
            if not m:
                return None
            rm = mat.get(m.group(1).lower())
            if not rm:
                return None
            if tmpl_en.strip() == "%material":
                return rm
            t = pre.get(tmpl_en.lower().replace("%material", "material").replace(" ", "_"))
            return t.replace("%s", rm) if t and "%s" in t else None

        st = {"direct": 0, "template": 0, "material": 0, "missing": 0}
        el = cat.el
        for kind, group in (("item", cat.items), ("fluid", cat.fluids)):
            for p in group:
                gid = cat.string(el[p + 4])
                english = cat.string(el[p + 5]) or ""
                u = cat.string(el[p + 11]) or ""
                name = None
                for key in (u + ".name", u):
                    if key in ru:
                        name, how = ru[key], "direct"
                        break
                if name is None:
                    t = en.get(u + ".name") or en.get(u)
                    if t and "%material" in t:
                        name, how = compose(t, english), "template"
                if name is None and english.lower() in mat and (u.startswith(("gt.", "fluid.")) or kind == "fluid"):
                    name, how = mat[english.lower()], "material"
                if name is None and (u.startswith(("gt.", "fluid.")) or kind == "fluid"):
                    low = english.lower()
                    for _, rx, tmpl in pre_rx:
                        m = rx.match(low)
                        if m and m.group(1) in mat and "%s" in tmpl:
                            name, how = tmpl.replace("%s", mat[m.group(1)]), "template"
                            break
                if name and name != english:
                    self.goods[gid] = name
                    st[how] += 1
                else:
                    st["missing"] += 1
        # recipe maps: gt.recipe.<x> English (jar) -> Russian
        for k, v in self.en_jar.items():
            if k.startswith("gt.recipe.") and k in ru and k.count(".") == 2:
                self.machines.setdefault(v, ru[k])
        rev = {}
        for k, v in list(self.en_jar.items()) + list(en.items()):
            if k in ru and not k.endswith(".tooltip"):
                rev.setdefault(v, ru[k])
        for tp, name in cat.type_names.items():
            if name and name not in self.machines and name in rev:
                self.machines[name] = rev[name]
        self.stats = st
        try:
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(cache, "w", encoding="utf-8") as f:
                json.dump({"signature": sig, "goods": self.goods, "machines": self.machines,
                           "sources": self.sources, "stats": st}, f, ensure_ascii=False)
        except OSError:
            pass
        return self

    def status(self) -> dict:
        return {"sources": self.sources, "stats": self.stats, "goods": len(self.goods),
                "machines": len(self.machines),
                "translations": ({k: self.manifest[k] for k in ("repo", "commit", "license", "source", "fetchedAt", "verified")}
                                 if self.manifest else None)}
