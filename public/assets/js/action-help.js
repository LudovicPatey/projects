// What each action of the interface does: what it changes, and what it leaves as it is. Members do not know the interface, so a
// button that could mean several things, or that reaches further than it looks, says it on hover, in its confirmation, and beside it
// when its reach is not obvious. Without dependency, so that it can be unit tested. The notation page has its own, per entry
// (actionEffects in notation-model.js), since what an entry applies to depends on its parameters.

export const ACTIONS = {
  // Consolidation: accepting a proposal does what its kind says.
  'cons.accept.same': { changes: 'Merges the duplicate into the kept fact: its sources, links, stars and proof move there, and the duplicate leaves the list.', keeps: 'The statement of the kept fact. An unmerge brings the duplicate back as it was.' },
  'cons.accept.depends': { changes: 'Records that the proof of the first fact uses the second: if the second is retracted, the first is flagged.', keeps: 'Both statements and proofs, and their reviews.' },
  'cons.accept.kind': { changes: 'Changes the kind of the fact, such as remark to lemma.', keeps: 'Its statement, proof, reviews and links.' },
  'cons.accept.question': { changes: 'Turns the remark into an open question: it leaves the facts and appears among the questions.', keeps: 'Other facts. Undo brings the remark back.' },
  'cons.accept.topics': { changes: 'Adds these subject tags to the fact, used to filter the list and the graph.', keeps: 'Everything else about the fact.' },
  'cons.accept.cite': { changes: 'Links the outside reference of the proof to the fact that states its result, created as a cited result if needed.', keeps: 'The text of the proof and its reviews.' },
  'cons.accept.progress': { changes: 'Marks the fact as worth reading: it appears on the overview of each member until they open it.', keeps: 'The fact itself.' },
  'cons.accept.notation': { changes: 'Settles the notation entry as proposed, and queues the rewrite of the facts in the project notation.', keeps: 'The reviewed text of every fact: a rewrite is shown beside it.' },
  'cons.reject': { changes: 'Sets the proposal aside: the AI never makes it again.', keeps: 'Every fact, as it is.' },
  'cons.undo': { changes: 'Reverts this change, and records that a person undid it: the AI does not make it again.', keeps: 'What people changed since, which stays as they decided.' },
  'cons.undo.same': { changes: 'Unmerges: the duplicate comes back as its own fact, with its sources, dependencies, proof and stars.', keeps: 'The kept fact.' },
  'cons.restore': { changes: 'Puts the proposal back with those waiting for people.', keeps: 'Every fact, until someone accepts it.' },

  // A fact.
  'fact.endorse': { changes: 'Records that you checked this revision and consider it correct: your endorsement counts toward its status.', keeps: 'The fact itself. A new revision needs fresh reviews.' },
  'fact.accept': { changes: 'Records that you read the source and that it states this result.', keeps: 'The fact itself.' },
  'fact.resultOnly': { changes: 'Records that you believe the result, but not its proof: facts using it stay usable, and it is not proved until a proof is accepted.', keeps: 'The fact, for everyone else.' },
  'fact.deny': { changes: 'Records your verdict that the result is false, with the reason.', keeps: 'The fact stays in the database: Deny is your opinion, not a removal. Retract is what withdraws a fact for everyone.' },
  'fact.retract': { changes: 'Withdraws the fact for everyone: every fact that depends on it is flagged, and their authors are notified.', keeps: 'Its text and history. Reinstate undoes it.' },
  'fact.reinstate': { changes: 'Brings the fact back: the facts that depend on it are no longer flagged because of it.', keeps: 'Its reviews and history.' },
  'fact.delete': { changes: 'Deletes the fact. Only possible when nothing depends on it and it supports no answer.', keeps: 'Other facts. When others depend on it, retract it instead.' },
  'fact.sameMeaning': { changes: 'Confirms that the version in project notation states exactly what the original states. Your verdict replaces the AI\'s.', keeps: 'The reviewed text of the fact.' },
  'fact.notSame': { changes: 'Reports that the version in project notation changes the meaning: it is hidden, the original is shown, and the fact can be rewritten again.', keeps: 'The reviewed text of the fact.' },
  'fact.undoCheck': { changes: 'Withdraws your verdict on the version in project notation.', keeps: 'Both texts.' },
  'fact.link': { changes: 'Records that the proof takes this result from the chosen fact: the outside reference is resolved, and the proof relies on that fact.', keeps: 'The text of the proof.' },
  'fact.notUsed': { changes: 'Records that the proof only mentions this work, and takes no result from it.', keeps: 'The text of the proof.' },
  'fact.unlink': { changes: 'Removes the link: the reference counts as unresolved again.', keeps: 'The linked fact.' },
  'fact.undoChange': { changes: 'Reverts this change of the consolidation.', keeps: 'What people changed since.' },
  'proof.correct': { changes: 'Your verdict on this proof: it is correct. One accepted proof makes the fact checked.', keeps: 'The other proofs and their reviews.' },
  'proof.gap': { changes: 'Your verdict on this proof: a step is missing.', keeps: 'The result, and the other proofs.' },
  'proof.error': { changes: 'Your verdict on this proof: a step is wrong.', keeps: 'The result, and the other proofs.' },
  'review.submit': { changes: 'Records your review of this revision, seen by every member.', keeps: 'The fact. A new revision needs fresh reviews.' },

  // Questions.
  'answer.propose': { changes: 'Proposes an answer backed by a fact. A person must ratify it before the question is answered.', keeps: 'The status of the question.' },
  'answer.withdraw': { changes: 'Takes back your proposed answer.', keeps: 'The question and its other answers.' },
  'answer.reject': { changes: 'Rejects this proposed answer, with a reason.', keeps: 'The question stays open.' },
  'answer.revoke': { changes: 'Revokes the ratification: the question goes back to In progress.', keeps: 'The record of the ratification.' },
  'strategy.restore': { changes: 'Makes this version the current one, as a new version.', keeps: 'The whole history.' },

  // Files and references.
  'file.newVersion': { changes: 'Uploads a new version, which becomes the current one.', keeps: 'Earlier versions, which can be restored.' },
  'file.restore': { changes: 'Creates a new version identical to this one, which becomes current.', keeps: 'The whole history.' },
  'bib.extract': { changes: 'Queues fact extraction for the reference PDFs not read yet. Each uses the AI subscription of the member whose client takes it.', keeps: 'Facts already extracted.' },
  'bib.saveBibtex': { changes: 'Replaces the BibTeX of this reference, and the title, authors and venue shown from it.', keeps: 'Its PDF, comments and facts.' },
  'bib.reset': { changes: 'Discards your edits to the BibTeX.', keeps: 'The saved reference.' },
  'suggestion.accept': { changes: 'Adds the reference to the bibliography.', keeps: 'Facts. Extraction of its PDF is a separate step.' },
  'suggestion.reject': { changes: 'Keeps the reference out of the bibliography: the AI does not suggest it again.', keeps: 'The bibliography.' },

  // AI work.
  'task.retry': { changes: 'Puts the task back in the queue: the next AI client that is free takes it.', keeps: 'What earlier attempts produced.' },
  'task.cancel': { changes: 'Removes the task from the queue, or stops it.', keeps: 'What it already produced.' },
  'task.send': { changes: 'Adds the request to the queue. A member\'s AI client runs it with their own AI subscription.', keeps: 'Nothing changes until its result arrives, and results go through the usual reviews.' },

  // Members and keys.
  'member.remove': { changes: 'Removes the member from the project: they no longer see it.', keeps: 'What they wrote, which stays with their name.' },
  'member.leave': { changes: 'You leave the project: you no longer see it, until someone adds you back.', keeps: 'What you wrote, which stays with your name.' },
  'project.public': { changes: 'Makes the project public: every researcher signed in to the platform sees its card (title, main question, owners, number of members) and can ask to join. Owners decide on each request.', keeps: 'Everything inside the project, which only members can read. Choosing Private hides the card again.' },
  'project.private': { changes: 'Makes the project private: its card leaves the list of public projects, and nobody can send a new request to join.', keeps: 'Its members, and the requests already sent, which owners can still answer. Choosing Public opens it again.' },
  'join.ask': { changes: 'Sends your request to the owners of the project: each is notified and sees your name, ORCID iD, affiliation and your motivation.', keeps: 'The project, which you can read only once an owner accepts. You can withdraw the request until they answer.' },
  'join.withdraw': { changes: 'Takes back your request: the owners no longer see it.', keeps: 'Nothing else. You can ask again at any time.' },
  'join.accept': { changes: 'Makes the researcher a member of the project (not an owner): they can read and write everything members can, and are notified.', keeps: 'The other members and their roles. To undo it, remove them under People.' },
  'join.decline': { changes: 'Closes the request: the researcher is notified, with your note if you write one.', keeps: 'The project and its members. They can ask again after a week.' },
  'agent.remove': { changes: 'Removes the AI agent and revokes its token.', keeps: 'Its past messages and files.' },
  'key.revoke': { changes: 'Revokes the key: clients using it stop working at once.', keeps: 'What they already did.' },
  'audit.revoke': { changes: 'Revokes the audit key: anyone using it loses access at once.', keeps: 'The project, which an audit key only reads.' },
  'notifications.readAll': { changes: 'Marks all your notifications as read.', keeps: 'The notifications themselves.' },
};

/** "What it changes. Unchanged: what it leaves." for a tooltip or a confirmation. Empty for an unknown action. */
export function explain(id) {
  const a = ACTIONS[id];
  return a ? `${a.changes} Unchanged: ${a.keeps}` : '';
}

/** The action that accepting a consolidation proposal of this kind is. */
export const acceptAction = (kind) => (ACTIONS[`cons.accept.${kind}`] ? `cons.accept.${kind}` : 'cons.accept.kind');
