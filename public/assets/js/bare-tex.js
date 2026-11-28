// Formulas written without dollars, as many fact titles are: "HT^{=2}_2 has Π^0_2 solutions", "ACA_0^+". Each becomes a formula,
// a name of capitals upright as the project writes it ($\mathsf{HT}^{=2}_2$), a letter or a Greek capital as itself. Only a base
// followed by ^ or _ counts, so ordinary prose is left as it is. Without dependency, so that it can be tested.

const GREEK = { Σ: '\\Sigma', Π: '\\Pi', Δ: '\\Delta', Γ: '\\Gamma', Λ: '\\Lambda', Ω: '\\Omega', Φ: '\\Phi', Ψ: '\\Psi', Θ: '\\Theta',
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', λ: '\\lambda', μ: '\\mu', ω: '\\omega', σ: '\\sigma', π: '\\pi' };
const SCRIPT = '(?:[\\^_](?:\\{(?:[^{}]|\\{[^{}]*\\})*\\}|[A-Za-z0-9+\\-=′\'<>≤*]))';
// A Greek letter spelled out, as titles write it: Pi^1_1, Sigma^0_2, Delta^0_2.
const NAMED = 'Sigma|Pi|Delta|Gamma|Lambda|Omega|Phi|Psi|Theta|alpha|beta|gamma|delta|epsilon|lambda|mu|omega|sigma|pi';
const TOKEN = new RegExp(`(?<![\\w\\\\{])(${NAMED}|[A-Z]{2,}|[A-Za-z]|[ΣΠΔΓΛΩΦΨΘαβγδελμωσπ])(${SCRIPT}+)(?![\\w])`, 'gu');
const NAMED_SET = new Set(NAMED.split('|'));

/** The text with its bare formulas between dollars. A text that already has dollars is left as its author wrote it. */
export function bareTex(text) {
  const s = String(text ?? '');
  if (s.includes('$') || !/[\^_]/.test(s)) return s;
  return s.replace(TOKEN, (_, base, scripts) => {
    const b = NAMED_SET.has(base) ? `\\${base}` : base.length > 1 ? `\\mathsf{${base}}` : GREEK[base] || base;
    // Braces inside a script group are a set, ∃{a,b}: kept as braces, not swallowed as TeX grouping.
    const sets = scripts.replace(/\{((?:[^{}]|\{[^{}]*\})*)\}/g, (m, inner) => '{' + inner.replace(/\{([^{}]*)\}/g, '\\{$1\\}') + '}');
    return '$' + b + sets.replace(/[ΣΠΔΓΛΩΦΨΘαβγδελμωσπ]/gu, (g) => GREEK[g] + ' ') + '$';
  });
}

/**
 * A word written as a subscript or a superscript is a label, set upright: `\mathcal U_{idem}` reads "U idem", not the product
 * i·d·e·m in italics. Four letters or more, so that indices such as `_{ij}` or `_{n+1}` stay variables. For KaTeX's preProcess.
 */
export const uprightScriptWords = (tex) => String(tex).replace(/(?<!\\[a-zA-Z]*)([_^])\{([a-zA-Z]{4,})\}/g, '$1{\\mathrm{$2}}');

// Titles spell Greek letters out before a script, as in Pi^1_1-CA_0 or ISigma^0_2, and infinity as a script word: the letters they
// stand for, so that the formula reads Π¹₁ and not the word "Pi".
const SPELLED = { Sigma: 'Σ', Pi: 'Π', Delta: 'Δ', Gamma: 'Γ', Lambda: 'Λ', Omega: 'Ω', Phi: 'Φ', Psi: 'Ψ', Theta: 'Θ' };
// Lowercase ones only where a formula is plain, so that prose keeps its words: next to a script, an operator or a bracket
// (alpha^(omega+1), (omega+1)-st), or before "-model" (beta-model). A script in parentheses keeps them: alpha^(omega) is α^{(ω)}.
const SMALL = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', kappa: 'κ', lambda: 'λ', omega: 'ω', sigma: 'σ', theta: 'θ', varphi: 'φ', phi: 'φ', psi: 'ψ', xi: 'ξ' };
const SMALL_RE = new RegExp(`(?<![A-Za-z\\\\])(${Object.keys(SMALL).join('|')})(?![A-Za-z])(?=[_^+)]|-model)|(?<=[(^_{+])(${Object.keys(SMALL).join('|')})(?![A-Za-z])`, 'g');
export const spelledGreek = (t) => t.replace(/(?<![A-Za-z\\])([A-Z]?)(Sigma|Pi|Delta|Gamma|Lambda|Omega|Phi|Psi|Theta)(?=[_^])/g, (m, pre, g) => pre + SPELLED[g])
  .replace(/([_^])infty\b/g, '$1∞').replace(SMALL_RE, (m, a, b) => SMALL[a || b])
  .replace(/([_^])\(([^()\s]+)\)/g, '$1{($2)}');

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', k: 'ᵏ', "'": '′', '′': '′', '*': '*' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ', i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ' };
const SYMBOL = { emptyset: '∅', varnothing: '∅', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', in: '∈', notin: '∉', subseteq: '⊆', subset: '⊂', cup: '∪', cap: '∩', to: '→',
  infty: '∞', omega: 'ω', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', varepsilon: 'ε', epsilon: 'ε', lambda: 'λ', mu: 'μ', sigma: 'σ', pi: 'π',
  Sigma: 'Σ', Pi: 'Π', Delta: 'Δ', Gamma: 'Γ', Lambda: 'Λ', Omega: 'Ω', Phi: 'Φ', Psi: 'Ψ', Theta: 'Θ', mathbb: '', prime: '′', cdot: '·', times: '×', ldots: '…', dots: '…',
  vee: '∨', lor: '∨', wedge: '∧', land: '∧', neg: '¬', forall: '∀', exists: '∃', setminus: '∖', rightarrow: '→', Rightarrow: '⇒', leftrightarrow: '↔', iff: '⇔', implies: '⇒',
  oplus: '⊕', upharpoonright: '↾', restriction: '↾', langle: '⟨', rangle: '⟩', ll: '≪', mid: '∣', le_T: '≤', equiv: '≡', sim: '∼', circ: '∘', varphi: 'φ', phi: 'φ', rho: 'ρ', tau: 'τ', theta: 'θ', kappa: 'κ', eta: 'η', zeta: 'ζ', xi: 'ξ', chi: 'χ', psi: 'ψ' };

/**
 * A title with formulas as plain Unicode, for a canvas that cannot typeset: "ACA_0^+" becomes "ACA₀⁺", "\Pi^1_1" "Π¹₁", "0'" stays.
 * A script with a character Unicode has no small form for keeps its caret or underscore. Bare titles are read as bareTex reads them.
 */
export function texToUnicode(text) {
  let t = spelledGreek(String(text || '')).replace(/\$/g, '');
  t = t.replace(/\\mathbb\s*\{?N\}?(?![a-zA-Z])/g, 'ℕ').replace(/\\mathbb\s*\{?Z\}?(?![a-zA-Z])/g, 'ℤ').replace(/\\mathbb\s*\{?R\}?(?![a-zA-Z])/g, 'ℝ');
  t = t.replace(/\\(?:math[a-z]+|text[a-z]*|operatorname)\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\([a-zA-Z]+)(\s?)/g, (m, n, sp) => (n in SYMBOL ? SYMBOL[n] + (SYMBOL[n] ? sp : '') : n));
  const script = (map, mark) => (_, braced, single) => {
    const s = braced ?? single;
    return [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join('') : `${mark}${braced !== undefined && !/^\(.*\)$/.test(s) ? `(${s})` : s}`;
  };
  t = t.replace(/\^(?:\{([^{}]*)\}|([^\s{}]))/g, script(SUP, '^')).replace(/_(?:\{([^{}]*)\}|([^\s{}]))/g, script(SUB, '_'));
  return t.replace(/[{}]/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Shorthands many papers define for themselves, known to every formula: a description or quote taken from a paper whose
 * source was not uploaded (only its PDF) keeps them, and they would otherwise show in red. A paper's own macros win.
 */
export const COMMON_MACROS = {
  '\\msf': '\\mathsf{#1}', '\\mrm': '\\mathrm{#1}', '\\mbf': '\\mathbf{#1}', '\\mbb': '\\mathbb{#1}', '\\mcal': '\\mathcal{#1}',
  '\\mfrak': '\\mathfrak{#1}', '\\msc': '\\mathscr{#1}', '\\mtt': '\\mathtt{#1}', '\\mit': '\\mathit{#1}',
};
