// Small layout helpers shared by the side panel and the windows: tabs, collapsible cards,
// toolbar drop-down menus and draggable windows. Remembered choices live in localStorage.
import { esc } from './fmt.js';

const TABS = 'gregflow-tabs', FOLD = 'gregflow-folded';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const getTab = (key, def) => load(TABS, {})[key] ?? def;
export function setTab(key, id) { const t = load(TABS, {}); t[key] = id; save(TABS, t); }

/**
 * Tab bar plus all panes (only the active one visible).
 * tabs: [{id, label, badge?, badgeKind?, html, title?}]
 */
export function tabsHtml(key, tabs, def = tabs[0]?.id) {
  let cur = getTab(key, def);
  if (!tabs.some(t => t.id === cur)) cur = def;
  return `<nav class="tabbar" data-tabs="${esc(key)}" role="tablist">${tabs.map(t => `<button role="tab" data-tab="${esc(t.id)}" class="${t.id === cur ? 'on' : ''}" ${t.title ? `title="${esc(t.title)}"` : ''}>${t.label}${t.badge != null && t.badge !== '' ? ` <span class="tcount ${t.badgeKind || ''}">${t.badge}</span>` : ''}</button>`).join('')}</nav>
    ${tabs.map(t => `<div class="tabpane" data-pane="${esc(t.id)}" ${t.id === cur ? '' : 'hidden'}>${t.html}</div>`).join('')}`;
}

function switchTab(bar, id) {
  const key = bar.dataset.tabs;
  setTab(key, id);
  for (const b of bar.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === id);
  for (const p of bar.parentElement.querySelectorAll(':scope > .tabpane')) p.hidden = p.dataset.pane !== id;
}

/** Open a tab of a rendered tab bar (e.g. "Problems" from the toolbar badge). */
export function openTab(root, key, id) {
  setTab(key, id);
  const bar = root.querySelector(`[data-tabs="${key}"]`);
  if (bar) switchTab(bar, id);
}

const foldKey = h => h.dataset.k || h.textContent.replace(/[\d\s().,:?]+/g, ' ').trim();

/** Wrap every h4 and what follows it (up to the next h4) into a card; a click on the heading folds it. */
export function cardify(root) {
  const folded = new Set(load(FOLD, []));
  for (const host of [root, ...root.querySelectorAll('.tabpane')]) {
    const heads = [...host.children].filter(c => c.tagName === 'H4');
    for (const h of heads) {
      const sec = document.createElement('section');
      sec.className = 'card';
      h.before(sec);
      const body = document.createElement('div');
      body.className = 'cbody2';
      let n = h.nextSibling;
      while (n && !(n.nodeType === 1 && (n.tagName === 'H4' || n.classList.contains('tabpane') || n.classList.contains('tabbar') || n.classList.contains('foot')))) {
        const next = n.nextSibling;
        body.appendChild(n);
        n = next;
      }
      sec.append(h, body);
      h.classList.add('chead');
      h.tabIndex = 0;
      if (folded.has(foldKey(h))) sec.classList.add('folded');
    }
  }
}

function toggleCard(h) {
  const sec = h.closest('section.card');
  sec.classList.toggle('folded');
  const f = new Set(load(FOLD, []));
  const k = foldKey(h);
  if (sec.classList.contains('folded')) f.add(k); else f.delete(k);
  save(FOLD, [...f]);
}

/** Make a window movable by its title (the first h3). */
export function draggable(modal) {
  const h = modal.querySelector(':scope > h3');
  if (!h) return;
  h.classList.add('mdrag');
  let dx = 0, dy = 0;
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const sx = e.clientX - dx, sy = e.clientY - dy;
    h.setPointerCapture(e.pointerId);
    const mv = ev => { dx = ev.clientX - sx; dy = ev.clientY - sy; modal.style.translate = `${dx}px ${dy}px`; };
    const up = () => { h.removeEventListener('pointermove', mv); h.removeEventListener('pointerup', up); };
    h.addEventListener('pointermove', mv);
    h.addEventListener('pointerup', up);
  });
}

function closeMenus(except) {
  for (const m of document.querySelectorAll('.menu.open')) if (m !== except) m.classList.remove('open');
}

let bound = false;
/** One set of document listeners for tabs, cards and menus, wherever they are rendered. */
export function bindUi() {
  if (bound) return;
  bound = true;
  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { switchTab(tab.closest('[data-tabs]'), tab.dataset.tab); return; }
    const head = e.target.closest('h4.chead');
    if (head && !e.target.closest('.qhelp,a,button,input,select')) { toggleCard(head); return; }
    const mb = e.target.closest('[data-menu]');
    if (mb) { const m = mb.closest('.menu'); closeMenus(m); m.classList.toggle('open'); return; }
    // an item was picked, or the click went elsewhere: close (the view menu stays open while its fields are used)
    if (e.target.closest('.mpop') && !e.target.closest('[data-tb]')) return;
    closeMenus();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenus();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('h4.chead')) { e.preventDefault(); toggleCard(e.target); }
  });
}
