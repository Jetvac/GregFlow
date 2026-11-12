// Export the schematic as a PNG picture (for Discord, a wiki, notes). The visible level is
// drawn at full detail: the cards are copied into an SVG <foreignObject> with the page's own
// stylesheet, and only the icons actually used are cut out of the atlas into a small sheet.
import { $t } from './i18n.js';
import { esc } from './fmt.js';

const PAD = 30, HEAD = 46, CELL = 32, COLS = 16;

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error($t('Не удалось загрузить изображение'))); i.src = src; });
}

export async function exportPng(app) {
  const cv = app.canvas;
  const cards = [...cv.nlayer.querySelectorAll('.node')];
  if (!cards.length) throw new Error($t('Схема пуста — нечего сохранять'));
  // bounds in world coordinates: cards, link labels and link paths
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (a, b, c, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
  for (const el of cards) { const x = parseFloat(el.style.left), y = parseFloat(el.style.top); grow(x, y, x + el.offsetWidth, y + el.offsetHeight); }
  for (const el of cv.labels.children) { const x = parseFloat(el.style.left), y = parseFloat(el.style.top), w = el.offsetWidth / 2, h = el.offsetHeight / 2; grow(x - w, y - h, x + w, y + h); }
  try { const b = cv.elayer.getBBox(); if (b.width || b.height) grow(b.x, b.y, b.x + b.width, b.y + b.height); } catch { /* no links */ }
  const W = Math.ceil(x1 - x0 + PAD * 2), H = Math.ceil(y1 - y0 + PAD * 2 + HEAD);

  const world = cv.world.cloneNode(true);
  world.style.transform = `translate(${PAD - x0}px, ${PAD + HEAD - y0}px)`;
  world.querySelectorAll('path.hit').forEach(x => x.remove());
  world.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));

  // icons: copy the used atlas cells into one small sheet
  const sheets = new Map(), cells = new Map();
  const icons = [...world.querySelectorAll('.icon')].filter(i => i.style.backgroundImage);
  for (const i of icons) {
    const url = i.style.backgroundImage.replace(/^url\(["']?|["']?\)$/g, '');
    const key = url + '|' + i.style.backgroundPosition;
    if (!cells.has(key)) cells.set(key, { url, pos: i.style.backgroundPosition, n: cells.size });
    if (!sheets.has(url)) sheets.set(url, null);
  }
  for (const url of sheets.keys()) sheets.set(url, await loadImage(url));
  let sprite = '';
  if (cells.size) {
    const c = document.createElement('canvas');
    c.width = COLS * CELL; c.height = Math.ceil(cells.size / COLS) * CELL;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (const x of cells.values()) {
      const [px, py] = x.pos.split(' ').map(v => -parseFloat(v));
      g.drawImage(sheets.get(x.url), px, py, CELL, CELL, (x.n % COLS) * CELL, Math.floor(x.n / COLS) * CELL, CELL, CELL);
    }
    sprite = c.toDataURL('image/png');
    for (const i of icons) {
      const x = cells.get(i.style.backgroundImage.replace(/^url\(["']?|["']?\)$/g, '') + '|' + i.style.backgroundPosition);
      i.style.backgroundImage = '';
      i.style.backgroundPosition = `${-(x.n % COLS) * CELL}px ${-Math.floor(x.n / COLS) * CELL}px`;
      i.classList.add('xsprite');
    }
  }

  const css = await (await fetch('css/app.css')).text();
  const p = app.root;
  const crumbs = app.path.length ? ' › ' + esc(app.project.name || $t('Блок')) : '';
  const head = `<div class="xhead"><b>${esc(p.name)}</b>${crumbs}${p.demo ? ` <span class="badge demo">${$t('ДЕМО — условные значения источников')}</span>` : ''}<span class="xbrand">GregFlow · ${esc(p.dataset?.label || '')} · ${new Date().toISOString().slice(0, 10)}</span></div>`;
  const wrap = document.createElement('div');
  wrap.className = 'xroot';
  wrap.innerHTML = `<style>${css}
    .xroot { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; background: #1b1c1f; color: #e3e5e8; font: 13px/1.35 "Segoe UI", system-ui, sans-serif; }
    .xhead { position: absolute; left: ${PAD}px; right: ${PAD}px; top: 12px; font-size: 16px; display: flex; gap: 10px; align-items: center; }
    .xbrand { margin-left: auto; color: #9aa1ab; font-size: 12px; }
    .xsprite { background-image: url(${sprite}); }
  </style>${head}`;
  wrap.appendChild(world);
  const xhtml = new XMLSerializer().serializeToString(wrap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`;
  const name = (p.name || 'schematic').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  const scale = Math.max(0.25, Math.min(2, 16000 / W, 16000 / H, Math.sqrt(1.2e8 / (W * H))));
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  g.drawImage(img, 0, 0);
  let blob;
  try { blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/png')); }
  catch {
    // the browser refused to read back the drawing: save the SVG instead (opens in any browser)
    save(new Blob([svg], { type: 'image/svg+xml' }), name + '.svg');
    app.toast($t('Браузер не разрешил PNG — сохранено как SVG'));
    return;
  }
  save(blob, name + '.png');
  app.toast($t('Картинка схемы сохранена'));
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
