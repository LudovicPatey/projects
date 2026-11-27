// Choosing one fact among hundreds: what the searchable fact picker shows and in what order. A project has hundreds of facts with
// long titles, too many for a dropdown, so the member types words of the label, the title or the statement instead. Without
// dependency on the browser, so that it can be tested.
import { foldText } from './util.js';
import { kindLabel, kindOf } from './fact-format.js';
import { STATUS_BADGE } from './fact-badges.js';

/** How many results the list shows at once: enough to browse, few enough to render their formulas at once. */
export const SHOWN = 40;

/** The words of a text, folded (no case, no accent), with LaTeX commands and braces read as separators: "\mathcal{F}" gives mathcal, f. */
export function words(text) {
  return foldText(String(text ?? '').replace(/[\\${}^_]/g, ' ')).split(/[^\p{L}\p{N}:.'-]+/u).map((w) => w.replace(/^[:.'-]+|[:.'-]+$/g, '')).filter(Boolean);
}

/** The terms of a query, folded the same way. */
export const terms = (query) => words(query);

const retracted = (f) => !!f.retracted_at || f.status === 'retracted';

/** Whether a fact may be offered: not excluded by id or by the caller's rule, and not retracted unless asked. */
export function allowed(f, { exclude = [], filter = null, withRetracted = false } = {}) {
  if (!f || exclude.includes(f.id)) return false;
  if (!withRetracted && retracted(f)) return false;
  return !filter || filter(f);
}

/**
 * How well a fact matches the terms, lower first; null when a term is missing. Every term must appear, as the start of a word, in
 * the label, the title, the kind or the statement. The label itself comes first, then a label that starts with the query, then
 * facts whose title holds every term, then those whose statement holds the rest.
 */
export function score(f, list) {
  if (!list.length) return 0;
  const label = foldText(f.label || '');
  const query = list.join(' ');
  const title = words(f.title);
  const head = [...words(f.label), ...title, ...words(kindLabel(kindOf(f)))];
  const body = words(f.statement_text);
  const has = (ws, t) => ws.some((w) => w.startsWith(t));
  let inTitle = true;
  for (const t of list) {
    if (has(head, t)) continue;
    inTitle = false;
    if (!has(body, t) && !label.includes(t)) return null;
  }
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  return inTitle ? 2 : 3;
}

/**
 * The facts to show for a query, best first, then in the caller's order (which can put the most likely choices first, such as cited
 * results). `found` are ids the server found in the full statements, which the page may only hold the start of: they come after the
 * local matches. Returns the facts to show, how many match in all, and whether some are left out.
 */
export function searchFacts(facts, query, options = {}) {
  const list = terms(query);
  const ok = (facts || []).filter((f) => allowed(f, options));
  const ranked = [];
  ok.forEach((f, i) => { const s = score(f, list); if (s !== null) ranked.push([s, i, f]); });
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const seen = new Set(ranked.map((r) => r[2].id));
  const byId = new Map(ok.map((f) => [f.id, f]));
  for (const id of options.found || []) if (!seen.has(id) && byId.has(id)) { seen.add(id); ranked.push([4, 0, byId.get(id)]); }
  const limit = options.limit ?? SHOWN;
  return { items: ranked.slice(0, limit).map((r) => r[2]), total: ranked.length, more: ranked.length > limit, of: ok.length };
}

/** Whether a query is worth asking the server, which reads the whole statements: two letters at least, the page's facts loaded. */
export const asksServer = (query) => terms(query).join('').length >= 2;

/** The ids of the facts a search of the server (`/refs?type=fact`) returned. */
export const serverIds = (results) => (results || []).filter((r) => r.type === 'fact' && r.state !== 'missing').map((r) => +r.id);

/** What one result says: its title first, then its kind, its label and its state, the state as an icon with its word. */
export function describe(f) {
  const s = STATUS_BADGE[f.status] || null;
  return {
    title: f.title || f.label || `Fact #${f.id}`,
    kind: kindLabel(kindOf(f)),
    label: f.label || '',
    cited: f.basis === 'cited',
    status: s ? { icon: s.icon, tone: s.tone, word: s.label, title: s.title } : null,
  };
}

/** The line under the list: how many facts match and how to see the others. */
export function countLine({ items, total, of }, query) {
  if (!of) return 'No fact to choose from yet.';
  if (!total) return `No fact matches “${query.trim()}”. Try a label such as lem:2.3, or other words of the statement.`;
  if (total > items.length) return `${items.length} of ${total} facts shown: type more words to narrow the list.`;
  return terms(query).length ? `${total} matching fact${total === 1 ? '' : 's'}.` : `${total} fact${total === 1 ? '' : 's'}.`;
}

/** The row the keyboard moves to: down and up wrap around, Home and End go to the ends; -1 when the list is empty. */
export function moveActive(index, key, n) {
  if (!n) return -1;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % n;
  if (key === 'ArrowUp') return index < 0 ? n - 1 : (index - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return Math.min(index, n - 1);
}

/**
 * Where the list opens, fixed so that no scrolling column or dialog cuts it: under the field, or above it when there is more room
 * there, as wide as the field but inside the main area (`area`, the window by default) with a margin, and no taller than the room left.
 */
export function placeList(field, win, { margin = 8, want = 360, area = { left: 0, right: win.width } } = {}) {
  const room = area.right - area.left - 2 * margin;
  const width = Math.min(Math.max(field.width, Math.min(320, room)), room);
  const left = Math.max(area.left + margin, Math.min(field.left, area.right - width - margin));
  const below = win.height - field.bottom - margin - 4;
  const above = field.top - margin - 4;
  const up = below < Math.min(want, 220) && above > below;
  const maxHeight = Math.max(120, Math.min(want, up ? above : below));
  return up ? { left, width, bottom: win.height - field.top + 4, maxHeight } : { left, width, top: field.bottom + 4, maxHeight };
}
