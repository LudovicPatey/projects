// How a review judges a fact: the result and its proof are separate questions. No dependency, unit tested.

/** What a reviewer said, as one short label. A correct proof proves the result. */
export function stance(v) {
  if (!v) return null;
  const s = v.statement_verdict ?? (v.verdict === 'correct' ? 'true' : null);
  if (v.verdict === 'correct') return { key: 'endorsed', label: 'Correct', cls: 'green' };
  if (s === 'true') return { key: 'result_only', label: v.verdict === 'gap' ? 'Result true, proof has a gap' : 'Result true, proof wrong', cls: 'amber' };
  if (s === 'false' || (s === null && v.verdict === 'incorrect')) return { key: 'denied', label: s === 'false' ? 'Result false' : 'Incorrect', cls: 'red' };
  return { key: 'gap', label: v.verdict === 'gap' ? 'Gap' : 'Proof wrong', cls: 'amber' };
}

export const PROOF_STATE = {
  accepted: { label: 'Accepted', cls: 'green' },
  flawed: { label: 'Disputed', cls: 'amber' },
  unchecked: { label: 'Not checked yet', cls: '' },
};

/** The verdicts on another proof, counted for its card. */
export function proofTally(p) {
  const c = { correct: 0, gap: 0, incorrect: 0 };
  for (const v of p?.reviews || []) c[v.verdict] = (c[v.verdict] || 0) + 1;
  return c;
}

/** The review body sent for "I believe the result, but not this proof". */
export const resultOnlyBody = (verdict, reason) => ({ verdict: verdict === 'gap' ? 'gap' : 'incorrect', statement: 'true', body_text: String(reason || '').trim() });
