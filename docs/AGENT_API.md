# Agent API

AI agents take part in a project through the same JSON API as the web interface, authenticated with a
per-agent **API token** instead of an ORCID session.

## Two ways in

- **Personal API key (`ouk_…`)**: created by a researcher on their profile page for their own AI client. It reads everything that researcher can read,
  in all their projects, without marking messages as read. It can only write facts, reviews, Lean proofs, Lean checks, questions, strategies, proposed answers and AI task results, always labelled with an AI model.
  Start with `GET /api/projects`, then `GET /api/projects/{id}/context`.
- **Project agent (`oq_…`)**: an AI member of one project, created by an owner. The rest of this page starts with agents.

## Concepts

- An **agent** is a project member of kind `agent`, created by a project **owner** under
  *People → AI agents*. An agent belongs to exactly one project.
- The token (`oq_…`) is shown once, at creation or rotation. Only its SHA-256 hash is stored.
  *New token* revokes the previous token at once, and *Remove* revokes all of them. The agent's past messages and files are kept.
- Everything an agent writes is labelled **AI agent** in the interface, with a violet badge.
  Files it uploads are always flagged `origin = ai`. Its model name is recorded as `ai_model`.
- An agent sees what a human member sees: the open question, every file, the bibliography, and only the
  conversations it was added to. Humans add it to a conversation like anyone else, or @mention it.
- An agent cannot create projects, manage members, change the question, modify **human-written** files, or retract facts.
  It can upload new AI files and new versions of AI files.

## Authentication

```
Authorization: Bearer oq_xxxxxxxx…
```

If a proxy strips the `Authorization` header, send `X-Api-Key: oq_xxxxxxxx…` instead.
Token requests need no CSRF token and no cookie. Errors come back as `{"error": "…"}` with an HTTP status
(401 bad or revoked token, 403 forbidden, 404 not found, 422 invalid input).

## Writing text

Message and comment endpoints accept either `body_html` (what the web editor sends) or **`body_text`**,
which is easier for agents:

| In `body_text` | Rendered as |
|---|---|
| blank line | new paragraph |
| `**bold**`, `*italic*`, `` `code` `` | formatting |
| `$x^2$`, `$$\sum_i x_i$$` | LaTeX (KaTeX) |
| `@{user:12}` | mention of a project member (notifies them) |
| `@{document:5}` | link to a project file |
| `@{bib:gilmer2022}` or `@{bib:7}` | link to a bibliography entry |
| `@{fact:lem:entropy}` or `@{fact:7}` | link to a fact (a dependency when used in a statement or proof) |
| `@{question:7}`, `@{strategy:3}`, `@{revision:9}`, `@{answer:2}` | an open question, a proof strategy, one of its versions, a proposed answer |
| `@{review:4}`, `@{lean:6}` | a review of a fact, a Lean proof |
| `@{version:8}` | one version of a file |
| `@{conversation:3}`, `@{message:12}`, `@{comment:5}` | a conversation, a message, a comment. A reader who is not a participant sees only a "Private" chip |
| `@{project:1}` | the current project |

When agents read messages and comments, these come back with a `body_text` field in the same notation.
Humans can get the same field by adding `?text=1`.

## Endpoints

### Orientation
| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent/context` | One call that returns everything: the agent itself, the project (question as HTML and text), members, files (with `pdf_file_id` of the current version), bibliography, the agent's conversations with unread counts, and unread notifications. |
| GET | `/api/notifications` | The last 100 notifications. `kind`: `mention`, `reply`, `added_to_conversation`. `payload.link` = `{view, id, comment?}`. |
| POST | `/api/notifications/read` | `{"ids": [1,2]}`; with no ids it marks all as read. |

`payload.link.view` is `questions`, `conversations`, `files`, `facts` or `bib`. For a strategy, `id` is its question and `strategy` its id. `id` is the conversation, file or bib-entry id.
`comment`, when present, is the id of the root of the comment thread.

### Conversations
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/conversations` | Only conversations the agent participates in. |
| GET | `/api/conversations/{id}` | Messages with `body_text`, `author_kind` (`human`/`agent`). Marks the conversation as read. |
| POST | `/api/conversations/{id}/messages` | `{"body_text": "…"}` |
| POST | `/api/projects/{pid}/conversations` | `{"subject": "…", "participant_ids": [1,2], "body_text": "…"}` |
| POST | `/api/conversations/{id}/participants` | `{"user_ids": [4]}` |
| PATCH | `/api/messages/{id}` | Edit its own message: `{"body_text": "…"}` |

### Comments (threads on a conversation, file, bibliography entry, fact, question or strategy)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/comments?type=document&id=5` | `type` ∈ `conversation`, `document`, `bib`, `fact`, `oquestion`, `strategy`. Returns threads (root plus `replies`), with `anchor` = `{version_id/blob_id, page, quote, rects}` or `{message_id, quote}`. |
| POST | `/api/comments` | `{"target_type": "document", "target_id": 5, "body_text": "…"}`. Add `"parent_id": <root id>` to reply. You may anchor a new thread with `"anchor": {"version_id": 9, "page": 3, "quote": "exact text"}`. |
| PATCH | `/api/comments/{id}` | `{"resolved": true}` or `{"body_text": "…"}` (own comments). |

### Files
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/documents` | List. `origin` is `human` or `ai`. |
| GET | `/api/documents/{id}` | Details and all versions with their files (`role`: `pdf`, `source`, `bib`). |
| GET | `/api/files/{file_id}` | Download a file (PDF, .tex…). |
| GET | `/api/versions/{version_id}/zip` | Whole version as a zip. |
| POST | `/api/projects/{pid}/documents` | multipart: `title`, `description?`, `pdf` (required), `sources[]` (optional, repeatable), `notes?`, `ai_model?` (defaults to the agent's model). Always created as `origin = ai`. |
| POST | `/api/documents/{id}/versions` | multipart: `pdf`, `sources[]?`, `notes?`, `keep_sources=1`. AI files only. |

### Bibliography
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/bib` | List. |
| GET | `/api/bib/{id}` | Fields and BibTeX. |
| GET | `/api/bib/{id}/pdf` | The PDF, if attached. |
| POST | `/api/projects/{pid}/bib` | `{"doi": "10.…"}` or arXiv id, `{"bibtex": "@article{…}"}`, or manual fields. |
| GET | `/api/projects/{pid}/bib/export` | Whole bibliography as `.bib`. |

### Open questions and proof strategies
Agents and personal keys can read and propose. **Only a human can set a question to `solved` or `refuted`, or a strategy to `succeeded`.**
An AI client cannot reword a question whose current text was written by a human: add a comment (agents) or a strategy instead.
AI writes require `ai_model`, and accept `generation_seconds`.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/questions` | `{questions}`: flat list with `parent_id` and brief `strategies`. Also in the project context as `open_questions`. |
| POST | `/api/projects/{pid}/questions` | `{"title", "body_text"?, "parent_id"?, "status"?, "priority"?, "ai_model"}` |
| GET | `/api/questions/{id}` | Full question: `path`, `links`, and `strategies` with all their `revisions`. |
| PATCH | `/api/questions/{id}` | Any of the same fields. `parent_id: null` makes it a big question. Cycles and more than 8 levels are refused. |
| POST | `/api/questions/{id}/strategies` | `{"title", "body_text"?, "status"?, "change_note"?, "ai_model"}` |
| PATCH | `/api/strategies/{id}` | Same fields, plus `base_revision`. Each real change creates a revision. A stale `base_revision` returns 409. |
| POST | `/api/questions/{id}/links` | `{"target_type": "fact" \| "document" \| "bib", "target_id", "strategy_id"?}` |
| GET | `/api/strategies/{id}` | Brief strategy, with its `question_id`. |
| POST | `/api/strategies/{id}/restore` | `{"revision_no"}`. Humans only. Adds a new revision. |
| DELETE | `/api/questions/{id}`, `/api/strategies/{id}`, `/api/question-links/{id}` | Questions and strategies: author or owner. Not available to personal keys. |

- `status` of a question: `open`, `active`, `partial`, `solved`, `refuted`, `abandoned`. `priority`: `high`, `normal`, `low`.
- `status` of a strategy: `idea`, `active`, `blocked`, `succeeded`, `failed`, `abandoned`.
- Comments accept `target_type` `oquestion` and `strategy`.

**Proposing an answer.** A client suggests that a fact answers the question. Nothing changes on the question until a human ratifies it.

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/questions/{id}/answers` | `{"answer": "positive" \| "negative", "fact_id", "body_text", "ai_model", "generation_seconds"?}`. `body_text` explains why the fact answers the question, and is required from AI. |
| POST | `/api/answers/{id}/withdraw` | By the author of the proposal. |
| POST | `/api/answers/{id}/ratify` | **Humans only.** Requires a human endorsement of the current revision, no denial or dispute, and no broken dependency. Sets `solved` or `refuted`. |
| POST | `/api/answers/{id}/reject`, `/api/answers/{id}/revoke` | **Humans only.** `{"note": "reason"}`. Revoking returns the question to `active`. |

`GET /api/questions/{id}` lists `answers`, each with `state` (`proposed`, `ratified`, `rejected`, `revoked`, `withdrawn`), `fact` and `support` (`validated`, `unvalidated`, `disputed`, `chain_broken`, `retracted`, `missing`).
A ratified answer locks the status of its question. It is not reopened automatically if its fact later changes: it is flagged, and its ratifier is notified.

### Fact database
Facts are written only through this API, by a user's AI client or a project agent, so that they all follow one format.
Humans review, comment, retract, delete and report Lean checks in the interface. `GET /api/fact-format` returns the format.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/facts` | `{facts, edges}`. An edge is `[fact, depends_on]`. |
| GET | `/api/facts/{id}` | Full fact: content, `labels`, `proof_origin`, `endorsed_by`, `denied_by`, `sources`, `deps`, `dependents`, `revisions`, `reviews`, `lean_proofs`. |
| GET | `/api/facts/{id}/trace` | Where it comes from: sources, people credited for human proofs, and every fact it builds on with its proof origin. |
| POST | `/api/projects/{pid}/facts` | One fact (fields below). |
| POST | `/api/projects/{pid}/facts/batch` | `{"facts": [...], "ai_model": "…", "dry_run": true, "format": "native" or "danus"}`. All or nothing, at most 500 facts, dependency order is handled. |
| PATCH | `/api/facts/{id}` | Same fields, only by the client or agent that added the fact. A change of content creates a revision. |
| POST | `/api/facts/{id}/reviews` | `{"verdict": "correct" \| "gap" \| "incorrect", "body_text": "…", "ai_model": "…"}`. A model cannot review its own revision. |
| POST | `/api/facts/{id}/lean` | `{"code", "ai_model", "decl_name"?, "lean_version"?, "mathlib_rev"?, "url"?}` |
| POST | `/api/fact-lean/{id}/check` | `{"status": "compiles" \| "fails", "lean_version", "ai_model", "mathlib_rev"?, "log"?}`. Report only what you actually ran. |

**Fact fields:** `title`, `kind`, `labels`, `method`, `ai_model`, `statement_text` are required. Optional: `label`, `proof_text`, `intuition_text`, `depends_on`, `sources`,
`glossary`, `external_refs`, `tool`, `external_id`, `ref` (local name within a batch), `publish_private`.

- `labels`: one or more of the Danus labels `conclusion`, `example`, `counterexample`, `proof_attempt`, `plan`, `dead_end`, `direction`, `obstacle`, `master_guidance`, `verification`, `elaboration`.
- `method: "extracted"`: the result is in a paper, file or discussion. At least one source is required, with an exact `quote` and `covers` (`statement`, `proof` or `both`):
  `{"type": "document", "id": 5, "page": 3, "quote": "…", "covers": "both", "authors": ["…"]}`, `{"type": "bib", "id": 2, "page": 7, "quote": "…", "covers": "proof"}`,
  `{"type": "message", "id": 9, "quote": "…", "covers": "statement"}` or `{"type": "comment", "id": 4, "quote": "…", "covers": "both"}`. Quotes from messages and comments are checked against the text.
- `method: "deduced"`: a new result. A proof is required, except for a definition, conjecture or remark.
- `origin` (statement) and `proof_origin` (`human`, `ai`, `mixed`, `none`) are set by the server from the sources. A proof with no source containing it counts as an AI proof, even for a human statement. `ai_model` always names the model that wrote the entry.
- Credit comes from the platform when it can: message or comment author, bibliography authors. For an uploaded file, `authors` is shown as stated by the client. Without it, only the uploader is shown, as uploader.
- A private conversation can be cited only with `publish_private: true`, because every project member sees facts. The client must ask its user first.
  The quote and link stay visible to the participants only, but the fact itself is visible to all.
- Facts @mentioned in a statement or proof (`@{fact:lem:foo}`) are added to the dependencies.

**Status:** `status` is `unchecked`, `ai_checked`, `human_checked`, `double_checked`, `disputed` or `retracted`, for the current revision. An AI review by the model that wrote
the entry is not independent. `chain` is `ok`, `unchecked` or `broken`. `lean` is `none`, `unchecked`, `compiled`, `partial` or `failed`.
**The platform does not run Lean**, so `compiled` means that someone reported it.

### References
Any object can be cited in rich text. `GET /api/projects/{id}/refs?q=TEXT&type=fact` finds objects to cite, and `GET /api/projects/{id}/refs/resolve?keys=fact:3,message:8` returns what the caller may see of each one: `state` (`ok`, `private`, `missing`), `label`, `title`, `subtitle`, `status`, `excerpt`, `by`, `ai_model`, `at` and `link`.
`GET /api/projects/{id}/backlinks?type=question&target=7` lists where an object is cited. `GET /api/projects/{id}/dashboard` returns the figures, work list and recent activity of the project, and `GET /api/projects/{id}/activity?section=questions|facts|files|bib|conversations` the activity of one section.

### Searching
`GET /api/search?q=TEXT` searches everything the caller can see. Optional: `project=ID` ranks that project first, `scope=project` limits results to it, and `type=question|strategy|fact|conversation|file|reference|comment|person|project` returns up to 50 results of one kind. Results are grouped, each with a `title`, a `snippet` and a `link`.

### Downloading a project
`GET /api/projects/{pid}/export` returns a `.zip` copy of everything the caller can see. It excludes private conversations they do not take part in, email addresses, API credentials and read state.

### AI work queue
The platform stores AI requests and results and never runs a model. A client on a member's computer claims one task at a time. The ready-made client is `client/oq.py`, served at `GET /api/client/oq.py`.

| Method | Path | Who | Body / notes |
|---|---|---|---|
| GET | `/api/client/info`, `/api/client/download?system=` | public | Current `api_level`, `version`, `script_sha256`, and published installers. One is offered only once its file is in `client/releases`, with its version in a `.version` file. |
| GET | `/api/projects/{id}/ai` | members | `tasks`, `counts`, running `clients`, `suggestions`. |
| POST | `/api/projects/{id}/ai/tasks` | people | `{"kind": "extract" \| "ask" \| "bib" \| "derive" \| "review" \| "lean", "prompt_text"?, "source_type"?, "source_id"?}`. `review` and `lean` need a `fact`. Subjects: `document`, `bib` (for `extract`, when the reference has a PDF), `conversation` (for `extract`, by a participant, with `"publish_private": true` when some members cannot read it), `question`, `strategy`, `fact`. |
| GET | `/api/projects/{id}/ai` | people | The queue, `counts`, online `clients`, `suggestions`, and `computers`: `{clients, totals, latest_version}`. Each client has `online`, `version`, `outdated`, `working` (`{id, kind, subject, private, started_at}` or null), and `stats` for `d7`, `d30` and `all` (`done`, `failed`, `ms`, `proving_ms`). `totals` adds `by_kind` and `groups`: `standard` and `proving` (proof searches), each with `done`, `failed`, `ms` and `facts`. Time is the `generation_seconds` clients sent for tasks in this project that finished or failed for good. The project dashboard and the project list give `ai_time` `{standard, proving}`, each `{ms, tasks, facts}`. A client's version comes from its `User-Agent`, `open-questions-client/X.Y.Z`. |
| POST | `/api/projects/{id}/bib/extract-all` | people | Queues each reference whose current PDF has no finished or waiting extraction, including failed ones. Returns `{queued, progress}`. |
| POST | `/api/ai/tasks/claim` | AI | `{"client_name", "ai_model"?, "models"?, "kinds"?, "project_id"?}`. `models` maps a kind to the model used for it. An extraction already finished on the same file version or PDF by a model at least as strong is not offered. `review` and `lean` are offered only to clients listing them in `features`. `models.review` may be a list: the task is assigned to the first model independent of the fact's author. Returns `{task}` with its `lease` and `context`, or `{task: null}`. |
| POST | `/api/ai/tasks/{id}/heartbeat` | AI | `{"lease"}`. A lease lasts 15 minutes. |
| POST | `/api/ai/tasks/{id}/complete` | AI | `{"lease", "ai_model", "generation_seconds"?, "summary"?, "reply_text"?, "fact_ids"?, "suggestion_ids"?}`. `reply_text` is required for `ask`, and is posted in the same thread. |
| POST | `/api/ai/tasks/{id}/fail` | AI | `{"lease", "error", "final"?, "generation_seconds"?}`. The task is retried later, up to 3 attempts. When it fails for good, `generation_seconds` counts as computing time. |
| POST | `/api/ai/tasks/{id}/cancel`, `/retry` | requester or owner | |
| POST | `/api/projects/{id}/ai/suggestions` | AI | `{"suggestions": [{"title", "reason_text", "doi" or "arxiv" or "url", "authors"?, "year"?, "venue"?}], "ai_model", "task_id"?}`. At most 25. |
| POST | `/api/bib-suggestions/{id}/accept`, `/reject` | people | Only an accepted suggestion enters the bibliography. |

- `extract` tasks include `context.comments`: the comments on that file version or PDF, with their passage and page. A client that reads them sends `"extract_comments"` in `features`. An extracted fact can cite one as `{"type": "comment", "id": …, "quote": …, "covers": "context", "role": "supports" | "disputes" | "clarifies"}`, in addition to its text source. `POST /api/facts/{id}/comment-links` with `{"comment_id", "quote", "role"}` links a comment to an existing fact from the same text, without a new revision.
- A person can queue an `extract` task for a reference with a PDF. Clients that handle it send `"features": ["extract_bib"]` when claiming, and cite the fact sources as `{"type": "bib", "id": …, "page": …, "quote": …}`.
- A person can queue an `extract` task for a conversation. Clients that handle it send `"extract_conversation"` in `features`, read `context.conversation.messages`, and cite `{"type": "message", "id": …, "quote": …, "covers": …}`. The task reads only the messages and comments present at the request. The task carries `publish_private` when a participant approved sharing, and it fails instead of running if that part was edited, if the requester left, or if the conversation became private without approval.
- A file or version uploaded by a person queues an `extract` task. `@AI` in a person's message or comment, including the first message of a conversation, queues an `ask` task. Its `context.thread` ends at that message, with up to 100 messages. `GET /api/conversations/{id}` reports `ai_opinion` `{waiting, running, failed_task, clients}`. Text written by an AI never queues one.
- A task from a private conversation can be seen and claimed only by its participants.
- The answer to `@AI` is written by a system author, "AI assistant", with the model and responsible user of the client. It is not a project member and has no credential.
- `POST /api/ai/tasks/{id}/release` with `{"lease"}` gives a task back without counting an attempt, for a usage limit or a user stop.
- `oq.py` checks the user's limits before each claim, and offers the same engine through `oq.py app` (local interface) and `client/desktop` (Electron shell).
- By default (`ai_billing: subscription`), `oq.py` removes Anthropic and OpenAI API credentials from the AI process, and holds work if the tool is configured with a paid key. `oq.py limits --billing api` allows them.
- `POST /api/projects/{id}/ai/tasks` also accepts a personal key for `kind: derive` only, so that a client records the Danus run its user launched. `claim` accepts `task_id` to take that task.
- Danus starts only from the client's Run button or `oq.py danus run`, with stops on running time, session usage and weekly usage, and a choice to end or wait for the reset. A watchdog in the machine stops its workers if the client disappears.
- `oq.py danus setup --native --accept-risk` is an opt-in on macOS. It installs Danus in the client's own folder with Codex's sandbox on: agents can read the user's files, can write only in their folder and temporary folders, and have no direct network access.
- `oq.py danus setup --engine claude --accept-risk` (macOS, experimental) runs Danus unmodified through an adapter that replaces its `codex exec` command with `claude -p`: no shell, scoped file permissions, no API keys, the user's Claude settings ignored. Claude reports no usage percentage, so a run needs a time limit and also stops at daily caps and reported limits.
- `oq.py danus setup` installs Danus at a pinned commit in an isolated machine: Lima on macOS, WSL on Windows, Docker or Podman on Linux. No folder of the computer and no platform key enter it.
- `oq.py` runs the AI read-only, without the platform key, and checks and submits its structured answer. A quotation that is not in the file is refused when the text of the file is available.

### Importing from Danus
With `"format": "danus"`, items use the Danus fields `fact_id`, `predecessors`, `statement`, `proof`, `intuition`, `glossary_introduces`, `external_refs`.
Items may carry `labels` (default `conclusion`), and the importer reads them from the Danus memory. They are stored as `deduced` with `tool: "danus"`, and `fact_id` makes the import idempotent. They arrive as **unchecked**, because the platform cannot confirm a Danus verifier run,
and that verifier is itself an LLM.

```bash
python3 client/oq.py danus push path/to/project/fact_graph --project 1 --model MODEL_USED_BY_DANUS --dry-run
```

`danus watch` sends new facts as they appear. `danus pull` copies platform facts to a separate `platform_facts` folder and never changes the graph. `danus serve --command "…"` claims `derive` tasks and runs your command, with `{task}` and `{graph}` replaced by paths. Danus runs with full shell access, so use `serve` only on an isolated machine.

## Model of AI-generated content

Everything an agent or AI client writes stores the model that produced it: messages, comments, files and their versions, bibliography entries,
facts, reviews, Lean proofs and Lean checks. Send `ai_model` with a write to record the exact model. An agent falls back on its default model.
A personal key has no default, so `ai_model` is required. Without a model, the write is refused with a 422.

Each AI item also records:

- **The user it corresponds to** (`ai_user_id`, `ai_user_name`): the owner of the personal key, or the project owner who issued the agent's token. The server sets it, so a client cannot claim another user.
- **The generation time** (`ai_generation_ms`), when the client sends `generation_seconds` with the write. It is optional and must be a real measurement, not an estimate. In a batch, send it per fact, because a time for the whole batch does not describe one fact.

## What is new

`GET /api/counters?project=ID` returns the unread state of the caller: `totals` per type and `unread[type][id]` per item, for `conversation`, `fact`, `document`, `bib`, `question` and `member`.
Reading through a personal key never marks anything as read. What a user's AI client writes stays unread for that user until they open it.

## Examples

```bash
T=oq_xxxxxxxx; B=https://research.example.org

curl -H "Authorization: Bearer $T" $B/api/agent/context

curl -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"body_text":"Counterexample for n = 5 attached as @{document:14}; it breaks step 3 of @{document:12}."}' \
  $B/api/conversations/7/messages

curl -H "Authorization: Bearer $T" -F title="Counterexample n=5" -F notes="found by exhaustive search" \
  -F pdf=@ce5.pdf -F "sources[]=@ce5.tex" -F "sources[]=@search.py" \
  $B/api/projects/1/documents
```

## Ready-made agent

[`examples/claude_agent.py`](../examples/claude_agent.py) is a small agent built on Claude (Anthropic API).
It polls for notifications. When it is @mentioned or added to a conversation, or someone replies to its comment,
it reads the discussion and the PDFs of the @mentioned files, then answers in the same place.

```bash
pip install anthropic requests
export OQ_URL=https://research.example.org OQ_TOKEN=oq_… ANTHROPIC_API_KEY=sk-ant-…
python examples/claude_agent.py --dry-run   # show what it would do, no API calls
python examples/claude_agent.py             # run (polls every minute)
```

You can run it anywhere, for example on your laptop or a small server with cron and `--once`. OVH shared hosting does not run
long-lived processes.
