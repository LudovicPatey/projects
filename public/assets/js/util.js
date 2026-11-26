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

/**
 * When a researcher became a member, in words that say who did what: the creator of the project created it; an owner adds the
 * others by ORCID iD, and they sign in later, or never. When a member first signed in is not said: the platform did not record it
 * for those who signed in before 26 November 2026, and their next sign-in would read as a first one.
 */
export function memberSince(m) {
  if (!parseDate(m?.joined_at)) return '';
  if (m.created_project) return `created the project ${timeAgo(m.joined_at)}`;
  return m.has_logged_in ? `added ${timeAgo(m.joined_at)}` : `added ${timeAgo(m.joined_at)}, has not signed in yet`;
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

const FOLD = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', ħ: 'h', ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', '–': '-', '—': '-', '−': '-', '‐': '-', '’': "'", '‘': "'", '“': '"', '”': '"' };

/** Lower case without accents, as the server compares text in a search. */
export function foldText(s) {
  return [...String(s ?? '').toLowerCase()].map((c) => FOLD[c] ?? c.normalize('NFD').replace(/\p{M}/gu, '')).join('');
}

/** Wraps the search terms found in the text of an element, outside rendered formulas. */
export function markTerms(root, terms) {
  if (!terms?.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('.katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const chars = [...node.textContent];
    let folded = '';
    const at = [];
    chars.forEach((c, i) => { const f = foldText(c); for (let k = 0; k < f.length; k++) at.push(i); folded += f; });
    const ranges = [];
    for (const t of terms) {
      for (let p = folded.indexOf(t); p >= 0; p = folded.indexOf(t, p + t.length)) ranges.push([at[p], at[p + t.length - 1] + 1]);
    }
    if (!ranges.length) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
    }
    const out = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos) out.append(chars.slice(pos, a).join(''));
      const m = document.createElement('mark');
      m.textContent = chars.slice(a, b).join('');
      out.append(m);
      pos = b;
    }
    if (pos < chars.length) out.append(chars.slice(pos).join(''));
    node.replaceWith(out);
  }
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
