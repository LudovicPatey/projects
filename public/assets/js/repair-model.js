// How a repair of a proof reads on the fact page (src/ProofRepair.php): where it stands, then each step as one line, its reasons on
// demand. Without dependency, so that it can be tested.

/** Where a repair stands: what it waits for, or how it ended, and who decides next. */
export const REPAIR_STATE = {
  repair: { icon: 'clock', tone: 'ai', head: 'Waits for a repair', text: 'An AI of another company than the reviewer repairs the proof, says why the review is wrong, or that the gap cannot be fixed.' },
  check: { icon: 'clock', tone: 'ai', head: 'Waits for a check', text: 'An AI of the reviewer’s side checks the repair. If it still finds a flaw, another round starts.' },
  proof: { icon: 'check-circle', tone: 'good', head: 'Both AIs agree on a proof', text: 'The reviewer’s side accepts it. A person still checks the fact before an answer can rest on it.' },
  gap: { icon: 'x', tone: 'warn', head: 'Both AIs see a gap neither can fix', text: 'Left to people: the review and the repairer’s reasons say what is missing.' },
  disagree: { icon: 'users', tone: 'bad', head: 'No agreement: left to people', text: 'The rounds ran out with both sides holding their view. Their arguments are below.' },
  closed: { icon: 'archive', tone: 'muted', head: 'Closed', text: 'The fact changed since: this repair no longer applies.' },
};

const VERDICT = { correct: 'found it correct', gap: 'found a gap', incorrect: 'found an error' };

/** One step: who, what they said, and the proof it produced. */
export function repairStep(s, proofNumber = () => null) {
  const who = s.model || s.person || 'A member';
  if (s.step === 'review') return { icon: s.verdict === 'incorrect' ? 'x' : 'help', tone: 'warn', who, what: `Reviewed the proof and ${VERDICT[s.verdict] || 'found a flaw'}`, text: s.text || '' };
  if (s.step === 'repair') {
    if (s.outcome === 'repaired') return { icon: 'edit', tone: 'ai', who, what: `Repaired it${proofNumber(s.proof_id) ? `: proof ${proofNumber(s.proof_id)}` : ''}`, text: s.text || '', proof: s.proof_id || null };
    if (s.outcome === 'review_wrong') return { icon: 'comment', tone: 'ai', who, what: 'Answered that the review is wrong', text: s.text || '' };
    return { icon: 'x', tone: 'warn', who, what: 'Could not fix it', text: s.text || '' };
  }
  return { icon: s.verdict === 'correct' ? 'check' : 'x', tone: s.verdict === 'correct' ? 'good' : 'warn', who, what: `Checked it and ${VERDICT[s.verdict] || 'answered'}`, text: s.text || '' };
}

/** The whole repair as the page shows it. `proofNumber(id)` gives the number of a proof among the fact's proofs. */
export function repairView(r, proofNumber) {
  const st = REPAIR_STATE[r?.state];
  if (!st) return null;
  const open = r.state === 'repair' || r.state === 'check';
  return { ...st, open, round: open ? `Round ${r.round} of ${r.rounds}` : `${r.round} round${r.round === 1 ? '' : 's'}`, asked: r.asked_by ? `Asked by ${r.asked_by}` : null,
    steps: (r.steps || []).map((s) => repairStep(s, proofNumber)) };
}

/** Where a correction of the statement stands (src/StatementFix.php). */
export const CORRECTION_STATE = {
  revise: { icon: 'clock', tone: 'ai', head: 'Waits for proposals', text: 'An AI checks the request against the source and proposes corrected statements, each with a proof, or says the statement is right as it is. Nothing changes yet.' },
  verify: { icon: 'clock', tone: 'ai', head: 'Waits for a check', text: 'An AI of another company checks each proposal against the request, the source and its proof. Nothing changes yet.' },
  decide: { icon: 'users', tone: 'warn', head: 'Waits for a member', text: 'Both AIs accept the statements below. Choose which replace this fact: each becomes a new fact, this one is retracted as superseded, and the facts that relied on it are checked again.' },
  applied: { icon: 'check-circle', tone: 'good', head: 'Superseded', text: 'Corrected statements replace this fact as new facts; this one is retracted and kept for the record. The facts that relied on it are checked again.' },
  kept: { icon: 'check', tone: 'warn', head: 'Both AIs find the statement right as it is', text: 'Left to the member who asked: the reasons are below.' },
  gap: { icon: 'x', tone: 'warn', head: 'No correct statement found', text: 'The AI could not write a correct statement from the source: left to people.' },
  disagree: { icon: 'users', tone: 'bad', head: 'No agreement: left to people', text: 'The rounds ran out with no proposal both AIs accept. Their arguments and the last proposals are below.' },
  undone: { icon: 'restore', tone: 'muted', head: 'Undone', text: 'A member undid the correction: the new facts were retracted and this one is back.' },
  closed: { icon: 'archive', tone: 'muted', head: 'Closed', text: 'The fact changed since: this correction no longer applies.' },
};

/** A variant a member asked for in an @AI instruction (src/Instructions.php): the new facts join this one, which stays. */
const VARIANT_STATE = {
  verify: { text: 'An AI of another company checks each variant and its proof. Nothing is added yet.' },
  decide: { text: 'Both AIs accept the variants below. Choose which to add: each becomes a new fact beside this one, marked as its variant. This fact stays as it is.' },
  applied: { head: 'Variants added', text: 'The chosen variants are new facts, marked as variants of this one, which stays as it is.' },
  disagree: { text: 'The rounds ran out with no variant both AIs accept. Their arguments and the last variants are below.' },
  undone: { text: 'A member undid it: the variants were retracted.' },
};

/** One step of a correction or a variant: the request, the proposals, the checks, the decision, or the undo. */
export function correctionStep(s, variant = false) {
  const who = s.model || s.person || 'A member';
  const noun = variant ? 'variant' : 'corrected statement';
  if (s.step === 'request') return { icon: 'comment', tone: 'warn', who, what: variant ? 'Asked for a variant' : 'Asked for a correction', text: s.text || '' };
  if (s.step === 'revise') return { icon: 'edit', tone: 'ai', who, what: { corrected: `Proposed ${s.count || ''} ${noun}${s.count === 1 ? '' : 's'}`.replace('  ', ' '), keep: 'Answered that the statement is right as it is', impossible: variant ? 'Found no variant it could prove' : 'Found no correct statement' }[s.outcome] || 'Answered', text: s.text || '' };
  if (s.step === 'decide') return { icon: 'check-circle', tone: 'good', who, what: variant ? 'Chose the variants to add' : 'Chose the statements that replace this fact', text: s.text || '' };
  if (s.step === 'undo') return { icon: 'restore', tone: 'muted', who, what: variant ? 'Undid the variants' : 'Undid the correction', text: s.text || '' };
  const ok = (s.verdicts || []).filter((v) => v.verdict === 'correct').length;
  return { icon: ok ? 'check' : 'x', tone: ok ? 'good' : 'warn', who, what: s.verdicts?.length > 1 || s.verdicts?.[0]?.proposal != null ? `Checked the proposals: ${ok} of ${(s.verdicts || []).length} accepted` : `Checked it and ${VERDICT[s.verdicts?.[0]?.verdict] || 'answered'}`, text: s.text || '' };
}

const PROPOSAL_VERDICT = { correct: ['Accepted', 'good'], gap: ['Gap in its proof', 'warn'], incorrect: ['Rejected', 'bad'] };

export function correctionView(c) {
  const variant = c?.mode === 'variant';
  const st = CORRECTION_STATE[c?.state] && { ...CORRECTION_STATE[c.state], ...(variant ? VARIANT_STATE[c.state] : {}) };
  if (!st) return null;
  const open = c.state === 'revise' || c.state === 'verify';
  const showProposals = ['verify', 'decide', 'disagree'].includes(c.state);
  return { ...st, open, waitsForMember: c.state === 'decide', round: open || c.state === 'decide' ? `Round ${c.round} of ${c.rounds}` : `${c.round} round${c.round === 1 ? '' : 's'}`, asked: c.asked_by ? `Asked by ${c.asked_by}` : null,
    proposals: showProposals ? (c.proposals || []).map((x, i) => ({ index: i, title: x.title || '', statement: x.statement, fromSource: !!x.from_source, why: x.why || '', check: x.check || '', checkedBy: x.checked_by || null,
      verdict: x.verdict ? { label: PROPOSAL_VERDICT[x.verdict][0], tone: PROPOSAL_VERDICT[x.verdict][1] } : null, accepted: x.verdict === 'correct' })) : [],
    applied: c.state === 'applied', steps: (c.steps || []).map((x) => correctionStep(x, variant)), variant,
    title: variant ? 'Variant of the statement' : 'Correction of the statement',
    decide: variant ? { label: 'Add as variants', hint: 'Each chosen variant becomes a new fact with its proof, marked as a variant of this one. This fact stays as it is. You can undo it.' }
      : { label: 'Replace this fact', hint: 'Each chosen statement becomes a new fact with its proof; this fact is retracted as superseded, and the facts that relied on it are checked again by AIs. You can undo it.' } };
}

/** Where the check of a fact that relied on a superseded one stands (src/Relink.php). */
export const RELINK_STATE = {
  relink: { icon: 'clock', tone: 'ai', head: 'Waits for an AI', text: 'An AI reads this proof with the corrected statements: does it still work with one of them, or did it need the old one?' },
  relcheck: { icon: 'clock', tone: 'ai', head: 'Waits for a check', text: 'An AI of another company checks that answer.' },
  relinked: { icon: 'check-circle', tone: 'good', head: 'Relies on the corrected statement', text: 'Both AIs agree the proof works with it: a new revision relies on it, its text unchanged. Reviews start again.' },
  needs_old: { icon: 'x', tone: 'warn', head: 'Needed the old statement', text: 'Both AIs agree the proof used what only the wrong statement gave: a review records the gap, and a repair of the proof starts.' },
  disagree: { icon: 'users', tone: 'bad', head: 'No agreement: left to people', text: 'The two AIs disagree on whether the proof still works.' },
  closed: { icon: 'archive', tone: 'muted', head: 'Closed', text: 'The correction was undone, or this fact changed since.' },
};

export function relinkView(r) {
  const st = RELINK_STATE[r?.state];
  if (!st) return null;
  return { ...st, superseded: r.superseded, steps: (r.steps || []).map((s) => (s.step === 'relink'
    ? { icon: 'edit', tone: 'ai', who: s.model, what: s.outcome === 'use' ? 'Found the proof works with a corrected statement' : 'Found the proof needed the old statement', text: s.text || '' }
    : { icon: s.verdict === 'correct' ? 'check' : 'x', tone: s.verdict === 'correct' ? 'good' : 'warn', who: s.model, what: s.verdict === 'correct' ? 'Checked it and agreed' : 'Checked it and disagreed', text: s.text || '' })) };
}
