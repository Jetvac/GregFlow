"""Extract item slot counts of GregTech single-block machines from the GT5-Unofficial source.

Robot arm covers address a machine's inventory by number: arm slot N = inventory slot N - 1
(0 = any slot). In GT basic machines (MTEBasicMachine) inventory slots 0-4 are service slots,
inputs start at 5 and outputs at 5 + the machine's input slot count. The input slot count is a
constructor argument of each registered machine, so it is read from the source here.

Usage:
    python scripts/gt_machine_slots.py <path to GT5-Unofficial checkout> <tag> > data/gt-machine-slots.json

Only registrations whose ID, input and output counts are plain literals or enum IDs are taken;
anything computed at runtime is skipped (the planner then shows no output slot numbers for it).
"""
import json
import os
import re
import sys

CTOR = "new MTEBasicMachineWithRecipe("


def args_of(text, start):
    """Top-level comma-separated arguments of the call whose '(' is at text[start-1]."""
    depth, cur, out, i, q = 0, [], [], start, None
    while i < len(text):
        c = text[i]
        if q:
            cur.append(c)
            if c == "\\":
                cur.append(text[i + 1]); i += 1
            elif c == q:
                q = None
        elif c in "\"'":
            q = c; cur.append(c)
        elif c in "([{":
            depth += 1; cur.append(c)
        elif c in ")]}":
            if depth == 0:
                out.append("".join(cur).strip())
                return out
            depth -= 1; cur.append(c)
        elif c == "," and depth == 0:
            out.append("".join(cur).strip()); cur = []
        else:
            cur.append(c)
        i += 1
    return None


def enum_ids(root):
    """MetaTileEntityIDs enum: NAME(1234) -> 1234."""
    ids = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f == "MetaTileEntityIDs.java":
                t = open(os.path.join(dp, f), encoding="utf-8").read()
                for m in re.finditer(r"^\s*([A-Za-z0-9_]+)\((\d+)\)\s*[,;]", t, re.M):
                    ids[m.group(1)] = int(m.group(2))
    return ids


def main(repo, tag):
    src = os.path.join(repo, "src", "main", "java")
    ids = enum_ids(src)
    machines, skipped = {}, 0
    for dp, _, fs in os.walk(src):
        for f in fs:
            if not f.endswith(".java"):
                continue
            path = os.path.join(dp, f)
            t = open(path, encoding="utf-8").read()
            for m in re.finditer(re.escape(CTOR), t):
                a = args_of(t, m.end())
                if not a or len(a) < 8:
                    skipped += 1; continue
                idm = re.fullmatch(r"(?:MetaTileEntityIDs\.)?([A-Za-z0-9_]+)\.ID|(\d+)", a[0])
                name = re.fullmatch(r'"([^"]*)"', a[2])
                ins, outs = a[6], a[7]
                if not idm or not re.fullmatch(r"\d+", ins) or not re.fullmatch(r"\d+", outs):
                    skipped += 1; continue
                mid = int(idm.group(2)) if idm.group(2) else ids.get(idm.group(1))
                if mid is None:
                    skipped += 1; continue
                machines[str(mid)] = {
                    "name": name.group(1) if name else None,
                    "tier": int(a[3]) if re.fullmatch(r"\d+", a[3]) else None,
                    "inputs": int(ins), "outputs": int(outs),
                    "file": os.path.relpath(path, repo).replace("\\", "/"),
                }
    print(json.dumps({
        "source": "https://github.com/GTNewHorizons/GT5-Unofficial",
        "tag": tag,
        "license": "LGPL-3.0 (GT5-Unofficial); only slot counts are taken",
        "note": "Key: gt.blockmachines meta ID. Arm slot = inventory slot + 1; inputs start at inventory slot 5, outputs at 5 + inputs (MTEBasicMachine.OTHER_SLOT_COUNT = 5).",
        "otherSlotCount": 5,
        "skipped": skipped,
        "machines": dict(sorted(machines.items(), key=lambda kv: int(kv[0]))),
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
