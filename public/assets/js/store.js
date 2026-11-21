import { api } from './api.js';

const { reactive } = Vue;

const keepUnread = new Set();
const pendingReads = new Map();
const onScreen = new Map();
let readTimer = null;

export const store = reactive({
  user: null,
  dev: false,
  project: null,
  mentionables: { users: [], documents: [], bib: [], facts: [], questions: [], strategies: [] },
  counters: { notifications: 0, conversations: 0, totals: {}, unread: {} },
  route: parseRoute(),
  toasts: [],
  toursSeen: [],
  tourRequest: null,
});

// ---------- routing (hash based: #/p/3/files/12?v=40) ----------
export function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  if (parts[0] === 'p' && parts[1]) {
    return { name: 'project', pid: +parts[1], view: parts[2] || 'overview', id: parts[3] ? +parts[3] : null, query };
  }
  if (parts[0] === 'profile') return { name: 'profile', query };
  if (parts[0] === 'help') return { name: 'help', query };
  return { name: 'projects', query };
}
window.addEventListener('hashchange', () => {
  // Leaving an item within a moment does not count as having read it.
  keepUnread.clear(); onScreen.clear(); pendingReads.clear();
  store.route = parseRoute();
});

export function go(path) { location.hash = '#' + path; }

export function link(view, id = null, query = null) {
  const pid = store.project?.id ?? store.route.pid;
  let s = `#/p/${pid}/${view}` + (id ? `/${id}` : '');
  if (query) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    if ([...q].length) s += '?' + q;
  }
  return s;
}

// ---------- project data ----------
export async function loadProject(pid) {
  const [p, m] = await Promise.all([api.get(`api/projects/${pid}`), api.get(`api/projects/${pid}/mentionables`)]);
  store.project = p;
  store.mentionables = m;
}

export async function refreshProject() {
  if (store.project) store.project = await api.get(`api/projects/${store.project.id}`);
}

export async function refreshMentionables() {
  if (store.project) store.mentionables = await api.get(`api/projects/${store.project.id}/mentionables`);
}

export async function refreshCounters() {
  if (!store.user) return;
  try {
    store.counters = await api.get('api/counters' + (store.project ? `?project=${store.project.id}` : ''));
    queueReads();
  } catch { /* ignore polling errors */ }
}

// ---------- per-user read state ----------
export function unreadCount(type, id) { return store.counters.unread?.[type]?.[id] || 0; }

/** An item counts as read once it has stayed on screen for a moment, in a visible tab. */
export function markRead(type, id, upTo) {
  if (!store.project) return;
  const key = `${type}:${id}`;
  if (onScreen.get(key)?.up_to !== upTo) onScreen.set(key, { type, id, up_to: upTo, sent: false });
  queueReads();
}

/** Also runs after each counter refresh: an item may be displayed before its badge is known. */
function queueReads() {
  for (const [key, v] of onScreen) {
    if (v.sent || keepUnread.has(key) || !unreadCount(v.type, v.id)) continue;
    pendingReads.set(key, v);
    clearTimeout(readTimer);
    readTimer = setTimeout(flushReads, 1200);
  }
}

async function flushReads() {
  if (document.visibilityState !== 'visible' || !pendingReads.size || !store.project) return;
  const items = [...pendingReads.values()].map((v) => { v.sent = true; return { type: v.type, id: v.id, up_to: v.up_to }; });
  pendingReads.clear();
  try { await api.post(`api/projects/${store.project.id}/read`, { items }); } catch { /* retried on the next view */ }
  refreshCounters();
}
document.addEventListener('visibilitychange', flushReads);

export async function markItemUnread(type, id) {
  const key = `${type}:${id}`;
  pendingReads.delete(key);
  keepUnread.add(key);
  await attempt(() => api.post(`api/projects/${store.project.id}/unread`, { type, item_id: id }), 'Marked as unread');
  await refreshCounters();
}

export async function markAllRead(type) {
  pendingReads.clear();
  keepUnread.clear();
  await attempt(() => api.post(`api/projects/${store.project.id}/read-all`, { type }));
  await refreshCounters();
}

// ---------- toasts ----------
let toastId = 0;
export function toast(message, type = 'info') {
  const id = ++toastId;
  store.toasts.push({ id, message, type });
  setTimeout(() => { store.toasts = store.toasts.filter((t) => t.id !== id); }, type === 'error' ? 6000 : 3000);
}

/** Wraps an async action and reports errors as toasts. */
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success, 'success');
    return r;
  } catch (e) {
    toast(e.message || String(e), 'error');
    return undefined;
  }
}
