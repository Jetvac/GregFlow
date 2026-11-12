"""Tests against REAL catalog data (gtnh-data 2.8.0-v5) and the local HTTP API.

    python -m unittest discover -s tests -v

Optional: set GTNH_TEST_FORMAT7=<path to gtnh-data 2.9.0-v7 data.bin> to test the
format-7 adapter on a real export (SHA-256 624c9a20…, git blob 4e15fde3…).
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import app, catalog, install_check  # noqa: E402

DATA = os.path.join(ROOT, "data", "datasets", "gtnh-2.8.0", "data.bin")
HAS_DATA = os.path.isfile(DATA)
needs_data = unittest.skipUnless(HAS_DATA, "recipe data not downloaded (python planner.py --fetch-data)")
_CAT = None


def read(path):
    with open(path, "rb") as f:
        return f.read()


def cat():
    global _CAT
    if _CAT is None:
        _CAT = catalog.load_file(DATA, "gtnh-2.8.0")
    return _CAT


def io(r, key):
    return [(e["id"], e["amount"], round(e["probability"], 4)) for e in r[key]]


@needs_data
class RealCatalog(unittest.TestCase):
    def test_provenance(self):
        raw = read(DATA)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         "b0ff8d63f3104e979628c64e650cab17bf0b442e01bdb00c1d8f54c458a3eccc")
        st = cat().stats()
        self.assertEqual(st["format"], 5)
        self.assertEqual((st["items"], st["fluids"], st["recipes"]), (41091, 1542, 190080))
        self.assertEqual(st["uncompressedSha256"], "f3b57c9fbc1d613ff585fe505a990af349161f23aad45b5bcd1519a1af42e626")

    def test_electrolyzer_sand(self):
        r = cat().recipe("r~kCJP1G_wMVa8MIQRh0s13g==")
        self.assertEqual(r["machine"]["name"], "Electrolyzer")
        self.assertEqual(io(r, "inputs"), [("i:minecraft:sand:0", 8, 1.0)])
        self.assertEqual(io(r, "outputs"), [("i:gregtech:gt.metaitem.01:2837", 3, 1.0)])
        self.assertEqual(r["outputs"][0]["name"], "Silicon Dioxide Dust")
        self.assertEqual((r["gt"]["durationTicks"], r["gt"]["eut"], r["gt"]["tierName"]), (500, 25, "LV"))
        self.assertIn("Basic Electrolyzer", [c["name"] for c in r["machine"]["singleblocks"]])

    def test_water_electrolysis_fluids_and_circuit(self):
        r = cat().recipe("r~Vo5NG-W1M1qWhHFbnPFotw==")
        kinds = {e["id"]: (e["kind"], e["amount"], e["consumed"]) for e in r["inputs"]}
        self.assertEqual(kinds["f:minecraft:water"], ("fluid", 1000, True))
        self.assertEqual(kinds["i:gregtech:gt.integrated_circuit:1"], ("item", 0, False))  # non-consumed
        self.assertIn(("f:GalacticraftMars:hydrogen", 2000, 1.0), io(r, "outputs"))
        self.assertEqual((r["gt"]["durationTicks"], r["gt"]["eut"]), (2000, 30))

    def test_centrifuge_chance_and_fluid_output(self):
        r = cat().recipe("r~-MkX94PaPDGr0BxiFQjfiw==")
        self.assertEqual(r["machine"]["name"], "Centrifuge")
        outs = io(r, "outputs")
        self.assertIn(("i:IC2:itemFuelPlantBall:0", 1, 0.1), outs)
        self.assertIn(("f:gregtech:refinedglue", 100, 1.0), outs)

    def test_oredict_input_variants(self):
        r = cat().recipe("r~-NbtU3-bPIOzUr99ng5OcA==")
        od = [e for e in r["inputs"] if e["kind"] == "oredict"][0]
        self.assertEqual(od["id"], "o:dustSulfur")
        self.assertEqual(od["amount"], 2)
        self.assertGreaterEqual(len(od["variants"]), 2)
        self.assertTrue(all(v["id"].startswith("i:") for v in od["variants"]))
        self.assertIn(("f:GalacticraftMars:oxygen", 7000, 1.0), io(r, "inputs"))

    def test_ebf_metadata(self):
        r = cat().recipe("r~WoQfAeZjNbyiwcaH6SpRiA==")
        self.assertEqual(r["machine"]["name"], "Blast Furnace")
        self.assertEqual((r["gt"]["durationTicks"], r["gt"]["eut"]), (80, 120))
        ashes = [e for e in r["outputs"] if e["name"] == "Ashes"]
        self.assertEqual(len(ashes), 1)
        self.assertEqual((ashes[0]["amount"], round(ashes[0]["probability"], 4)), (1, 0.11))
        self.assertIn(("f:gregtech:carbonmonoxide", 2000, 1.0), io(r, "outputs"))
        self.assertTrue(any(m["key"] == "coil_heat" for m in r["gt"]["metadata"]))

    def test_search_and_usage(self):
        hits = cat().search("sand")
        self.assertEqual(hits[0]["id"], "i:minecraft:sand:0")
        res = cat().recipes_for("i:minecraft:sand:0", "consumption", "Electrolyzer")
        self.assertEqual(res["total"], 1)
        prod = cat().recipes_for("f:minecraft:water", "production")
        self.assertGreater(prod["total"], 0)
        self.assertIn("Electrolyzer", [m["name"] for m in cat().search_machines("electro")])

    def test_recipe_filter_inputs_outputs_tier(self):
        magnesia = "i:gregtech:gt.metaitem.01:2621"
        allp = cat().recipes_for(magnesia, "production", limit=100)
        self.assertEqual(allp["total"], 41)
        both = cat().recipes_for(magnesia, "production", None, 0, 100, "in:silicon dioxide, out:raw silicon")
        self.assertIn("r~KNFUVhzfOwq6mFtHoi7cjg==", [r["id"] for r in both["recipes"]])
        self.assertTrue(all(r["machine"]["name"] in ("Chemical Reactor", "Large Chemical Reactor") for r in both["recipes"]))
        self.assertEqual(cat().recipes_for(magnesia, "production", None, 0, 100, "oxygen", "out")["total"], 0)
        self.assertEqual(cat().recipes_for(magnesia, "production", None, 0, 100, "oxygen", "in")["total"], 2)
        lv = cat().recipes_for(magnesia, "production", None, 0, 100, "", "any", 0)
        self.assertTrue(all(cat().recipe(r["id"])["gt"] is None or cat().recipe(r["id"])["gt"]["tier"] == 0 for r in lv["recipes"]))
        self.assertLess(lv["total"], allp["total"])
        el = cat().recipes_of_machine("Electrolyzer", 0, 50, "in:magnesia, out:magnesium")
        self.assertEqual([r["id"] for r in el["recipes"]], ["r~Zx5M8dmoMYOCvjAvTfJKmw=="])

    def test_magnesium_loop_recipes(self):
        cr = cat().recipe("r~KNFUVhzfOwq6mFtHoi7cjg==")
        self.assertEqual(io(cr, "inputs"), [("i:gregtech:gt.metaitem.01:2837", 3, 1.0), ("i:gregtech:gt.metaitem.01:2018", 2, 1.0)])
        self.assertEqual([(e["name"], e["amount"]) for e in cr["outputs"]], [("Raw Silicon Dust", 1), ("Magnesia Dust", 4)])
        self.assertEqual((cr["gt"]["durationTicks"], cr["gt"]["eut"]), (100, 8))
        el = cat().recipe("r~Zx5M8dmoMYOCvjAvTfJKmw==")
        self.assertEqual([(e["name"], e["amount"]) for e in el["outputs"]], [("Magnesium Dust", 1), ("Oxygen", 1000)])
        self.assertEqual((el["gt"]["durationTicks"], el["gt"]["eut"]), (40, 30))

    def test_unknown_ids(self):
        self.assertIsNone(cat().recipe("r~doesnotexist"))
        self.assertIsNone(cat().goods("i:nope:nope:0"))


@unittest.skipUnless(os.environ.get("GTNH_TEST_FORMAT7"), "GTNH_TEST_FORMAT7 not set")
class Format7Adapter(unittest.TestCase):
    def test_real_format7_export(self):
        path = os.environ["GTNH_TEST_FORMAT7"]
        raw = read(path)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),
                         "624c9a20c8476dc630c274145dc04c72d7c582e130a3599dc49ce9aee0a2fe73")
        c = catalog.Catalog(raw, "gtnh-2.9.0")
        st = c.stats()
        self.assertEqual(st["format"], 7)
        self.assertEqual((st["items"], st["fluids"], st["recipes"]), (50811, 1476, 221760))
        sand = c.recipes_for("i:minecraft:sand:0", "consumption", "Electrolyzer")["recipes"]
        self.assertTrue(sand, "sand electrolysis exists in 2.9.0")
        full = c.recipe(sand[0]["id"])
        self.assertEqual(full["inputs"][0]["id"], "i:minecraft:sand:0")
        g = c.goods("i:minecraft:sand:0")
        self.assertIsInstance(g["tooltip"], (str, type(None)))  # format-7 tooltip slice joined


INSTALL = install_check.find_install(ROOT)
HAS_LANG = os.path.isfile(os.path.join(ROOT, "data", "lang", "ru_RU", "manifest.json"))


def _mtimes(d):
    out = {}
    for name in ("GregTech.lang",):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            out[name] = os.stat(p).st_mtime_ns
    for p in sorted(os.listdir(os.path.join(d, "mods"))):
        out[p] = os.stat(os.path.join(d, "mods", p)).st_mtime_ns
    return out


@unittest.skipUnless(INSTALL and HAS_LANG, "нужны установка GTNH и data/lang/ru_RU (python planner.py --fetch-lang)")
@needs_data
class RussianNames(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server import lang
        cls.before = _mtimes(INSTALL)
        cls.c = catalog.load_file(DATA, "gtnh-2.8.0")
        n = lang.Names(os.path.join(ROOT, "data"), INSTALL).build(cls.c)
        cls.c.attach_names(n.goods, n.machines)
        cls.names = n

    def test_install_untouched(self):
        self.assertEqual(_mtimes(INSTALL), self.before)

    def test_translations_verified(self):
        st = self.names.status()
        self.assertTrue(st["translations"]["verified"])
        self.assertEqual(st["translations"]["license"], "GPL-3.0")

    def test_gt_material_names_follow_game_templates(self):
        g = self.c.goods_brief(self.c.pos["i:gregtech:gt.metaitem.01:2018"], "item")
        self.assertEqual(g["nameRu"], "[Пыль] Магний")
        self.assertEqual(self.names.goods.get("i:gregtech:gt.metaitem.01:1018"), "[Маленькая кучка пыли] Магний")
        self.assertEqual(self.names.goods.get("i:gregtech:gt.blockmachines:1246"), "[1x кабель] Олово")
        self.assertEqual(self.c.machines_ru.get("Electrolyzer"), "Электролизер")

    def test_russian_search_any_word_order_and_form(self):
        self.assertEqual(self.c.search("пыль магния", 5)[0]["id"], "i:gregtech:gt.metaitem.01:2018")
        self.assertEqual(self.c.search("магниевая пыль", 5)[0]["id"], "i:gregtech:gt.metaitem.01:2018")
        self.assertEqual(self.c.search("Кислород", 5)[0]["nameRu"], "Кислород")
        self.assertEqual([m["name"] for m in self.c.search_machines("электролиз")], ["Electrolyzer"])
        self.assertTrue(self.c.search("magnesium dust", 5))  # English still works

    def test_russian_recipe_filter(self):
        r = self.c.recipes_of_machine("Electrolyzer", 0, 50, "вх:магнезия, вых:магний")
        self.assertEqual([x["id"] for x in r["recipes"]], ["r~Zx5M8dmoMYOCvjAvTfJKmw=="])


@unittest.skipUnless(INSTALL, "нужна установка GTNH (gregtech-*.jar)")
@needs_data
class EnergyData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server import energy
        cls.energy = energy
        cls.before = _mtimes(INSTALL)
        jar = sorted(f for f in os.listdir(os.path.join(INSTALL, "mods")) if f.startswith("gregtech-"))[-1]
        cls.recs = energy.extract_cables(os.path.join(INSTALL, "mods", jar))
        cls.c = cat()
        cls.gens = energy.generators(cls.c)

    def test_cables_from_jar_bytecode(self):
        by = {r["material"]: r for r in self.recs}
        self.assertGreater(len(self.recs), 50)
        self.assertEqual({k: by["Tin"][k] for k in ("tier", "voltage", "amperage", "lossCable", "lossWire")},
                         {"tier": "LV", "voltage": 32, "amperage": 1, "lossCable": 1, "lossWire": 2})
        self.assertEqual((by["Copper"]["tier"], by["Copper"]["lossCable"]), ("MV", 2))
        self.assertEqual((by["SuperconductorMV"]["lossWire"], by["SuperconductorMV"]["wireOnly"]), (0, True))
        self.assertEqual(_mtimes(INSTALL), self.before)

    def test_cable_items_sizes(self):
        opts = self.energy.cable_options({"records": self.recs}, self.c)
        tin = {(o["insulated"], o["size"]): o for o in opts if o["material"] == "Tin"}
        self.assertEqual(tin[(True, 1)]["id"], "i:gregtech:gt.blockmachines:1246")
        self.assertEqual((tin[(True, 4)]["amps"], tin[(True, 4)]["loss"]), (4, 1))
        self.assertEqual(tin[(False, 1)]["loss"], 2)

    def test_generators_from_tooltips(self):
        by = {g["name"]: g for g in self.gens}
        cg = by["Basic Combustion Generator"]
        self.assertEqual((cg["voltage"], cg["tier"], cg["efficiency"], cg["fuelMaps"]), (32, "LV", 95, ["Combustion Generator Fuels"]))
        st = by["Basic Steam Turbine"]
        self.assertEqual((st["steam"]["perSecond"], st["efficiency"]), (1552, 85))
        self.assertFalse(any("Diode" in n or "Transformer" in n or "Buffer" in n for n in by))

    def test_fuels_normalized(self):
        f = {x["res"]["name"]: x for x in self.energy.fuels(self.c, "Combustion Generator Fuels")}
        self.assertEqual((f["Gasoline"]["euPerUnit"], f["Gasoline"]["rule"], f["Gasoline"]["res"]["kind"]), (576.0, "cell", "fluid"))
        nq = self.energy.fuels(self.c, "Naquadah Reactor MkI")
        self.assertTrue(all(x["euPerUnit"] is None and x["rule"] == "item" for x in nq))  # solid fuel: not guessed


class InstallCheck(unittest.TestCase):
    def test_reads_pack_version_without_writing(self):
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, "mods"))
            os.makedirs(os.path.join(d, "config", "GTNewHorizons"))
            open(os.path.join(d, "mods", "gregtech-5.09.51.482.jar"), "wb").close()
            with open(os.path.join(d, "config", "GTNewHorizons", "dreamcraft.cfg"), "w") as f:
                f.write("general {\n    S:ModPackVersion=2.8.4\n}\n")
            before = {p: os.stat(os.path.join(r, p)).st_mtime_ns for r, _, fs in os.walk(d) for p in fs}
            info = install_check.inspect(d)
            after = {p: os.stat(os.path.join(r, p)).st_mtime_ns for r, _, fs in os.walk(d) for p in fs}
            self.assertEqual(info["packVersion"], "2.8.4")
            self.assertEqual(info["jars"]["gregtech"]["version"], "5.09.51.482")
            self.assertEqual(before, after)
            self.assertEqual(install_check.find_install(os.path.join(d, "mods")), os.path.abspath(d))
        finally:
            shutil.rmtree(d)


@needs_data
class Api(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        data = os.path.join(cls.tmp, "data")
        os.makedirs(os.path.join(data, "datasets", "gtnh-2.8.0"))
        shutil.copy(os.path.join(ROOT, "data", "datasets.json"), data)
        for f in ("data.bin", "atlas.webp"):
            shutil.copy(os.path.join(ROOT, "data", "datasets", "gtnh-2.8.0", f), os.path.join(data, "datasets", "gtnh-2.8.0", f))
        cls.planner = app.Planner(ROOT, data_dir=data, projects_dir=os.path.join(cls.tmp, "projects"), mc_dir=None)
        cls.srv = app.make_server(cls.planner, port=0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.planner.catalog = None
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, raw=False, headers=None):
        url = f"http://127.0.0.1:{self.port}/api/{path}"
        data = body if raw else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_status_and_search(self):
        s, st = self.call("GET", "status")
        self.assertEqual(s, 200)
        self.assertEqual(st["active"]["id"], "gtnh-2.8.0")
        self.assertTrue(st["active"]["verified"])
        self.assertFalse(next(d for d in st["datasets"] if d["id"] == "gtnh-2.8.4")["available"])
        s, r = self.call("GET", "search?q=water")
        self.assertEqual(r["goods"][0]["id"], "f:minecraft:water")
        s, r = self.call("GET", "recipes?id=i:minecraft:sand:0&mode=consumption&machine=Electrolyzer")
        self.assertEqual(r["total"], 1)

    def test_custom_recipe_copy_preserves_source(self):
        s, orig = self.call("GET", "recipe?id=r~kCJP1G_wMVa8MIQRh0s13g==")
        copy = dict(orig)
        copy.pop("id")
        copy["source"] = {"type": "copy", "dataset": "gtnh-2.8.0", "recipeId": orig["id"]}
        copy["gt"] = dict(orig["gt"], durationTicks=400)
        copy["targetPackVersion"] = "2.8.4"
        s, saved = self.call("POST", "custom", copy)
        self.assertEqual(s, 200, saved)
        self.assertTrue(saved["id"].startswith("c~"))
        self.assertEqual(saved["source"]["recipeId"], orig["id"])
        self.assertEqual(saved["gt"]["durationTicks"], 400)
        # original catalog recipe untouched
        s, again = self.call("GET", "recipe?id=r~kCJP1G_wMVa8MIQRh0s13g==")
        self.assertEqual(again["gt"]["durationTicks"], 500)
        # custom shows up in production search
        s, r = self.call("GET", "recipes?id=i:gregtech:gt.metaitem.01:2837&mode=production")
        self.assertIn(saved["id"], [x["id"] for x in r["custom"]])
        s, _ = self.call("DELETE", "custom?id=" + saved["id"])
        self.assertEqual(s, 200)

    def test_custom_validation_no_guessing(self):
        s, r = self.call("POST", "custom", {"machine": {"name": "X"}, "inputs": [{"kind": "item", "id": "i:a", "amount": -1}]})
        self.assertEqual(s, 400)
        s, r = self.call("POST", "custom", {"machine": {"name": "X"}, "inputs": [], "outputs": [
            {"kind": "item", "id": "i:minecraft:sand:0", "amount": 1}], "gt": {"durationTicks": None, "eut": None}})
        self.assertEqual(s, 200)
        self.assertIsNone(r["gt"]["durationTicks"])  # missing stays missing
        self.call("DELETE", "custom?id=" + r["id"])

    def test_project_roundtrip(self):
        proj = {"format": "gtnh-planner-project", "version": 1, "name": "тест линия", "nodes": [], "edges": [], "recipes": {}}
        s, r = self.call("POST", "project", proj)
        self.assertEqual(s, 200)
        s, lst = self.call("GET", "projects")
        self.assertIn("тест линия", [p["name"] for p in lst["projects"]])
        s, back = self.call("GET", "project?file=" + urllib.parse.quote(r["file"]))
        self.assertEqual(r["file"], "тест линия")
        self.assertEqual(back["name"], "тест линия")

    def test_dataset_import_rejects_garbage_and_accepts_real(self):
        s, r = self.call("POST", "datasets/import?label=x&packVersion=2.8.4", b"not a data file", raw=True)
        self.assertEqual(s, 400)
        raw = read(DATA)
        s, r = self.call("POST", "datasets/import?label=copy&packVersion=test", raw, raw=True)
        self.assertEqual(s, 200, r)
        self.assertFalse(r["verified"])
        self.assertEqual(r["counts"]["recipes"], 190080)

    def test_cross_origin_write_rejected(self):
        s, r = self.call("POST", "project", {"format": "gtnh-planner-project", "name": "evil"},
                         headers={"Origin": "http://evil.example", "Content-Type": "application/json"})
        self.assertEqual(s, 403)


class Versions(unittest.TestCase):
    def test_page_and_server_versions_match(self):
        """The page warns «restart the planner» when its version differs from the server's."""
        import re
        js = open(os.path.join(ROOT, "web", "js", "api.js"), encoding="utf-8").read()
        m = re.search(r"CLIENT_VERSION = '([^']+)'", js)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), app.APP_VERSION)

    def test_fresh_server_is_not_stale(self):
        self.assertEqual(app._code_stamp(), app._CODE_AT_START)


class MachineSlots(unittest.TestCase):
    """Robot arm slot numbers rely on the slot counts taken from the GT source."""

    def test_table_known_machines(self):
        P = app.Planner(ROOT)
        d = P.machine_slots()
        self.assertEqual(d["tag"], "5.09.51.482")
        self.assertEqual(d["otherSlotCount"], 5)
        m = d["machines"]
        self.assertGreater(len(m), 400)
        # Basic Assembling Machine (LV): 6 inputs, 1 output; Advanced (MV): 9 inputs
        self.assertEqual((m["211"]["tier"], m["211"]["inputs"], m["211"]["outputs"]), (1, 6, 1))
        self.assertEqual(m["212"]["inputs"], 9)
        # Basic Wiremill: 2 inputs, 1 output
        self.assertEqual((m["351"]["inputs"], m["351"]["outputs"]), (2, 1))


class SetupFromUi(unittest.TestCase):
    """First-run setup endpoints (no network: the data files are copied in)."""

    def test_settings_mcdir_and_missing(self):
        from server import setup
        tmp = tempfile.mkdtemp()
        try:
            data = os.path.join(tmp, "data")
            os.makedirs(os.path.join(data, "datasets", "gtnh-2.8.0"))
            shutil.copy(os.path.join(ROOT, "data", "datasets.json"), data)
            self.assertEqual(sorted(m["file"].split("/")[-1] for m in setup.missing_files(data)), ["atlas.webp", "data.bin"])
            p = app.Planner(ROOT, data_dir=data, projects_dir=os.path.join(tmp, "projects"), mc_dir=None)
            st = p.status()
            self.assertIsNone(st["catalog"])
            self.assertEqual(len(st["setup"]["missing"]), 2)
            self.assertFalse(st["setup"]["welcomed"])
            # a fake install folder is remembered and read only
            mc = os.path.join(tmp, "mc")
            os.makedirs(os.path.join(mc, "mods")); os.makedirs(os.path.join(mc, "config", "GTNewHorizons"))
            with open(os.path.join(mc, "config", "GTNewHorizons", "dreamcraft.cfg"), "w") as f:
                f.write("S:ModPackVersion=2.8.4\n")
            before = {q: os.stat(os.path.join(r, q)).st_mtime_ns for r, _, fs in os.walk(mc) for q in fs}
            st = p.set_install(mc)
            self.assertTrue(st["install"]["found"])
            self.assertEqual(setup.load_settings(data)["mcDir"], os.path.abspath(mc))
            self.assertEqual(before, {q: os.stat(os.path.join(r, q)).st_mtime_ns for r, _, fs in os.walk(mc) for q in fs})
            self.assertEqual([x["path"] for x in setup.find_installs([mc])][:1], [os.path.abspath(mc)])
            with self.assertRaises(ValueError):
                p.set_install(os.path.join(tmp, "nowhere"))
            p2 = app.Planner(ROOT, data_dir=data, projects_dir=os.path.join(tmp, "projects"), mc_dir=None)
            self.assertEqual(p2.install["path"], os.path.abspath(mc))  # remembered across restarts
            p.save_settings({"welcomed": True, "evil": 1})
            self.assertEqual(setup.load_settings(data).get("welcomed"), True)
            self.assertNotIn("evil", setup.load_settings(data))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    @needs_data
    def test_real_data_present(self):
        from server import setup
        self.assertEqual(setup.missing_files(os.path.join(ROOT, "data")), [])


if __name__ == "__main__":
    unittest.main()
