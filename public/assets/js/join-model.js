// Public projects and requests to join them: what each state says and allows. Without dependency, so that it can be unit tested.
// The server keeps the same limits (JoinController); the page receives them in `limits`.

export const JOIN_LIMITS = { motivation_min: 20, motivation_max: 1000, note_max: 500, ask_again_days: 7 };

/** What each visibility means, beside the choice and in its confirmation. */
export const VISIBILITY = {
  private: { icon: 'lock', label: 'Private', text: 'Only members see this project. Other researchers cannot find it or ask to join.' },
  public: { icon: 'globe', label: 'Public', text: 'Every researcher signed in to the platform sees its title, main question, owners and number of members, and can ask to join. Nothing inside the project is shown until an owner accepts.' },
};

export const visibilityOf = (p) => (p?.visibility === 'public' ? 'public' : 'private');

const day = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const shortDate = (s) => day(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * The footer of a public project's card, for the person reading it: its state, and the one action it allows.
 * `request` is their latest request to it (null if none); `now` is a Date.
 * @returns {{state: string, text: string, action: 'ask'|'withdraw'|null, disabled?: string, note?: string}}
 */
export function joinState(request, now = new Date()) {
  if (!request || request.status === 'withdrawn' || request.status === 'accepted') return { state: 'none', text: 'Not a member', action: 'ask' };
  if (request.status === 'pending') return { state: 'pending', text: 'Request sent', action: 'withdraw', title: 'Waiting for an owner to accept or decline. You will be notified.' };
  if (request.status === 'declined') {
    const again = request.ask_again_at ? day(request.ask_again_at) : null;
    const note = request.decision_note || '';
    if (again && again > now) {
      return { state: 'declined', text: `Declined, ask again from ${shortDate(request.ask_again_at)}`, action: 'ask', disabled: `The owners declined your request. You can ask again from ${shortDate(request.ask_again_at)}.`, note };
    }
    return { state: 'declined', text: 'Declined', action: 'ask', note };
  }
  return { state: 'none', text: 'Not a member', action: 'ask' };
}

/** Whether a motivation can be sent, and what the counter beside it says. */
export function motivationCheck(text, limits = JOIN_LIMITS) {
  const n = [...String(text || '').trim()].length;
  if (n < limits.motivation_min) return { ok: false, count: n, hint: `${limits.motivation_min - n} more character${limits.motivation_min - n === 1 ? '' : 's'} needed` };
  if (n > limits.motivation_max) return { ok: false, count: n, hint: `${n - limits.motivation_max} character${n - limits.motivation_max === 1 ? '' : 's'} too many` };
  return { ok: true, count: n, hint: `${n}/${limits.motivation_max}` };
}

/** "Ann Smith and Bob Lee", "Ann, Bob and 2 others". */
export function ownerNames(owners) {
  const names = (owners || []).map((o) => o.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length > 3 ? 's' : ''}`;
}

/** "4 members", with the AI agents on hover. */
export function memberCount(p) {
  const n = p.members || 0;
  return { text: `${n} ${n === 1 ? 'member' : 'members'}`, title: `${n} researcher${n === 1 ? '' : 's'}${p.agents ? ` and ${p.agents} AI agent${p.agents === 1 ? '' : 's'}` : ''}` };
}
