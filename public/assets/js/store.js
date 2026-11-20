import { api } from './api.js';

const { reactive } = Vue;

export const store = reactive({
  user: null,
  dev: false,
  project: null,
  mentionables: { users: [], documents: [], bib: [] },
  counters: { notifications: 0, conversations: 0 },
  route: parseRoute(),
  toasts: [],
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
  return { name: 'projects', query };
}
window.addEventListener('hashchange', () => { store.route = parseRoute(); });

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
  } catch { /* ignore polling errors */ }
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
