// The client protocol: what the AI client (client/oq.py) relies on in the server, as a fingerprint.
// Any change to it must be recorded as compatible or breaking (scripts/client-protocol.mjs).
// Pure functions over file contents, tested in tests/client-protocol.test.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RECORD = 'protocol/client-protocol.json';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SEGMENT = String.raw`(?:[\w.-]+|\{[^}"\n]*\})`;

/** Normalizes a path: every parameter becomes {}. */
export const normalizePath = (p) => String(p).split('?')[0].replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '');

/** The API paths the client builds, including `url + "/complete"` from `url = f"/api/ai/tasks/{...}"`. */
export function clientPaths(py) {
  const found = new Set();
  const re = new RegExp(String.raw`/api(?:/${SEGMENT})+`, 'g');
  for (const m of py.matchAll(re)) found.add(normalizePath(m[0]));
  const bases = new Map();
  for (const m of py.matchAll(new RegExp(String.raw`(\w+) = f?"(/api(?:/${SEGMENT})+)"`, 'g'))) {
    if (!bases.has(m[1])) bases.set(m[1], new Set());
    bases.get(m[1]).add(normalizePath(m[2]));
  }
  for (const m of py.matchAll(/(\w+) \+ f?"(\/[\w./{}-]+)"/g)) {
    for (const base of bases.get(m[1]) || []) found.add(normalizePath(base + m[2]));
  }
  return found;
}

/** The route table of public/index.php. */
export function parseRoutes(indexPhp) {
  return [...indexPhp.matchAll(/\['(GET|POST|PATCH|PUT|DELETE)',\s*'([^']+)',\s*\[(\w+)::class,\s*'(\w+)'\]/g)]
    .map((m) => ({ method: m[1], pattern: m[2], cls: m[3], fn: m[4] }));
}

/** A string constant list of a PHP class, such as Auth::CLIENT_WRITES. */
export function constList(php, name) {
  const m = php.match(new RegExp(String.raw`const ${name}\s*=\s*\[([\s\S]*?)\];`));
  return m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : [];
}

/** The routes the client may use: the writes a personal key may make, and the reads the client really makes. */
export function clientRoutes(routes, writes, paths) {
  return routes.filter((r) => writes.includes(`${r.method} ${r.pattern}`) || (r.method === 'GET' && paths.has(normalizePath(r.pattern))));
}

/** Skips a string or a comment starting at i, or returns -1. */
function skip(src, i) {
  const c = src[i];
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); return j < 0 ? src.length : j; }
  if (c === '#' && src[i + 1] !== '[') { const j = src.indexOf('\n', i); return j < 0 ? src.length : j; }
  if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j < 0 ? src.length : j + 2; }
  return -1;
}

/** The text from an opening brace to its closing brace, ignoring braces in strings and comments. */
export function braceBlock(src, open) {
  let depth = 0;
  for (let i = open; i < src.length;) {
    const s = skip(src, i);
    if (s >= 0) { i = s; continue; }
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    i++;
  }
  throw new Error('Unbalanced braces');
}

/** Removes comments and collapses spaces, so that a cosmetic edit does not count as a change. */
export function normalizeCode(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === "'" || c === '"') { const j = skip(src, i); out += src.slice(i, j); i = j; continue; }
    const s = skip(src, i);
    if (s >= 0) { out += ' '; i = s; continue; }
    out += c; i++;
  }
  return out.replace(/\s+/g, ' ').replace(/ ?([{}();,=.:[\]]) ?/g, '$1').trim();
}

/** Methods and constants of one PHP class. */
export function phpMembers(php) {
  const methods = {}; const consts = {};
  for (const m of php.matchAll(/function\s+(\w+)\s*\(/g)) {
    let i = m.index + m[0].length; let depth = 1;
    while (depth && i < php.length) { const s = skip(php, i); if (s >= 0) { i = s; continue; } if (php[i] === '(') depth++; else if (php[i] === ')') depth--; i++; }
    const open = php.indexOf('{', i);
    const semi = php.indexOf(';', i);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // abstract or interface
    methods[m[1]] = php.slice(m.index, i) + braceBlock(php, open);
  }
  for (const m of php.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=/g)) {
    let i = m.index + m[0].length; let depth = 0;
    while (i < php.length) { const s = skip(php, i); if (s >= 0) { i = s; continue; } const c = php[i]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ';' && depth === 0) break; i++; }
    consts[m[1]] = php.slice(m.index, i + 1);
  }
  return { methods, consts };
}

/** What a piece of code calls or reads, in its own class and in other classes of the platform. */
export function references(code, own) {
  const out = new Set();
  for (const m of code.matchAll(/\b(?:self|static)::(\w+)\s*\(/g)) out.add(`${own}::${m[1]}`);
  for (const m of code.matchAll(/\bself::class\s*,\s*'(\w+)'/g)) out.add(`${own}::${m[1]}`);
  for (const m of code.matchAll(/\b(?:self|static)::([A-Z][A-Z0-9_]*)\b(?!\s*\()/g)) out.add(`${own}::${m[1]}`);
  for (const m of code.matchAll(/\b([A-Z]\w*)::(\w+)\b/g)) if (!['self', 'static', 'parent'].includes(m[1]) && m[2] !== 'class') out.add(`${m[1]}::${m[2]}`);
  return out;
}

/** Reads every class of src/ by its short name. */
export function loadClasses(root = '.') {
  const classes = {};
  for (const dir of ['src', 'src/Controllers']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.php')).sort()) {
      const php = fs.readFileSync(path.join(root, dir, f), 'utf8');
      const m = php.match(/\bclass\s+(\w+)/);
      if (m) classes[m[1]] = phpMembers(php);
    }
  }
  return classes;
}

/** Every method and constant reachable from the roots, each hashed. */
export function reachable(classes, roots) {
  const items = {}; const todo = [...roots];
  while (todo.length) {
    const key = todo.pop();
    if (key in items) continue;
    const [cls, name] = key.split('::');
    const c = classes[cls];
    const code = c?.methods[name] ?? c?.consts[name];
    if (code === undefined) continue; // a PHP built-in, or a class outside the platform
    items[key] = hash(normalizeCode(code));
    for (const r of references(code, cls)) if (!(r in items)) todo.push(r);
  }
  return items;
}

/** The protocol as it is in the working tree. */
export function currentProtocol(root = '.') {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const auth = read('src/Auth.php');
  const writes = constList(auth, 'CLIENT_WRITES');
  const routes = clientRoutes(parseRoutes(read('public/index.php')), writes, clientPaths(read('client/oq.py')));
  const roots = [...routes.map((r) => `${r.cls}::${r.fn}`), 'Auth::user', 'Auth::checkClientRoute', 'Auth::CLIENT_WRITES', 'Auth::CLIENT_NO_READ', 'ClientProtocol::check'];
  const items = reachable(loadClasses(root), roots);
  const list = routes.map((r) => `${r.method} ${r.pattern} ${r.cls}::${r.fn}`).sort();
  items['@routes'] = hash(list.join('\n'));
  const sorted = Object.fromEntries(Object.keys(items).sort().map((k) => [k, items[k]]));
  return { routes: list, items: sorted, fingerprint: hash(JSON.stringify(sorted)) };
}

/** What changed since the record. */
export function compareProtocol(record, current) {
  const before = record?.items || {}; const now = current.items;
  return {
    same: record?.fingerprint === current.fingerprint,
    added: Object.keys(now).filter((k) => !(k in before)),
    removed: Object.keys(before).filter((k) => !(k in now)),
    changed: Object.keys(now).filter((k) => k in before && before[k] !== now[k]),
  };
}

export const clientVersion = (root = '.') => fs.readFileSync(path.join(root, 'client/oq.py'), 'utf8').match(/^VERSION = "([^"]+)"/m)[1];
export const serverMinimum = (root = '.') => fs.readFileSync(path.join(root, 'src/ClientProtocol.php'), 'utf8').match(/const MIN_VERSION = '([^']+)'/)[1];
export const readRecord = (root = '.') => (fs.existsSync(path.join(root, RECORD)) ? JSON.parse(fs.readFileSync(path.join(root, RECORD), 'utf8')) : null);
export const versionTuple = (v) => String(v).split('.').map(Number);
export const newer = (a, b) => { const x = versionTuple(a); const y = versionTuple(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** The message shown when the protocol changed without a decision. */
export function unreviewedMessage(diff) {
  const list = (label, keys) => (keys.length ? `  ${label}: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ` and ${keys.length - 15} more` : ''}\n` : '');
  return 'The client protocol changed and this was not recorded.\n' + list('changed', diff.changed) + list('added', diff.added) + list('removed', diff.removed)
    + 'Check whether clients already released still work with this server, then record the decision:\n'
    + '  npm run protocol -- --compatible "why older clients still work"\n'
    + '  npm run protocol -- --breaking "what older clients cannot do"   (after raising VERSION in client/oq.py; older clients must then update)';
}
