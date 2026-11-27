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
