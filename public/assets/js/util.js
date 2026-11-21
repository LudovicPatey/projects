export function parseDate(s) {
  if (!s) return null;
  return new Date(s.replace(' ', 'T') + 'Z');
}

export function timeAgo(s) {
  const d = parseDate(s);
  if (!d) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' d ago';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fullDate(s) {
  const d = parseDate(s);
  if (!d) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Generation time: 850 ms, 12.4 s, 3 min 05 s, 2 h 10 min. */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const n = +ms;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} s`;
  if (n < 3600000) return `${Math.floor(n / 60000)} min ${String(Math.floor(n / 1000) % 60).padStart(2, '0')} s`;
  return `${Math.floor(n / 3600000)} h ${String(Math.floor(n / 60000) % 60).padStart(2, '0')} min`;
}

export function fileSize(n) {
  n = +n || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function initials(name) {
  const parts = String(name || '?').replace(/[^\p{L}\s-]/gu, '').trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function colorFor(id) {
  const hue = ((+id || 0) * 47 + 200) % 360;
  return `hsl(${hue} 55% 45%)`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const TEXT_EXT = ['tex', 'bib', 'sty', 'cls', 'bst', 'txt', 'md', 'py', 'sage', 'm', 'jl', 'json', 'csv', 'log', 'bbl', 'gp', 'mpl', 'lean', 'v', 'thy', 'hs'];
export function isTextFile(name) {
  return TEXT_EXT.includes(String(name).split('.').pop().toLowerCase());
}
