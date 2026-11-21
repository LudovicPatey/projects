# Open Questions: a collaborative research platform

A web platform where a group of researchers works on an **open question**, combining
human collaboration with AI-produced intermediate results. It supports several research
projects, and every account is an **ORCID** iD.

- **Backend:** plain PHP 8.1+ with PDO (MySQL/MariaDB on OVH, SQLite for local dev). No Composer and no build step.
- **Frontend:** one-page app made of ES modules. It uses Vue 3, Quill 2 (rich text), PDF.js 4 (viewer) and KaTeX (math), all loaded from jsDelivr.

## Features

| Area | What you get |
|---|---|
| **Projects** | Many projects. Each has a title, the open question (rich text with LaTeX), a status (open / solved / archived), and owners and members. |
| **Accounts** | Sign-in through ORCID OAuth (`/authenticate` scope). Owners add researchers by ORCID iD, even if they have never signed in. Their public ORCID name is fetched automatically. |
| **Bibliography** | Add entries by DOI or arXiv id (doi.org content negotiation), by pasting BibTeX (several entries at once), or by hand. You can edit the BibTeX, export the whole project as `.bib`, and copy `\cite{…}`. Each entry can have **one PDF**: upload, replace or remove it, and view it in the app. |
| **Files** | A versioned unit with **one PDF** plus optional **LaTeX sources** (`.tex`, `.bib`, figures, `.zip`). Each file is marked **Human** (teal) or **AI** (violet, with the model name). The mark shows in the list, in a filter, in a badge and as a banner on the file. You can upload a new version (optionally keeping the previous sources) and restore an old version. A restore creates a new version, so history is never lost. You can download a version as `.zip` and preview text sources in the app. |
| **Facts** | A database of statements with proof and intuition, linked by dependencies, in the spirit of the Danus fact graph. Written only by AI clients through the API, so they follow one format: extracted from papers or conversations with a page and quote, or deduced (Danus graphs can be imported). Each fact has Danus labels (counterexample, conclusion, dead end…) and a trace: whether its proof comes from a human or an AI, who is credited, and what it builds on. Humans endorse facts in one click, and humans and AI can review them (correct / gap / incorrect), with optional Lean proofs. Shown as a filterable list or an interactive graph. Edits create revisions that need fresh reviews, and retracting a fact flags everything that depends on it. Facts have comment threads and can be @mentioned. The platform stores Lean proofs but does not run Lean. |
| **Conversations** | Webmail-style, in three columns: list (Inbox / Starred / Archived, search, unread counts), the selected linear conversation, then comments. Only the chosen subset of researchers sees a conversation, and you can add people later. You can edit your messages, star, archive, mark as unread and leave. |
| **Comments** | Threads (a root comment plus replies) that are separate from conversations. They attach to a conversation, a file or a bibliography entry. Select text in a **PDF** or in a **message** to anchor a thread to that passage. Highlights are drawn on the PDF, and clicking one jumps to its thread and back. Threads can be resolved or reopened. On files, comments are tied to a version. |
| **Rich text** | Bold, italics, lists, code, links and quotes. **@mentions** of researchers, files and bibliography entries are clickable chips. `$…$` and `$$…$$` are rendered with KaTeX. Ctrl/⌘+Enter sends. |
| **AI agents** | Owners create agents (People → AI agents) that act through an API token. Agents read the project, join the conversations they are added to, comment, and upload files. Everything they write is labelled as AI, and their files are always flagged **AI**. They cannot modify human-written files. See [docs/AGENT_API.md](docs/AGENT_API.md) and the example agent built on Claude in [examples/claude_agent.py](examples/claude_agent.py). |
| **Personal API keys** | Each researcher creates keys on their profile page. Their AI client reads what they can read and submits facts, reviews and Lean proofs, labelled with its model. |
| **Notifications** | You are notified when someone @mentions you, replies to a thread you took part in, or adds you to a project or conversation. Unread badges appear on the left menu. Each file and bib entry has a "Mentions" tab that lists where it was cited. |

All AI-generated content records the model that produced it (required), the user it corresponds to, and its generation time when the client measured it.

Each user has their own read state. New items are highlighted, and iPhone-style red badges count unread items on the left menu, on lists, on graph nodes and on project cards.

Visitors who are not signed in see a public front page presenting these features with screenshots (`public/assets/img/landing/`, from a sample project).

The left vertical menu (Question · Mail · Facts · Files · Biblio · People · Alerts) switches between these modes, like a webmail client.

## Layout

```
public/              ← web root (point the domain here)
  index.php          front controller + route table
  app.html           SPA shell (served by index.php only)
  assets/js/         main.js, store, api, editor (Quill+mentions), pdfviewer, comments, views/*
  assets/css/app.css
src/                 PHP classes (Db, Auth, Orcid, Storage, Sanitizer, BibTex, Access, Notify, Controllers/*)
sql/schema.mysql.sql database schema (also auto-converted for SQLite)
config/              config.example.php → config.php
storage/blobs/       uploaded files (content-addressed, outside the web root)
bin/install.php      creates the tables (re-run it after an update: it also applies schema upgrades)
docs/AGENT_API.md    API for AI agents
examples/            example agent (Python, Claude)
bin/dev-router.php   router for `php -S` in local development
```

## Deploying on OVH (web hosting)

1. **Register an ORCID application** at <https://orcid.org/developer-tools> (Public API, free).
   Set the redirect URI to `https://YOUR-DOMAIN/auth/callback`. For tests, use the sandbox
   (`sandbox.orcid.org`) and set `'sandbox' => true`.
2. **Create a database** in the OVH Control Panel (Web Cloud → Hosting → Databases), MySQL 8 / MariaDB.
3. **Upload the project** by FTP/SFTP or Git, for example into `~/research-platform/`.
4. In **Multisite**, set the domain's **root folder** to `research-platform/public`.
   Only `public/` is then exposed. `src/`, `config/`, `sql/` and `storage/` also contain a deny-all `.htaccess`, as a safety net.
5. Copy `.ovhconfig` to the **hosting root** (`~/`) if you don't already have one there. It selects PHP 8.2.
6. `cp config/config.example.php config/config.php` and fill in `app_url`, `db`, `orcid`. Keep `'env' => 'prod'`.
7. Create the tables: either `php bin/install.php` over SSH, or import `sql/schema.mysql.sql` with phpMyAdmin.
8. Make sure `storage/` is writable by PHP. It is by default on OVH.
9. Upload limits: `public/.user.ini` raises them to 64 MB. If your plan ignores it, set them in the OVH panel.
   Also set `max_upload_mb` in the config.

The first person to sign in creates a project and becomes its owner. They then add colleagues by ORCID iD.
To restrict who may create projects, list ORCID iDs in `project_creators`.

## Backup and restoration

```bash
php bin/backup.php                 # verified archive of the database and uploaded files
php bin/backup.php --list
php bin/restore.php ARCHIVE.zip    # checks it, saves the current data, then restores
```

Schedule `bin/backup.php` daily in the OVH panel and keep a copy off the server. The full procedure is in [docs/BACKUP.md](docs/BACKUP.md).

## Local development

```bash
cp config/config.example.php config/config.php   # set 'env' => 'dev' and the SQLite DSN
php bin/install.php
php -S localhost:8080 -t public bin/dev-router.php
```

In dev mode the login page has a **Dev login** form (any ORCID iD, no orcid.org round-trip).
Never enable `'env' => 'dev'` on a public server.

## Security notes

- Every API call checks project membership. Conversations (and their comments) are visible to participants only.
- CSRF token on all state-changing requests. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- Rich text is cleaned server-side by an allow-list HTML sanitizer. Mention chips are rebuilt from their ids, and `javascript:` links are dropped.
- Uploads are stored outside the web root, named by SHA-256. They are served through PHP after an access check, with `nosniff`. Only PDFs are shown inline, and PDF uploads are checked for the `%PDF` signature.

## Ideas for next steps

- Email digests of notifications (OVH provides `mail()`).
- Self-hosting the JS libraries (copy them from jsDelivr into `public/vendor/`) if you prefer no CDN.
