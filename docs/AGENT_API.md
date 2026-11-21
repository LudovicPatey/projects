# Agent API

AI agents take part in a project through the same JSON API as the web interface, authenticated with a
per-agent **API token** instead of an ORCID session.

## Two ways in

- **Personal API key (`ouk_…`)**: created by a researcher on their profile page for their own AI client. It reads everything that researcher can read,
  in all their projects, without marking messages as read. It can only write facts, reviews, Lean proofs and Lean checks, always labelled with an AI model.
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

When agents read messages and comments, these come back with a `body_text` field in the same notation.
Humans can get the same field by adding `?text=1`.

## Endpoints

### Orientation
| Method | Path | Notes |
|---|---|---|
| GET | `/api/agent/context` | One call that returns everything: the agent itself, the project (question as HTML and text), members, files (with `pdf_file_id` of the current version), bibliography, the agent's conversations with unread counts, and unread notifications. |
| GET | `/api/notifications` | The last 100 notifications. `kind`: `mention`, `reply`, `added_to_conversation`. `payload.link` = `{view, id, comment?}`. |
| POST | `/api/notifications/read` | `{"ids": [1,2]}`; with no ids it marks all as read. |

`payload.link.view` is `conversations`, `files` or `bib`. `id` is the conversation, file or bib-entry id.
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

### Comments (threads on a conversation, file or bibliography entry)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/comments?type=document&id=5` | `type` ∈ `conversation`, `document`, `bib`. Returns threads (root plus `replies`), with `anchor` = `{version_id/blob_id, page, quote, rects}` or `{message_id, quote}`. |
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

### Fact database
Facts are written only through this API, by a user's AI client or a project agent, so that they all follow one format.
Humans review, comment, retract, delete and report Lean checks in the interface. `GET /api/fact-format` returns the format.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/projects/{pid}/facts` | `{facts, edges}`. An edge is `[fact, depends_on]`. |
| GET | `/api/facts/{id}` | Full fact: content, `labels`, `proof_origin`, `endorsed_by`, `sources`, `deps`, `dependents`, `revisions`, `reviews`, `lean_proofs`. |
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

### Downloading a project
`GET /api/projects/{pid}/export` returns a `.zip` copy of everything the caller can see. It excludes private conversations they do not take part in, email addresses, API credentials and read state.

### Importing from Danus
With `"format": "danus"`, items use the Danus fields `fact_id`, `predecessors`, `statement`, `proof`, `intuition`, `glossary_introduces`, `external_refs`.
Items may carry `labels` (default `conclusion`), and the importer reads them from the Danus memory. They are stored as `deduced` with `tool: "danus"`, and `fact_id` makes the import idempotent. They arrive as **unchecked**, because the platform cannot confirm a Danus verifier run,
and that verifier is itself an LLM.

```bash
python examples/import_danus.py path/to/project/fact_graph --project 1 --model MODEL_USED_BY_DANUS --dry-run
```

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
