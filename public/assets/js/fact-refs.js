// Facts named in a text the way their paper does ("Lemma 2.4"): links with a preview on hover. The server says which names it
// resolved (text_refs of a fact, src/FactRefs.php); this only finds them in the text. No dependency, so that it can be tested.

const WORDS = ['Lemma', 'Theorem', 'Proposition', 'Corollary', 'Claim', 'Definition', 'Remark', 'Fact', 'Observation', 'Conjecture'];
const SOURCE = `\\b(${WORDS.join('|')})[\\s~\\u00a0]+(\\d+(?:\\.\\d+)*)\\b`;

const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Paper-style names, and the names an AI gave the facts of one answer ("lem:full-match-gives-left-match"), which the server
 * resolves too: matched whole, never inside a longer name.
 */
function patternFor(refs) {
  const literal = [...new Set((refs || []).map((r) => r.text).filter((t) => t && !new RegExp(`^${SOURCE}$`, 'u').test(t)))].sort((a, b) => b.length - a.length);
  return new RegExp(literal.length ? `${SOURCE}|(?<![\\w:/-])(${literal.map(escape).join('|')})(?![\\w:-])` : SOURCE, 'gu');
}

/** The text cut around the names that resolve: strings, and {text, ref} for each link. */
export function splitRefs(text, refs) {
  const byName = new Map((refs || []).map((r) => [r.text, r]));
  const out = []; let last = 0;
  for (const m of String(text).matchAll(patternFor(refs))) {
    const ref = byName.get(m[3] ?? `${m[1]} ${m[2]}`);
    if (!ref) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ text: m[0], ref });
    last = m.index + m[0].length;
  }
  if (last < String(text).length) out.push(String(text).slice(last));
  return out;
}

/** Wraps the resolved names of an element in links to their facts, outside formulas, code, chips and existing links. */
export function linkFactRefs(root, refs, pid) {
  if (!refs?.length || !pid) return;
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* text */, {
    acceptNode: (n) => (n.parentElement?.closest('.katex, code, pre, a, .mention, .fact-ref') ? 2 : 1),
  });
  const nodes = [];
  const any = new RegExp(patternFor(refs).source, 'u');
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (any.test(n.data)) nodes.push(n);
  for (const n of nodes) {
    const parts = splitRefs(n.data, refs);
    if (!parts.some((p) => typeof p !== 'string')) continue;
    const frag = root.ownerDocument.createDocumentFragment();
    for (const p of parts) {
      if (typeof p === 'string') { frag.append(p); continue; }
      const a = root.ownerDocument.createElement('a');
      a.className = 'fact-ref';
      a.href = `#/p/${pid}/facts/${p.ref.fact_id}`;
      a.dataset.type = 'fact'; a.dataset.id = String(p.ref.fact_id);
      a.textContent = p.text;
      if (p.ref.fact?.label) a.setAttribute('aria-label', `${p.text}: ${p.ref.fact.label}`);
      frag.append(a);
    }
    n.replaceWith(frag);
  }
}
