// Who a conversation is open to, chosen when it starts: what each choice means, beside the choice, on hover and in the conversation.
// Without dependency, so that it can be unit tested. The server keeps the same two values (conversations.visibility).

export const CONVERSATION_ACCESS = {
  project: {
    icon: 'globe', label: 'Whole project', long: 'Whole project (including future members)',
    text: 'Every member reads and answers it, and so does everyone who joins the project later. Nobody can leave it; each member can archive it. Facts extracted from it need no confirmation, since every member can read it.',
  },
  chosen: {
    icon: 'lock', label: 'Chosen people', long: 'Chosen people',
    text: 'Only the people you tick read and answer it. They can add others later, who then see the whole history; members who join the project later do not see it unless someone adds them.',
  },
};

/** Said beside the choice: it cannot be changed once the conversation has started. */
export const ACCESS_FINAL = 'This choice cannot be changed once the conversation has started. To open a private discussion to everyone, start a new whole-project conversation.';

export const accessOf = (c) => (c?.visibility === 'project' ? 'project' : 'chosen');

/** What the composer sends for this choice: a whole-project conversation needs no list of people. */
export function createBody(draft) {
  const visibility = draft.access === 'project' ? 'project' : 'chosen';
  return { subject: draft.subject, visibility, participant_ids: visibility === 'project' ? [] : draft.participants };
}

/** Who a conversation of the list is with, for its first line. */
export function whoLine(c, me) {
  if (accessOf(c) === 'project') return 'Whole project';
  const others = (c.participants || []).filter((p) => p.id !== me);
  if (!others.length) return 'Only you';
  const names = others.map((p) => p.name.split(' ')[0]);
  return names.length > 3 ? names.slice(0, 3).join(', ') + ` +${names.length - 3}` : names.join(', ');
}
