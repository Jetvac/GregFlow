"""Read-only adapter for ShadowTheAge GTNH Calculator binary exports (data.bin).

Supported formats: 5 (gtnh-data 2.8.0-v5) and 7 (gtnh-data 2.9.0-v7 and the
current upstream exporter). Layout is ported from the MIT-licensed
ShadowTheAge/gtnh src/repository.ts:
  format 5 - commit b826e96a06 ("data format v5")
  format 7 - commit af8c79888e (tooltip stored as a slice of strings)

The file is a gzip stream of little-endian int32 "elements". All pointers are
element indices. Nothing is guessed: fields that are absent in the export are
returned as None.
"""
from __future__ import annotations

import array
import re
import gzip
import hashlib
import struct
import sys

SUPPORTED_FORMATS = (5, 7)

IO_ITEM_IN, IO_OREDICT_IN, IO_FLUID_IN, IO_ITEM_OUT, IO_FLUID_OUT = range(5)
IO_KIND = {IO_ITEM_IN: "item", IO_OREDICT_IN: "oredict", IO_FLUID_IN: "fluid",
           IO_ITEM_OUT: "item", IO_FLUID_OUT: "fluid"}

VOLTAGE_TIERS = ["LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV",
                 "UIV", "UMV", "UXV", "MAX"]
# Index below LV used by ULV recipes in some exports is reported as-is.


class CatalogError(Exception):
    pass


def norm(s: str) -> str:
    return (s or "").lower().replace("ё", "е")


def _stem(w: str) -> str:
    """Very light stemming so that 'магниевая пыль' finds 'магний', 'пыль'."""
    n = len(w)
    if n <= 3:
        return w
    if n == 4:
        return w[:3]
    if n <= 6:
        return w[:n - 2]
    return w[:n - 4]


def matcher(term: str, loose: bool = True):
    """Returns f(name) -> bool: substring match, or every word present (stemmed when loose)."""
    t = norm(term).strip()
    words = [(_stem(w) if loose else w) for w in re.split(r"[\s()\[\],.-]+", t) if w]
    def f(name: str) -> bool:
        if t in name:
            return True
        return len(words) > 0 and all(w in name for w in words)
    return f


class Catalog:
    def __init__(self, raw_gz: bytes, dataset_id: str, meta: dict | None = None):
        self.dataset_id = dataset_id
        self.meta = meta or {}
        self.compressed_sha256 = hashlib.sha256(raw_gz).hexdigest()
        try:
            data = gzip.decompress(raw_gz)
        except OSError:
            data = raw_gz  # allow an already-decompressed file
        self.uncompressed_sha256 = hashlib.sha256(data).hexdigest()
        self.bytes = data
        el = array.array("i")
        el.frombytes(data[: len(data) - len(data) % 4])
        if sys.byteorder != "little":
            el.byteswap()
        self.el = el
        self.format = el[0]
        if self.format not in SUPPORTED_FORMATS:
            raise CatalogError(
                f"Неподдерживаемый формат data.bin: {self.format}. Поддерживаются: {SUPPORTED_FORMATS}")
        self._str_cache: dict[int, str | None] = {}
        self.names_ru: dict[int, str] = {}
        self.machines_ru: dict[str, str] = {}
        self.items = self.slice(el[1])
        self.fluids = self.slice(el[2])
        self.oredicts = self.slice(el[3])
        self.recipe_types = self.slice(el[4])
        self.recipes = self.slice(el[5])
        self.pos: dict[str, int] = {}
        for group in (self.items, self.fluids, self.oredicts, self.recipes):
            for p in group:
                self.pos[self.string(el[p + 4])] = p
        # Remap of recipe IDs from older exports -> current position
        self.remap: dict[str, int] = {}
        for rp in self.slice(el[7]):
            self.remap[self.string(el[rp])] = el[rp + 1]
        self._build_indexes()

    # ---------- primitive readers ----------
    def slice(self, p: int):
        if p == -1:
            return []
        n = self.el[p]
        return self.el[p + 1: p + 1 + n]

    def string(self, p: int):
        if p == -1:
            return None
        s = self._str_cache.get(p)
        if s is None:
            n = self.el[p]
            b = p * 4 + 4
            s = self.bytes[b: b + n].decode("utf-8", "replace")
            self._str_cache[p] = s
        return s

    def double(self, p: int) -> float:
        return struct.unpack_from("<d", self.bytes, p * 4)[0]

    # ---------- indexes ----------
    def _build_indexes(self):
        el = self.el
        self.type_names = {}
        for tp in self.recipe_types:
            self.type_names[tp] = self.string(el[tp])
        self.recipes_by_type: dict[int, list[int]] = {tp: [] for tp in self.recipe_types}
        for rp in self.recipes:
            self.recipes_by_type.setdefault(el[rp + 6], []).append(rp)
        self._build_search()
        self.type_by_ptr = {}

    def _build_search(self):
        el = self.el
        self.search_rows = []  # (english, russian, kind, ptr), normalized
        for kind, group in (("item", self.items), ("fluid", self.fluids)):
            for p in group:
                self.search_rows.append((norm(self.string(el[p + 5])), norm(self.names_ru.get(p, "")), kind, p))

    def attach_names(self, goods: dict, machines: dict):
        """Russian names (goods id -> name, recipe map English name -> Russian)."""
        self.names_ru = {self.pos[g]: n for g, n in goods.items() if g in self.pos}
        self.machines_ru = dict(machines)
        self._build_search()

    # ---------- object decoding ----------
    def kind_of(self, gid: str) -> str:
        return {"i": "item", "f": "fluid", "r": "recipe"}.get(gid[:1], "oredict")

    def tooltip(self, p: int):
        v = self.el[p + 10]
        if v == -1:
            return None
        if self.format >= 7:
            parts = [self.string(x) for x in self.slice(v)]
            return "\n".join(parts) if parts else None
        return self.string(v)

    def goods_brief(self, p: int, kind: str) -> dict:
        el = self.el
        return {
            "id": self.string(el[p + 4]),
            "kind": kind,
            "name": self.string(el[p + 5]),
            "nameRu": self.names_ru.get(p),
            "mod": self.string(el[p + 6]),
            "icon": el[p + 9],
        }

    def goods(self, gid: str) -> dict | None:
        p = self.pos.get(gid)
        if p is None:
            return None
        kind = self.kind_of(gid)
        el = self.el
        if kind == "oredict":
            return self.oredict(p)
        if kind == "recipe":
            return None
        d = self.goods_brief(p, kind)
        d.update({
            "internalName": self.string(el[p + 7]),
            "unlocalizedName": self.string(el[p + 11]),
            "nbt": self.string(el[p + 12]),
            "tooltip": self.tooltip(p),
            "producedBy": len(self.slice(el[p + 13])),
            "consumedBy": len(self.slice(el[p + 14])),
        })
        if kind == "item":
            d["stackSize"] = el[p + 15]
            d["damage"] = el[p + 16]
            cp = el[p + 17]
            if cp != -1:
                d["container"] = {
                    "fluid": self.string(el[el[cp] + 4]) if el[cp] != -1 else None,
                    "amount": el[cp + 1],
                    "empty": self.string(el[el[cp + 2] + 4]) if el[cp + 2] != -1 else None,
                }
        else:
            d["isGas"] = el[p + 15] == 1
        return d

    def oredict(self, p: int) -> dict:
        el = self.el
        return {
            "id": self.string(el[p + 4]),
            "kind": "oredict",
            "variants": [self.goods_brief(ip, "item") for ip in self.slice(el[p + 5])],
        }

    def machine(self, tp: int) -> dict:
        el = self.el
        crafters = lambda s: [self.goods_brief(x, "item") for x in self.slice(el[tp + s])]
        dc = el[tp + 6]
        return {
            "name": self.string(el[tp]),
            "nameRu": self.machines_ru.get(self.string(el[tp])),
            "category": self.string(el[tp + 1]),
            "dimensions": list(self.slice(el[tp + 2])),
            "shapeless": el[tp + 4] == 1,
            "singleblocks": crafters(5),
            "multiblocks": crafters(3),
            "defaultCrafter": self.goods_brief(dc, "item") if dc != -1 else None,
        }

    def recipe(self, rid: str, full: bool = True) -> dict | None:
        p = self.pos.get(rid)
        if p is None:
            p = self.remap.get(rid)
            if p is None:
                return None
        el = self.el
        io_slice = self.slice(el[p + 5])
        inputs, outputs = [], []
        for i in range(0, len(io_slice), 5):
            t, gp, slot, amount, prob = io_slice[i: i + 5]
            kind = IO_KIND[t]
            if kind == "oredict":
                entry = self.oredict(gp)
                entry["name"] = entry["variants"][0]["name"] if entry["variants"] else entry["id"]
                entry["icon"] = entry["variants"][0]["icon"] if entry["variants"] else -1
            else:
                entry = self.goods_brief(gp, kind)
            entry.update({"slot": slot, "amount": amount, "probability": prob / 100.0})
            if t in (IO_ITEM_IN, IO_OREDICT_IN, IO_FLUID_IN):
                # GT marks non-consumed inputs (circuits, molds, lenses) with amount 0
                entry["consumed"] = amount > 0
                inputs.append(entry)
            else:
                outputs.append(entry)
        tp = el[p + 6]
        gp = el[p + 7]
        r = {
            "id": self.string(el[p + 4]),
            "dataset": self.dataset_id,
            "machine": self.machine(tp) if full else {"name": self.string(el[tp]),
                                                       "nameRu": self.machines_ru.get(self.string(el[tp]))},
            "inputs": inputs,
            "outputs": outputs,
            "gt": None,
        }
        if gp != -1:
            voltage, ticks, amps, tier = el[gp], el[gp + 1], el[gp + 2], el[gp + 3]
            md = []
            for mp in self.slice(el[gp + 4]):
                md.append({"key": self.string(el[mp]), "value": self.double(mp + 1)})
            r["gt"] = {
                "durationTicks": ticks,
                "voltage": voltage,
                "amperage": amps,
                "eut": voltage * amps,
                "tier": tier,
                "tierName": VOLTAGE_TIERS[tier] if 0 <= tier < len(VOLTAGE_TIERS) else None,
                "circuitConflicts": el[gp + 5],
                "specialValue": el[gp + 6],
                "metadata": md,
            }
        return r

    # ---------- queries ----------
    def search(self, q: str, limit: int = 60) -> list[dict]:
        q = norm(q).strip()
        if not q:
            return []
        exact, starts, contains, words = [], [], [], []
        f = matcher(q)
        for en, ru, kind, p in self.search_rows:
            if q == en or q == ru:
                exact.append((kind, p))
            elif en.startswith(q) or (ru and ru.startswith(q)):
                starts.append((kind, p))
            elif q in en or (ru and q in ru):
                contains.append((kind, p))
            elif f(en) or (ru and f(ru)) or (ru and f(ru + " " + en)):
                words.append((kind, p))
        words.sort(key=lambda kp: len(self.names_ru.get(kp[1]) or self.string(self.el[kp[1] + 5]) or ""))
        out = []
        for kind, p in (exact + starts + contains + words)[:limit]:
            d = self.goods_brief(p, kind)
            d["producedBy"] = len(self.slice(self.el[p + 13]))
            d["consumedBy"] = len(self.slice(self.el[p + 14]))
            out.append(d)
        return out

    def search_machines(self, q: str) -> list[dict]:
        qn = norm(q).strip()
        f = matcher(q)
        strict, loose = [], []
        for tp, name in self.type_names.items():
            ru = self.machines_ru.get(name)
            row = {"name": name, "nameRu": ru, "category": self.string(self.el[tp + 1]),
                   "recipes": len(self.recipes_by_type.get(tp, []))}
            if not qn or qn in norm(name) or (ru and qn in norm(ru)):
                strict.append(row)
            elif f(norm(name)) or (ru and f(norm(ru))):
                loose.append(row)
        out = strict or loose
        out.sort(key=lambda m: (-m["recipes"], m["name"] or ""))
        return out

    def recipes_for(self, gid: str, mode: str, machine: str | None = None,
                    offset: int = 0, limit: int = 50, q: str = "", side: str = "any",
                    max_tier: int | None = None) -> dict:
        p = self.pos.get(gid)
        if p is None:
            return {"total": 0, "recipes": []}
        el = self.el
        if self.kind_of(gid) == "oredict":
            return {"total": 0, "recipes": []}
        ptrs = self.slice(el[p + (13 if mode == "production" else 14)])
        return self._page(self.filter_recipes(ptrs, q, side, max_tier), machine, offset, limit)

    def recipes_of_machine(self, name: str, offset=0, limit=50, q: str = "", side: str = "any",
                           max_tier: int | None = None) -> dict:
        for tp, n in self.type_names.items():
            if n == name:
                ptrs = self.recipes_by_type.get(tp, [])
                return self._page(self.filter_recipes(ptrs, q, side, max_tier), None, offset, limit)
        return {"total": 0, "recipes": []}

    # ---- recipe filtering ----
    @staticmethod
    def parse_terms(q: str, side: str = "any"):
        """'magnesium, out:oxygen' -> [('magnesium','any'), ('oxygen','out')].
        Terms are separated by ',' or ';' and must ALL match. Prefixes in:/out:
        (or вх:/вых:) restrict a single term to inputs/outputs."""
        terms = []
        for raw in re.split(r"[,;]", q or ""):
            t = norm(raw).strip()
            if not t:
                continue
            s = side
            m = re.match(r"^(in|out|вх|вых)\s*:\s*(.+)$", t)
            if m:
                s = "in" if m.group(1) in ("in", "вх") else "out"
                t = m.group(2).strip()
            terms.append((t, s))
        return terms

    def filter_recipes(self, ptrs, q: str = "", side: str = "any", max_tier: int | None = None):
        terms = self.parse_terms(q, side)
        if not terms and max_tier is None:
            return ptrs
        el = self.el
        base = []
        for rp in ptrs:
            if max_tier is not None:
                gp = el[rp + 7]
                if gp != -1 and el[gp + 3] > max_tier:
                    continue
            base.append(rp)
        if not terms:
            return base
        # exact words first; word-form (stem) matching only when nothing matches exactly
        names = [self._io_names(rp) for rp in base]
        for loose in (False, True):
            fs = [(matcher(t, loose), s) for t, s in terms]
            out = [rp for rp, nm in zip(base, names) if all(any(f(n) for n in nm[s]) for f, s in fs)]
            if out:
                return out
        return []

    def _io_names(self, rp: int) -> dict:
        """Lower-cased names and IDs of a recipe's inputs and outputs."""
        el = self.el
        s = self.slice(el[rp + 5])
        res = {"in": [], "out": []}
        for i in range(0, len(s), 5):
            t, gp = s[i], s[i + 1]
            key = "in" if t in (IO_ITEM_IN, IO_OREDICT_IN, IO_FLUID_IN) else "out"
            if t == IO_OREDICT_IN:
                res[key].append((self.string(el[gp + 4]) or "").lower())
                for vp in self.slice(el[gp + 5]):
                    res[key].append(norm(self.string(el[vp + 5])))
                    res[key].append(norm(self.string(el[vp + 4])))
                    if vp in self.names_ru:
                        res[key].append(norm(self.names_ru[vp]))
            else:
                res[key].append(norm(self.string(el[gp + 5])))
                res[key].append(norm(self.string(el[gp + 4])))
                if gp in self.names_ru:
                    res[key].append(norm(self.names_ru[gp]))
        res["any"] = res["in"] + res["out"]
        return res

    def _page(self, ptrs, machine, offset, limit):
        el = self.el
        by_machine: dict[str, int] = {}
        sel = []
        for rp in ptrs:
            mname = self.type_names.get(el[rp + 6])
            by_machine[mname] = by_machine.get(mname, 0) + 1
            if machine is None or mname == machine:
                sel.append(rp)
        page = [self.recipe(self.string(el[rp + 4]), full=False) for rp in sel[offset: offset + limit]]
        return {"total": len(sel), "machines": by_machine, "recipes": page}

    def stats(self) -> dict:
        return {"format": self.format, "items": len(self.items), "fluids": len(self.fluids),
                "oredicts": len(self.oredicts), "recipeTypes": len(self.recipe_types),
                "recipes": len(self.recipes), "compressedSha256": self.compressed_sha256,
                "uncompressedSha256": self.uncompressed_sha256}


def load_file(path: str, dataset_id: str, meta: dict | None = None) -> Catalog:
    with open(path, "rb") as f:
        return Catalog(f.read(), dataset_id, meta)
