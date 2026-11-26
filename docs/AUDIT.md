# Auditing a project

An audit looks at a real project, usually the live one, to find what the platform does wrong or could do better. Counting what is
stale is not enough: an audit that only measures the data misses a page that tells people something false. This guide says what an
audit covers and how to run it.

## Getting the project

An owner creates a read-only **audit key** in Admin, Audit access. It expires and can be revoked.

```bash
OQ_AUDIT_URL=https://projects.example.org OQ_AUDIT_KEY=oqa_… npm run audit:fetch
```

The key comes from the environment: never write it to a file of the repository, a commit, a log or a report, and never print it.
Everything lands in `audit/` (git-ignored): `project.json`, `graph.json`, `notation.json`, `facts.json`, and `facts/*.md` to read.
The routes are listed in `docs/AGENT_API.md`, "Audit API". To look at the interface itself, open the project in a browser.

## What an audit covers

Go through the six parts below. For each finding, give the evidence (fact labels, counts, a quotation, a screenshot), say why it
matters, and propose a fix. Separate what is wrong from what could be better.

### 1. Validity of the data

The data is consistent and up to date.

- Counts that should be small: facts not in the current notation, cited results never checked, rewrites never checked, proposals
  waiting for people, isolated facts (no dependency, used by nothing), facts without topics, unresolved outside references.
- Broken links: dependencies on deleted or merged facts, sources pointing at missing files, notation entries naming missing facts.
- The AI queue: tasks failed for good, tasks waiting for a long time, sweeps that never finish, clients stopped by a usage limit.
- Provenance: every AI-generated item has its model, its responsible user and, when measured, its generation time.

### 2. Semantics

What the platform shows and stores is **mathematically true**. Read a sample in full, not only the counts. Judge it as a
mathematician would.

- **Statements and proofs:** read at least 10 facts across kinds and sources. Is the statement precise, and are its hypotheses
  complete? Does the proof prove it? Are the labels right (conclusion, example, counterexample, obstacle)?
- **Duplicates and merges:** do merged facts really state the same result? Are there equivalent statements left unmerged, or
  merges of results that differ in a hypothesis?
- **Dependencies:** does each proof use what it depends on, and depend on what it uses?
- **Notation:** do the meanings listed for a symbol really differ, or are they wordings of one notion? (Example: equivalent
  formulations of the infinite pigeonhole principle were once shown as different meanings.) Is each adopted definition right?
  Do rewrites in the project notation say exactly what the original says?
- **Cited results and source checks:** does the cited work state the result as written? Is the AI's verdict right?
- **Generated text:** "worth reading" reasons, consolidation reasons, second-reading reasons, summaries: is each claim true?
- **Wording of the interface about the data:** does each label, count and badge mean what it says? A count of "meanings" must count
  meanings, a "checked" badge must mean someone or something checked it.

### 3. The process: what people decide, and what the AI decides

People should decide only what needs their judgment. Every decision an AI could take reliably, and that can be undone, should be
taken by an AI, with its reason recorded and a way for people to overrule it.

- List every action that still waits for a person: accept or reject buttons, check buttons, settings, "only a person can do this"
  (`humanOnly`, `requireHuman` in `src/Controllers`). For each one, ask whether an AI could take it, whether it can be undone, and
  what an error would cost.
- Look at what is actually waiting: how many proposals, rewrites, references and citations wait for people, and for how long. A
  queue that nobody empties is a decision that should move to the AI.
- In the other direction, look at what the AI decided on its own: sample the automatic changes and check that they were right.
  A kind of decision the AI often gets wrong should go back to people, or need a second reading.
- Check that each AI decision says that an AI took it, with its model and reason, and that it can be undone or overruled.
- Keep for people what is theirs: endorsing results, accepting a cited result, what interests them (stars), the project's
  direction, settings and deletions.

### 4. The interface

The interface lets people understand the state of the project and act on it.

- Run the visual check of `AGENTS.md` (`scripts/visual-audit.js` at 1440, 1024, 800 and 375) on the main views, then look at
  screenshots.
- On each main page, ask what a member wants to know or do there, and whether the page answers it at first glance: the important
  figure first, the action within reach, no wall of text.
- Figures that are links open what they count. Long lists are grouped, paged or summarized. Text in mathematics is typeset and
  never cut inside a formula.
- Wording: short, exact, no jargon from the code. The help center and the first-use tour describe what the page shows today.
- Actions: members do not know the interface. For each button, could a newcomer tell, before clicking, what it changes and what
  it leaves as it is, and what a choice applies to? A button whose name could mean several things, or whose effect reaches
  further than it looks (a whole project, other facts, people), says so beside it or on hover, and in its confirmation.
- Phones: the overview, a fact and a discussion must be usable at 375 pixels.

### 5. Features that are missing

From what the data and the process show, which feature would help the team most?

- Recurring manual work that the platform could do, and errors that a check could have caught.
- Questions a member cannot answer from the interface (for example "what changed since my last visit?" or "what is blocking this
  question?").
- Steps where the AI work stalls: a kind of task that keeps failing, a sweep that cannot finish, a model choice that wastes time.
- Rank the proposals by benefit and cost. Do not propose what the platform already does: check the code and the help first.

### 6. Features that are obsolete

What should go, or be merged into something else?

- Features nobody uses on the project (zero rows, buttons never clicked, settings never changed), and pages that duplicate others.
- Steps that became automatic but whose manual path, text or button remains: help articles, tour steps, front-page claims,
  per-item tasks replaced by sweeps.
- Old data formats kept for compatibility that no client sends any more: check the client versions in use before removing them.
- Text that has become wrong anywhere: help, tour, front page (`public/assets/js/views/landing.js`), docs.

## Reporting

Write the report for the project's owners, not for the code: what was checked, what was found, ordered by importance, with
evidence and a proposed fix for each. Say what was not checked. Never include the audit key, member e-mail addresses or private
conversations. Fixes go through the usual definition of done of `AGENTS.md`.
