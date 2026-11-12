// Per-browser conveniences: recently opened and favourite resources, the node clipboard,
// edge label mode. Stored in localStorage; everything works without it.
const get = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const brief = g => ({ kind: g.kind || 'item', id: g.id, name: g.name, nameRu: g.nameRu, icon: g.icon });

const RECENT = 'gregflow-recent-goods', FAVS = 'gregflow-fav-goods', CLIP = 'gregflow-clipboard', LABELS = 'gregflow-edge-labels', ARM = 'gregflow-arm-slots';

export const prefs = {
  recent: () => get(RECENT, []),
  addRecent(g) {
    if (!g?.id) return;
    set(RECENT, [brief(g), ...this.recent().filter(x => x.id !== g.id)].slice(0, 12));
  },
  favs: () => get(FAVS, []),
  isFav(id) { return this.favs().some(x => x.id === id); },
  toggleFav(g) {
    const l = this.favs();
    set(FAVS, l.some(x => x.id === g.id) ? l.filter(x => x.id !== g.id) : [...l, brief(g)]);
  },
  clipboard: () => get(CLIP, null),
  setClipboard(c) { set(CLIP, c); },
  labels: () => get(LABELS, 'all'),
  setLabels(v) { set(LABELS, v); },
  armSlots: () => get(ARM, true),
  setArmSlots(v) { set(ARM, !!v); },
};
