# Recipe data: origin, version, verification

**English** · [Русский](DATA.ru.md)

The files `data/datasets/*` (recipe and icon snapshot) and `data/lang/ru_RU/` (Russian translation)
are **not stored in this repository**: the planner downloads them on first start (the «⚙ Setup»
window) and checks them against pinned SHA-256 values.

## Summary (checked 2026-11-11)

**No verifiable recipe export exists for GTNH 2.8.4 itself.** The working base is the verified
**GTNH 2.8.0** snapshot. The interface shows the version («Recipes: GTNH 2.8.0») and warns when it
differs from the installed modpack.

| Source | What was checked | Result |
|---|---|---|
| [gtnhnei `data/manifest.json`](https://github.com/Milky-way-Galaxy/gtnhnei/blob/main/data/manifest.json) | entry `gtnh-2.8.4` | `available: false`, «a matching recipe export has not been verified» |
| [gtnhnei `docs/datasets.md`](https://github.com/Milky-way-Galaxy/gtnhnei/blob/main/docs/datasets.md) | «Investigated gaps» | 2.8.4 — only the modpack archive, no recipe export; branch `2.8.0-v6` is a format change, not 2.8.4 |
| [ShadowTheAge/gtnh-data](https://github.com/ShadowTheAge/gtnh-data) branches (GitHub API) | branch list | `2.8.0-v4`, `2.8.0-v5`, `2.8.0-v6`, `2.9.0-v7`, `main` — no 2.8.4 |
| [ShadowTheAge/gtnh `export/README.md`](https://github.com/ShadowTheAge/gtnh/blob/main/export/README.md) | export pipeline | NESQL Exporter in the client → `dotnet run` → `data.bin` + `atlas.webp`; no ready 2.8.4 |
| A local GTNH 2.8.4 installation (read-only) | `config/GTNewHorizons/dreamcraft.cfg`, `mods/` | `S:ModPackVersion=2.8.4`, `gregtech-5.09.51.482.jar`; no `nesql/` export |

A matching Minecraft version (1.7.10) or the 2.8.x series was **not** accepted as proof.

## Built-in dataset `gtnh-2.8.0`

- Source: <https://github.com/ShadowTheAge/gtnh-data/tree/6d35153688de5ae8e02807b942099618de1d9276>
  (branch `2.8.0-v5`, «Data format v5 includes metadata», 2025-10-16)
- `data.bin`: git blob `b1d2a893…`, SHA-256 `b0ff8d63f3104e979628c64e650cab17bf0b442e01bdb00c1d8f54c458a3eccc`
- `atlas.webp`: git blob `375b307c…`, SHA-256 `fa05550ce9657ce49d4512b4aab7fe76d684b70745b0bc7b744c9ae0d6eb6ef5` (8192×5344, 32 px icons)
- Binary format 5: 41 091 items, 1 542 fluids, 625 ore dictionary entries, 154 recipe maps, 190 080 recipes.
- The server checks SHA-256 and record counts on start; on mismatch the catalog is not loaded.

Download again from the console: `python planner.py --fetch-data` (or the Setup window).

## What is stored per recipe

From the export only — missing fields stay «no data», nothing is guessed:

- stable recipe ID (`r~…`), dataset, recipe map (machine), list of crafters;
- inputs/outputs: kind (item / fluid / ore dictionary), stable ID (`i:mod:name:meta[:nbt-hash]`,
  `f:mod:name`, `o:oreName`), amount per cycle, output chance;
- non-consumed inputs (amount 0 in GT exports: programmed circuits, molds, lenses);
- duration in ticks, voltage and amperage (EU/t = V × A), tier, `specialValue`, metadata (e.g. `coil_heat`).

Links are created only between identical stable IDs — equal names are not compatibility.
A machine node keeps a **snapshot** of its recipe inside the project file, so updating the catalog
never changes a line you already built («Compare with catalog» shows differences).

## Getting real 2.8.4 data

1. Build [ShadowTheAge/nesql-exporter](https://github.com/ShadowTheAge/nesql-exporter) and export in a 2.8.4 **client**.
2. Convert: `dotnet run <nesql folder>` from `ShadowTheAge/gtnh/export` → `data.bin` (+ `atlas.webp`).
3. In the planner: «Recipes» badge → «Choose data.bin…», then «+ atlas». The dataset is marked
   «not verified» and gets its own SHA-256.

Formats **5 and 7** are supported. Point fixes without a full export: «My recipes» (a copy keeps
its source: dataset, recipe ID, dataset SHA-256, date; manual recipes are marked `manual`).

## Russian names

The export contains English names only. Russian names are built like the game does it, from:

| Source | Gives | How |
|---|---|---|
| `ru_RU.lang` inside mod jars of the installation | mod translations | read-only |
| [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations) `ru_RU` | GregTech materials, `gt.oreprefix.*` templates, machines | downloaded at a pinned commit into `data/lang/ru_RU/`, SHA-256 of every file in `manifest.json` |
| `GregTech.lang` of the installation | English templates | read-only |

Example: English template `%material Dust` → key `gt.oreprefix.material_dust` → Russian
`[Пыль] %s` + `Material.magnesium` = «[Пыль] Магний». If any part is missing, the English name is
shown. Vanilla Minecraft items stay English (their translation ships only with the game client).

## Energy: cables, generators, fuel

- **Cables and wires** are read from `gregtech-*.jar` (bytecode of `LoaderMetaPipeEntities` is parsed,
  never executed): material, voltage tier, amperage, loss per block for cable and bare wire.
  The table for GregTech 5.09.51.482 ships as `data/energy/cables.json` (57 materials), so it works
  without an installation; with one, it is re-read from your jar.
- **Generators**: GregTech items whose tooltip has «Voltage OUT» and that burn a fuel map or show
  «Fuel Efficiency» / steam use (45). Voltage and efficiency from the tooltip; output amps default to 1.
- **Fuel**: recipe maps with `fuel_value`. For fluids it is EU per 1 L (× generator efficiency).
  For solid fuel the meaning depends on the generator, so it is entered manually. Steam turbines use
  the steam consumption from their tooltip.
- **Loss model**: every amp loses `loss per block × length` EU; the machine receives `V − loss·length`;
  the generator sends `need × V / Vd`.
- **Distribution**: on demand, as in a GT network. Each machine asks for the EU/t it would draw at
  its current material-limited load; a generator serves all requests up to what its capacity and
  fuel allow, and only a real shortage is shared in proportion to the requests. A block's ⚡ input
  is an EU/t budget shared the same way by the machines inside, so grouping never changes the
  numbers. Not modelled: transformers, batteries, multi-amp input,
  variable turbine efficiency.

## Licenses and attribution

- **Planner code** — MIT (see `LICENSE`).
- **Binary format parser** — ported layout from [ShadowTheAge/gtnh](https://github.com/ShadowTheAge/gtnh)
  `src/repository.ts`, MIT License, Copyright (c) 2025 ShadowTheAge (`docs/LICENSE-ShadowTheAge-gtnh.txt`).
- **Recipe data, names and icons** — [ShadowTheAge/gtnh-data](https://github.com/ShadowTheAge/gtnh-data),
  published **without a license**; the content belongs to Mojang, the GTNH team and mod authors.
  It is therefore not redistributed here: each user downloads it from the original repository.
- **Russian translation** — [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations),
  **GPL-3.0**; downloaded on demand, kept unchanged, only read.
- **Cable table** — numeric values read from GregTech 5 Unofficial (GTNH team, LGPL-3.0); no mod code
  is copied or executed.
- [Milky-way-Galaxy/gtnhnei](https://github.com/Milky-way-Galaxy/gtnhnei) was used only as a source of
  information about verification; no code or data was copied.
