# GTNH Planner

**English** · [Русский](README.ru.md)

A production line planner for **GregTech: New Horizons** (Minecraft 1.7.10). Build a line from real
GTNH recipes on a canvas, the way NEI shows them, and see on every link how much is needed, how much
arrives, and where the shortages and surpluses are. It also covers energy (generators, cables,
losses), recycling loops and blocks (a node made of nodes). The interface is in English or Russian.

It runs on your own computer in the browser. Nothing is installed into Minecraft, and your game
files are never changed.

![A demo line: an electrolyzer and a blast furnace powered by Bio Diesel generators, with the line balance on the right](docs/img/overview.png)

<sub>Demo schematic: the recipes, generators and cables are real GTNH 2.8.0 data; the source rates, machine counts and cable lengths are made up for the example.</sub>

<table>
<tr>
<td width="33%"><a href="docs/img/machine.png"><img src="docs/img/machine.png" alt="Selected machine with per-input demand and supply"></a><br><sub>Select a node to see what it needs, gets and makes, and what limits it.</sub></td>
<td width="33%"><a href="docs/img/block.png"><img src="docs/img/block.png" alt="Several machines grouped into one block node"></a><br><sub>A block: several nodes combined into one, with its own inputs, outputs and ⚡ input.</sub></td>
<td width="33%"><a href="docs/img/block-inside.png"><img src="docs/img/block-inside.png" alt="Inside a block"></a><br><sub>Inside the block, solved with what actually reaches its inputs.</sub></td>
</tr>
</table>

---

## Install and start (no programming needed)

### Windows

1. **Download** the latest `GTNH-Planner-….zip` from the
   [Releases page](https://github.com/Jetvac/GTNH-Planner/releases/latest) and **unzip** it anywhere
   (for example into `Documents`).
2. **Double-click `start.bat`.**
   - If Python is missing, the window offers to install it for you (answer `Y`), or opens
     python.org. After installing, double-click `start.bat` again.
3. Your browser opens the planner. The **Setup** window appears on first start:
   - **Download recipe data** (about 30 MB, once). It is checked by SHA-256.
   - Pick the **interface language** and the language of item names.
   - Optional: **Russian item names** (about 9 MB).
   - Optional: your **Minecraft folder**. Click «Find automatically» (Prism, MultiMC, CurseForge,
     ATLauncher…) or paste the path of the folder that contains `mods` and `config`. The planner only
     **reads** it: the modpack version, the GregTech cable table and mod translations.
4. Keep the black console window open while you use the planner. Close it to stop.

Next time, just double-click `start.bat`. Your schematics are saved in the `projects` folder.

### Linux / macOS

Install Python 3.9 or newer (`sudo apt install python3`, or from python.org on macOS), then run
`./start.sh`. On macOS you can double-click `start.command`.

### Updating

Download the new release, unzip it, and copy your `projects` folder (and `data/custom` if you made
your own recipes) from the old folder into the new one.

---

## Using it

| What | How |
|---|---|
| Find an item | Left panel → «Resources»: type a name in English or Russian, or an ID. Words can be in any order. |
| Add a machine | Open an item → «Produced by» / «Consumed by» → drag a recipe onto the canvas, or click «To canvas». |
| Connect | Drag from an output port to an input port. Compatible ports light up. Drop on empty space to get a list of matching recipes. |
| Machines per node, tier | Select a node → right panel: count, machine tier (GT overclock is applied), cycles/min for special cases. |
| Split an output | Drag a second link from the same output and set a fixed share (e.g. 70%); the rest goes «auto» by demand. |
| Energy | Toggle «⚡ Energy», add a generator, connect its ⚡ to the ⚡ of machines, choose a cable and its length. |
| Line totals | Right panel → «Line balance»: what the whole line needs at full capacity vs. what it can make. «☰ Machine list» gives every machine, generator and cable, with a copy-as-text button. |
| **Blocks** | Select several nodes (Ctrl/Shift + click, or Shift + drag a frame) → «▦ Make block» (Ctrl+G). Links crossing the border become the block's inputs and outputs. Double-click a block to edit its inside, «⤴ Leave block» or Esc to go back. |
| Undo / save | Ctrl+Z / Ctrl+Y, Ctrl+S saves into `projects/`. «Export» downloads a file you can share. |

### How it calculates

- Machine speed is `count × 20 / ticks` cycles per second, with standard GT overclocking per tier
  above the recipe tier (duration ÷2, EU/t ×4; perfect: ÷4), never below 1 tick.
- A machine's load is the lowest «supplied / needed» over its inputs (and delivered energy).
  Chanced outputs use the expected average.
- **Loops** (e.g. Mg → Chemical Reactor → MgO → Electrolyzer → Mg) are solved in the steady state:
  the loop is already filled, as in the game after the first load. If a loop returns less than it
  takes (for example 2 cells in, 1 back), the planner says which path loses what, and the loop
  goes to exactly zero instead of showing tiny leftover numbers.
- **Blocks** are exact, not an estimate: the inside is solved with what really reaches the block's
  inputs. «Full capacity» shows what it would take and give with unlimited inputs.
- **Energy**: a generator gives up to `V × A × count` and burns fuel only for what is drawn. Power
  is delivered on demand, as in a GT network: a machine that is short of materials draws less, and
  the rest goes to the other machines. Only when the generators cannot cover what the machines ask
  for is the shortage shared in proportion. A cable loses `loss per block × length` EU per amp;
  warnings for burning cables and exploding machines.

Details about data sources and the models: [docs/DATA.md](docs/DATA.md).

### Recipe version

The recipes are the verified **GTNH 2.8.0** snapshot. No verifiable export exists for 2.8.4; the
planner shows the version and warns if your modpack differs. You can import your own export
(formats 5 and 7) or add corrections in «My recipes».

---

## For developers

- Python 3.9+ standard library only, no dependencies. Plain ES modules in the browser, no build step.
- `python planner.py --help` lists console options (`--port`, `--mc-dir`, `--no-browser`,
  `--fetch-data`, `--fetch-lang`, `--check`).
- Tests: `python -m unittest discover -s tests` (needs the recipe data) and `web/tests.html` in the
  running planner for the solver.
- Layout: `server/` (HTTP API, data adapter, setup, energy tables, names), `web/js/` (`solver.js` —
  calculations, `model.js` — schematic model, `canvas.js`, `props.js`, `i18n.js` — interface strings).

## Licenses and credits

- Planner code: **MIT** — see [LICENSE](LICENSE).
- Binary format layout ported from [ShadowTheAge/gtnh](https://github.com/ShadowTheAge/gtnh) (MIT, © 2025 ShadowTheAge).
- Recipe data, names and icons: [ShadowTheAge/gtnh-data](https://github.com/ShadowTheAge/gtnh-data).
  It has no license and belongs to Mojang, the GTNH team and mod authors, so it is **not included**
  here; the planner downloads it from the original repository on your computer.
- Russian names: [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations) (GPL-3.0), downloaded on demand.
- Cable table values: GregTech 5 Unofficial (GTNH team, LGPL-3.0).
- The screenshots in `docs/img` show item and machine icons from Minecraft, GregTech and other GTNH
  mods; those textures belong to their authors and are shown only to illustrate the planner.

Not affiliated with the GTNH team or Mojang.
