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
