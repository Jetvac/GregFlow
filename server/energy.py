"""Energy data: cables, generators and fuels.

Cables - read from the GregTech jar of the installation (read-only): the
WireCableBuilder calls in gregtech/loaders/preload/LoaderMetaPipeEntities.class
give per material: voltage tier, amperage of a 1x wire, loss per block for
insulated cables (lossCable) and bare wires (lossWire). The class bytecode is
decoded, not executed. The result is cached in data/energy/cables.json together
with the jar name and its SHA-256, so it also works without the installation.
Cable/wire items themselves (name, size "Nx", icon) come from the recipe export.

Generators - GregTech items whose export tooltip contains "Voltage OUT" (voltage,
"Fuel Efficiency: N%", steam consumption). Fuel recipes - recipe maps whose
crafters are those generators; fuel_value is taken from the recipe metadata.
"""
from __future__ import annotations

import glob
import hashlib
import html
import json
import os
import re
import struct
import time
import zipfile

TIER_NAMES = ['ULV', 'LV', 'MV', 'HV', 'EV', 'IV', 'LuV', 'ZPM', 'UV', 'UHV', 'UEV', 'UIV', 'UMV', 'UXV', 'MAX']
LOADER = 'gregtech/loaders/preload/LoaderMetaPipeEntities.class'
BUILDER = 'gregtech/loaders/preload/LoaderMetaPipeEntities$WireCableBuilder.class'
EXTRACTOR_VERSION = 1


def tier_voltage(name: str) -> int:
    return 8 * 4 ** TIER_NAMES.index(name)


# ------------------------------------------------------------ class file reader
def _parse_class(b: bytes):
    i = 8
    n = struct.unpack('>H', b[i:i + 2])[0]; i += 2
    cp = [None] * n; k = 1
    while k < n:
        t = b[i]; i += 1
        if t == 1:
            ln = struct.unpack('>H', b[i:i + 2])[0]; cp[k] = ('utf8', b[i + 2:i + 2 + ln].decode('utf8', 'replace')); i += 2 + ln
        elif t == 3:
            cp[k] = ('int', struct.unpack('>i', b[i:i + 4])[0]); i += 4
        elif t == 4:
            cp[k] = ('float', struct.unpack('>f', b[i:i + 4])[0]); i += 4
        elif t == 5:
            cp[k] = ('long', struct.unpack('>q', b[i:i + 8])[0]); i += 8; k += 1
        elif t == 6:
            cp[k] = ('double', struct.unpack('>d', b[i:i + 8])[0]); i += 8; k += 1
        elif t in (7, 8, 16):
            cp[k] = (t, struct.unpack('>H', b[i:i + 2])[0]); i += 2
        elif t in (9, 10, 11, 12, 18):
            cp[k] = (t,) + struct.unpack('>HH', b[i:i + 4]); i += 4
        elif t == 15:
            cp[k] = (t, b[i], struct.unpack('>H', b[i + 1:i + 3])[0]); i += 3
        else:
            raise ValueError('constant pool tag %d' % t)
        k += 1
    u = lambda x: cp[x][1]
    i += 6
    ni = struct.unpack('>H', b[i:i + 2])[0]; i += 2 + 2 * ni

    def members(i):
        out = []
        cnt = struct.unpack('>H', b[i:i + 2])[0]; i += 2
        for _ in range(cnt):
            _, nm, ds, ac = struct.unpack('>HHHH', b[i:i + 8]); i += 8
            codes = []
            for _ in range(ac):
                an, al = struct.unpack('>HI', b[i:i + 6])
                if u(an) == 'Code':
                    c = b[i + 6:i + 6 + al]
                    codes.append(c[8:8 + struct.unpack('>I', c[4:8])[0]])
                i += 6 + al
            out.append((u(nm), u(ds), codes))
        return i, out

    i, _ = members(i)
    i, methods = members(i)

    def ref(x):
        _, c, nt = cp[x]
        _, nm, ds = cp[nt]
        return u(cp[c][1]), u(nm), u(ds)
    return cp, ref, methods


_LEN = {}
for _op in list(range(0, 16)) + list(range(26, 54)) + list(range(59, 132)) + list(range(133, 153)) + list(range(172, 178)) + [190, 191, 194, 195]:
    _LEN[_op] = 1
for _op in (16, 18) + tuple(range(21, 26)) + tuple(range(54, 59)) + (169, 188):
    _LEN[_op] = 2
for _op in (17, 19, 20, 132) + tuple(range(153, 169)) + (178, 179, 180, 181, 182, 183, 184, 187, 189, 192, 193, 198, 199):
    _LEN[_op] = 3
_LEN.update({185: 5, 186: 5, 197: 4, 200: 5, 201: 5})


def _instrs(code):
    pc = 0
    while pc < len(code):
        op = code[pc]
        if op == 170:  # tableswitch
            p = (pc + 4) & ~3; lo, hi = struct.unpack('>ii', code[p + 4:p + 12]); pc = p + 12 + 4 * (hi - lo + 1); continue
        if op == 171:  # lookupswitch
            p = (pc + 4) & ~3; npairs = struct.unpack('>i', code[p + 4:p + 8])[0]; pc = p + 8 + 8 * npairs; continue
        if op == 196:  # wide
            pc += 6 if code[pc + 1] == 132 else 4; continue
        ln = _LEN.get(op, 1)
        yield op, code[pc + 1:pc + ln]
        pc += ln


def extract_cables(jar_path: str) -> list[dict]:
    """Decode WireCableBuilder chains: material, startId, losses, amperage, voltage."""
    with zipfile.ZipFile(jar_path) as z:
        bb = z.read(BUILDER)
        bl = z.read(LOADER)
    cp, ref, methods = _parse_class(bb)
    acc = {}
    for nm, ds, codes in methods:  # synthetic accessors access$NNN -> builder member
        if nm.startswith('access$') and codes:
            for op, a in _instrs(codes[0]):
                if op in (180, 181, 182, 183, 184):
                    acc[nm] = ref(struct.unpack('>H', a[:2])[0])[1]
                    break
    cp, ref, methods = _parse_class(bl)
    recs = []
    for nm, ds, codes in methods:
        for code in codes:
            st, cur = [], None
            for op, a in _instrs(code):
                if 2 <= op <= 8:
                    st.append(op - 3)
                elif op in (9, 10):
                    st.append(op - 9)
                elif op == 16:
                    st.append(struct.unpack('>b', a)[0])
                elif op == 17:
                    st.append(struct.unpack('>h', a)[0])
                elif op in (18, 19, 20):
                    e = cp[a[0] if op == 18 else struct.unpack('>H', a)[0]]
                    st.append(e[1] if e[0] in ('int', 'long', 'float', 'double') else None)
                elif op == 178:
                    cls, n2, _ = ref(struct.unpack('>H', a)[0])
                    st.append((cls.split('/')[-1], n2))
                elif op in (182, 183, 184):
                    cls, n2, d2 = ref(struct.unpack('>H', a)[0])
                    if cls.endswith('WireCableBuilder'):
                        f = acc.get(n2, n2)
                        args = d2[1:d2.index(')')]
                        if f == 'builder':
                            cur = {}
                        elif f == 'build':
                            if cur is not None:
                                recs.append(cur)
                            cur = None
                        elif cur is not None:
                            v = st[-1] if st else None
                            if isinstance(v, tuple) and v[0] == 'TierEU':
                                v = v[1]
                            elif isinstance(v, tuple):
                                v = v[1]
                            has_arg = args.count(';') + len(re.sub(r'L[^;]*;', '', args)) > 1
                            cur[f] = v if has_arg else True
                    st = []
                elif op != 89:  # keep stack across dup
                    st = []
    out = []
    for r in recs:
        if not isinstance(r.get('voltage'), str) or r['voltage'] not in TIER_NAMES or not isinstance(r.get('startId'), int):
            continue
        out.append({
            'material': r.get('material'), 'startId': r['startId'], 'tier': r['voltage'],
            'voltage': tier_voltage(r['voltage']), 'amperage': r.get('amperage'),
            'lossCable': r.get('lossCable'), 'lossWire': r.get('lossWire'),
            'wireOnly': bool(r.get('disableCable')),
        })
    return out


def cable_table(data_dir: str, install: str | None) -> dict:
    cache = os.path.join(data_dir, 'energy', 'cables.json')
    cached = None
    if os.path.isfile(cache):
        with open(cache, encoding='utf-8') as f:
            cached = json.load(f)
    jar = None
    if install:
        jars = sorted(glob.glob(os.path.join(install, 'mods', 'gregtech-*.jar')))
        jar = jars[-1] if jars else None
    if jar:
        sha = hashlib.sha256(open(jar, 'rb').read()).hexdigest()
        if cached and cached.get('jarSha256') == sha and cached.get('extractor') == EXTRACTOR_VERSION:
            return cached
        try:
            recs = extract_cables(jar)
        except Exception as e:  # pragma: no cover - unexpected jar layout
            if cached:
                return cached
            return {'records': [], 'error': f'Не удалось прочитать кабели из {os.path.basename(jar)}: {e!r}'}
        data = {'records': recs, 'jar': os.path.basename(jar), 'jarSha256': sha, 'extractor': EXTRACTOR_VERSION,
                'class': LOADER, 'extractedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        try:
            os.makedirs(os.path.dirname(cache), exist_ok=True)
            with open(cache, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
        except OSError:
            pass
        return data
    return cached or {'records': [], 'error': 'Таблица кабелей не найдена: нужен gregtech-*.jar установки (только чтение).'}


def cable_options(table: dict, cat) -> list[dict]:
    """Concrete wire/cable items: base data from the jar, size and name from the export."""
    out = []
    if cat is None:
        return out
    for r in table.get('records', []):
        for off in range(0, 12):
            gid = f"i:gregtech:gt.blockmachines:{r['startId'] + off}"
            p = cat.pos.get(gid)
            if p is None:
                continue
            g = cat.goods_brief(p, 'item')
            u = cat.string(cat.el[p + 11]) or ''
            m = re.match(r'^(\d+)x\b', g['name'] or '')
            if not m or not (u.startswith('gt.blockmachines.wire.') or u.startswith('gt.blockmachines.cable.')):
                continue
            size = int(m.group(1))
            insulated = u.startswith('gt.blockmachines.cable.')
            loss = r['lossCable'] if insulated else r['lossWire']
            if loss is None or r['amperage'] is None:
                continue
            out.append({**g, 'material': r['material'], 'insulated': insulated, 'size': size,
                        'tier': r['tier'], 'voltage': r['voltage'], 'amps': r['amperage'] * size,
                        'loss': loss})
    out.sort(key=lambda c: (c['voltage'], c['material'] or '', not c['insulated'], c['size']))
    return out


# ------------------------------------------------------------ generators & fuels
def _tooltip_text(t: str | None) -> str:
    if not t:
        return ''
    t = re.sub(r'<br\s*/?>', '\n', t)
    return html.unescape(re.sub(r'<[^>]+>', '', t))


def _int(s):
    return int(s.replace(',', '').replace(' ', ''))


def generators(cat) -> list[dict]:
    if cat is None:
        return []
    el = cat.el
    crafter_maps: dict[int, list[str]] = {}
    for tp in cat.recipe_types:
        for slot in (3, 5):
            for ip in cat.slice(el[tp + slot]):
                crafter_maps.setdefault(ip, []).append(cat.type_names[tp])
    out = []
    for p in cat.items:
        tt = _tooltip_text(cat.tooltip(p))
        m = re.search(r'Voltage OUT:\s*([\d,]+)', tt)
        if not m:
            continue
        g = cat.goods_brief(p, 'item')
        v = _int(m.group(1))
        tier = next((n for n in TIER_NAMES if tier_voltage(n) == v), None)
        eff = re.search(r'Fuel Efficiency:\s*(\d+)\s*%', tt)
        steam = re.search(r'Consumes up to ([\d,]+)\s*L of ([A-Za-z ]+?) per second', tt)
        maps = [x for x in crafter_maps.get(p, []) if 'Boiler' not in x]
        if not (maps or eff or steam):
            continue  # transformers, diodes, buffers also have "Voltage OUT"
        d = {**g, 'voltage': v, 'tier': tier, 'efficiency': int(eff.group(1)) if eff else None,
             'fuelMaps': maps, 'tooltip': tt.strip()}
        if steam:
            fl = steam.group(2).strip()
            fp = next((q for q in cat.fluids if (cat.string(el[q + 5]) or '') == fl), None)
            d['steam'] = {'perSecond': _int(steam.group(1)), 'fluidName': fl,
                          'res': cat.goods_brief(fp, 'fluid') if fp is not None else None}
        out.append(d)
    out.sort(key=lambda d: (d['voltage'], d['name'] or ''))
    return out


def fuel_maps(cat, gen_maps=()) -> list[dict]:
    if cat is None:
        return []
    el = cat.el
    out = []
    gen_maps = set(gen_maps)
    for tp, name in cat.type_names.items():
        if 'Boiler' in (name or ''):
            continue
        rs = cat.recipes_by_type.get(tp, [])
        if not rs:
            continue
        r0 = cat.recipe(cat.string(el[rs[0] + 4]), full=False)
        md = {x['key'] for x in (r0.get('gt') or {}).get('metadata', [])}
        if 'fuel_value' in md or name in gen_maps:
            out.append({'name': name, 'nameRu': cat.machines_ru.get(name), 'recipes': len(rs)})
    out.sort(key=lambda m: m['name'])
    return out


def fuels(cat, map_name: str) -> list[dict]:
    """Fuel options of a recipe map, normalized to 'EU per unit of resource'."""
    res = cat.recipes_of_machine(map_name, 0, 100000)
    out = []
    for r in res['recipes']:
        gt = r.get('gt') or {}
        fv = next((x['value'] for x in gt.get('metadata', []) if x['key'] == 'fuel_value'), None)
        if fv is None:
            fv = gt.get('specialValue')
        ins = [e for e in r['inputs'] if e.get('consumed', True) and e['kind'] != 'oredict']
        if len(ins) != 1 or fv is None:
            continue
        e = ins[0]
        opt = {'recipeId': r['id'], 'map': map_name, 'fuelValue': fv, 'input': {k: e.get(k) for k in ('kind', 'id', 'name', 'nameRu', 'icon', 'amount')}}
        if e['kind'] == 'fluid':
            opt.update(res={k: e.get(k) for k in ('kind', 'id', 'name', 'nameRu', 'icon')}, euPerUnit=fv, rule='fluid', outputs=[])
        else:
            g = cat.goods(e['id']) or {}
            c = g.get('container')
            if c and c.get('fluid') and cat.pos.get(c['fluid']) is not None:
                fb = cat.goods_brief(cat.pos[c['fluid']], 'fluid')
                opt.update(res={k: fb.get(k) for k in ('kind', 'id', 'name', 'nameRu', 'icon')}, euPerUnit=fv, rule='cell',
                           cellAmount=c.get('amount'), outputs=[])
            else:
                amt = max(1, e.get('amount') or 1)
                opt.update(res={k: e.get(k) for k in ('kind', 'id', 'name', 'nameRu', 'icon')}, euPerUnit=None, rule='item',
                           outputs=[{'res': {k: o.get(k) for k in ('kind', 'id', 'name', 'nameRu', 'icon')},
                                     'perUnit': (o.get('amount') or 0) * (o.get('probability') or 1) / amt}
                                    for o in r['outputs']])
        out.append(opt)
    out.sort(key=lambda o: -(o['fuelValue'] or 0))
    return out


def load(data_dir: str, install: str | None, cat) -> dict:
    table = cable_table(data_dir, install)
    gens = generators(cat)
    return {
        'cables': cable_options(table, cat),
        'cableSource': {k: table.get(k) for k in ('jar', 'jarSha256', 'class', 'extractedAt', 'error')},
        'generators': gens,
        'fuelMaps': fuel_maps(cat, [m for g in gens for m in g['fuelMaps']]),
    }
