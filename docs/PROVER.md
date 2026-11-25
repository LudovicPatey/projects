# The native prover

A proof search that runs on the platform's own facts, in the spirit of [Danus](https://github.com/frenzymath/Danus)
(Apache-2.0). It runs beside the Danus integration until a side-by-side comparison shows it keeps up. Its agent
instructions adapt Danus's worker, verifier and main-agent contracts.

## Why

The Danus integration translates between two sources of truth: Danus's fact graph and the platform's facts. Each feature
added a translation: the merge, verdicts turned into reviews, strategies, cited results, a Claude adapter, a macOS patch.
The native prover has one source of truth, the platform, and reuses what it already has: independent reviews, cited
results, notation, consolidation, undo, provenance and revisions.

## Roles

| Danus | Native prover |
|---|---|
| Fact graph: what the verifier accepted | Platform facts. A worker may build on a **usable** fact: established (checked by a person or an independent AI, an accepted citation, a definition), or accepted by the prover's verifier, and everything it relies on too |
| Global memory | **Prover notes** of a campaign: conclusion, example, counterexample, proof attempt, plan, dead end, direction, obstacle, verification |
| Worker: a long Codex session with tools | A long Claude or Codex session in a member's client, with tools served by the client (MCP), backed by the platform |
| Verifier: a fresh session per submission | A fresh session per submission, in the same client, with only the statement, the proof and the cited facts. Accepted: the fact is created on the platform with the verifier's review. Rejected: a verification note with repair hints |
| Main agent, every 30 minutes | A **lead round**, claimed by any participating client when due: a summary of the state, guidance, and lanes for the workers. The summary and guidance become a revision of the campaign's strategy on its question |
| One project on one computer | A **campaign** on a question or a project, shared: every member's client can contribute workers, each within its own limits |

## Rules kept from Danus

- Text-only mathematics: no code execution, no computer algebra, no solver. The sessions have no shell.
- A proof builds only on usable facts, cited by id. A result of the literature enters as a **cited result** (statement,
  reference), checked at once against its source by a separate session; it is usable once confirmed by that check or
  accepted by a member, and stays a cited result on the platform, which people accept.
- Failed paths are shared as dead ends. Verification outcomes are shared as notes.
- The lead never creates facts.

## Flow

1. A member starts a campaign (`oq.py prove start`), on a question or on the whole project.
2. A client that runs the prover asks for a round: the platform answers with a lead round when one is due
   (none yet, or the last is older than 30 minutes), otherwise with a worker round on the lane worked least recently.
3. Worker round: the client refreshes its copy of the project's facts, writes the problem, the guidance and the lane,
   and starts a session (at most `round_minutes`) with the tools below. When it ends, the round is recorded with its
   time, facts and notes.
4. Lead round: one structured answer from the problem, guidance, notes and usable facts.
5. Limits, working hours, paused projects and the run's own stops apply between rounds; a session has its own time limit.

## Tools of a worker (served by the client)

| Tool | What it does |
|---|---|
| `fact_search(query, limit)` | Ranked facts of the project, with `usable` |
| `fact_read(id)` | Statement, proof, dependencies, status, `usable` |
| `note_search(query, kinds)` | Ranked notes of the campaign |
| `note_add(kind, claim, evidence)` | Shares a finding |
| `fact_submit(title, kind, statement, proof, depends_on, glossary)` | Runs the verifier; accepted, the fact is created on the platform with its review |
| `fact_verify(id)` | Runs the verifier on an existing fact that is not usable yet; its verdict becomes a review |
| `cite_result(title, statement, reference, quote)` | Records a result of the literature as a cited result, and checks it against its source |

The client holds the platform key. The tools run in a separate process launched by the AI tool, which reaches the client
through a local address with a one-round token, limited to this round's campaign.

## Comparison with Danus

`GET /api/projects/{pid}/prover/stats` gives, for each engine (Danus runs and native campaigns): computing time, facts
found, facts per hour of computing, and what became of those facts (usable, disputed, retracted). Both engines are run on
the same questions before choosing.

## Phases

1. Engine: campaigns, rounds, notes, tools, verifier, lead, command line, statistics. (This change.)
2. Interface: start and follow a campaign from the platform and from the client app; show notes beside a question;
   the comparison as a panel.
3. Decision: switch, or keep Danus.
