// Ways to look at a large fact graph without drawing all of it. No dependency, so that it can be unit tested.
// An edge [a, b] means that fact a depends on fact b.

/** Above this many facts, the whole graph is no longer the default view. */
export const LARGE_GRAPH = 300;

export const GRAPH_VIEWS = {
  key: { label: 'Key facts', hint: 'Starred facts only. Two are linked when one relies on the other, directly or through other facts.' },
  reading: { label: 'Worth reading', hint: 'The facts marked worth reading: real progress, a key step, a surprising example. Two are linked when one relies on the other, directly or through other facts.' },
  around: { label: 'Around a fact', hint: 'The selected fact, what it relies on and what relies on it, up to a depth.' },
  all: { label: 'Everything', hint: 'Every fact. Zoom in to read them.' },
};

/** The view a project opens on: everything while it is small, otherwise the key facts or the area around one. */
export function defaultView(count, starred) {
  if (count <= LARGE_GRAPH) return 'all';
  return starred ? 'key' : 'around';
}

function adjacency(edges, ids) {
  const deps = new Map(); const users = new Map();
  for (const id of ids) { deps.set(id, []); users.set(id, []); }
  for (const [a, b] of edges) {
    if (!deps.has(a) || !deps.has(b)) continue;
    deps.get(a).push(b); users.get(b).push(a);
  }
  return { deps, users };
}

/**
 * The key facts, linked through the rest of the graph. Each link [a, b, via] says that a relies on b,
 * through `via` other facts on the shortest such path. A link implied by two others is left out, so that
 * the picture stays readable: if a relies on b and b on c, a is not also linked to c.
 */
export function keyGraph(nodes, edges, isKey) {
  const ids = nodes.map((n) => n.id);
  const { deps } = adjacency(edges, ids);
  const keys = new Set(nodes.filter(isKey).map((n) => n.id));
  const direct = new Map();
  for (const a of keys) {
    const found = new Map();
    const seen = new Set([a]);
    let frontier = deps.get(a) || [];
    for (let dist = 0; frontier.length; dist++) {
      const next = [];
      for (const x of frontier) {
        if (seen.has(x)) continue;
        seen.add(x);
        if (keys.has(x)) { if (!found.has(x)) found.set(x, dist); continue; } // a key fact stops the walk
        for (const y of deps.get(x) || []) next.push(y);
      }
      frontier = next;
    }
    direct.set(a, found);
  }
  // Transitive reduction on the key facts.
  const below = new Map();
  const reachKeys = (a) => {
    if (below.has(a)) return below.get(a);
    const out = new Set();
    below.set(a, out);
    for (const b of direct.get(a).keys()) { out.add(b); for (const c of reachKeys(b)) out.add(c); }
    return out;
  };
  const out = [];
  for (const [a, found] of direct) {
    for (const [b, via] of found) {
      const implied = [...found.keys()].some((c) => c !== b && reachKeys(c).has(b));
      if (!implied) out.push([a, b, via]);
    }
  }
  return { nodes: nodes.filter((n) => keys.has(n.id)), edges: out };
}

/** The facts within `depth` steps of the center, in both directions. `depth` 0 means no limit. */
export function neighborhood(nodes, edges, center, depth) {
  const ids = nodes.map((n) => n.id);
  if (!ids.includes(center)) return { nodes: [], edges: [] };
  const { deps, users } = adjacency(edges, ids);
  const keep = new Set([center]);
  for (const next of [deps, users]) {
    let frontier = [center];
    const seen = new Set([center]);
    for (let d = 0; frontier.length && (!depth || d < depth); d++) {
      const step = [];
      for (const x of frontier) for (const y of next.get(x) || []) if (!seen.has(y)) { seen.add(y); keep.add(y); step.push(y); }
      frontier = step;
    }
  }
  return { nodes: nodes.filter((n) => keep.has(n.id)), edges: edges.filter(([a, b]) => keep.has(a) && keep.has(b)) };
}

/** The fact to center on when none is selected: the most starred, then the most used. */
export function bestCenter(nodes) {
  let best = null;
  for (const n of nodes) {
    const score = [n.stars || 0, n.used_by ?? n.dependents?.length ?? 0];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { id: n.id, score };
  }
  return best?.id ?? null;
}
