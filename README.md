# Open Questions: a collaborative research platform

A web platform where a group of researchers works on an **open question**, combining
human collaboration with AI-produced intermediate results. It supports several research
projects, and every account is an **ORCID** iD.

- **Backend:** plain PHP 8.1+ with PDO (MySQL/MariaDB in production, SQLite for local use). No Composer and no build step.
- **Frontend:** one-page app made of ES modules. It uses Vue 3, Quill 2 (rich text), PDF.js 4 (viewer) and KaTeX (math), all loaded from jsDelivr.

**[Installation instructions](#installation)** · [Try it locally](#2-try-it-on-your-computer) · [AI agent API](docs/AGENT_API.md) · [Backups](docs/BACKUP.md) · [Deployment](docs/DEPLOY.md)

## Features

| Area | What you get |
|---|---|
| **Projects** | Many projects. Each has a title, the open question (rich text with LaTeX), a status (open / solved / archived), and owners and members. |
| **Accounts** | Sign-in through ORCID OAuth (`/authenticate` scope). Owners add researchers by ORCID iD, even if they have never signed in. Their public ORCID name is fetched automatically. |
| **Bibliography** | Add entries by DOI or arXiv id (doi.org content negotiation), by pasting BibTeX (several entries at once), or by hand. You can edit the BibTeX, export the whole project as `.bib`, and copy `\cite{…}`. Each entry can have **one PDF**: upload, replace or remove it, view it in the app, and ask an AI client to **extract its facts**. Progress bars show how many references have a PDF and how many PDFs were extracted, and one button queues all the remaining ones. |
| **Files** | A versioned unit with **one PDF** plus optional **LaTeX sources** (`.tex`, `.bib`, figures, `.zip`). Each file is marked **Human** (teal) or **AI** (violet, with the model name). The mark shows in the list, in a filter, in a badge and as a banner on the file. You can upload a new version (optionally keeping the previous sources) and restore an old version. A restore creates a new version, so history is never lost. You can download a version as `.zip` and preview text sources in the app. |
| **Open questions** | Several big questions per project, split into a tree of sub-questions, with status, priority, comments, unread badges and links to facts, files and references. Each question has **proof strategies** whose every change is a revision, with a timeline and restore. AI clients can propose a **positive or negative answer backed by a fact**, and a human ratifies it once a human has endorsed that fact. Questions and strategies can be commented on and **@mentioned** from messages and comments. |
| **Facts** | A database of statements with proof and intuition, linked by dependencies, in the spirit of the Danus fact graph. Written only by AI clients through the API, so they follow one format: extracted from papers or conversations with a page and quote, or deduced (Danus graphs can be imported). Each fact has Danus labels (counterexample, conclusion, dead end…) and a trace: whether its proof comes from a human or an AI, who is credited, and what it builds on. Humans endorse facts in one click, or accept the result while disputing its proof, and humans and AI can review them (correct / gap / incorrect, and whether the result itself is true), with optional Lean proofs. Anyone can propose another proof of a fact, reviewed on its own: one accepted proof checks the fact. **Project notation** gives one agreed meaning per symbol (for example FS(X) with or without 0): AI clients propose entries and rewrite each fact in the agreed notation beside its unchanged, reviewed text, and definitions live there rather than among the facts. Shown as a filterable list or an interactive graph. Edits create revisions that need fresh reviews, and retracting a fact flags everything that depends on it. Facts have comment threads and can be @mentioned. The platform stores Lean proofs but does not run Lean. |
| **Conversations** | Webmail-style, in three columns: list (Inbox / Starred / Archived, search, unread counts), the selected linear conversation, then comments. Only the chosen subset of researchers sees a conversation, and you can add people later. You can edit your messages, star, archive, mark as unread and leave. |
| **Comments** | Threads (a root comment plus replies) that are separate from conversations. They attach to a conversation, a file or a bibliography entry. Select text in a **PDF** or in a **message** to anchor a thread to that passage. Highlights are drawn on the PDF, and clicking one jumps to its thread and back. Threads can be resolved or reopened. On files, comments are tied to a version. |
| **Universal references** | Type `@` in any rich text to cite a person, question, strategy or strategy version, answer, fact, review, Lean proof, file or file version, reference, conversation, message, comment or project. Chips show the live title and status, with a preview on hover, and never reveal a private conversation to a non-participant. |
| **Feedback** | A button on every page to report a bug or request a feature. Reports are private to their author and the administrators, who set a status and answer, with a badge when something changes. |
| **Dashboards** | A project overview with what needs your attention, progress on the questions, the state of facts and strategies, activity and team, plus a summary page for each section. |
| **Rich text** | Bold, italics, lists, code, links and quotes. **@mentions** of researchers, files and bibliography entries are clickable chips. `$…$` and `$$…$$` are rendered with KaTeX. Ctrl/⌘+Enter sends. |
| **AI agents** | Owners create agents (People → AI agents) that act through an API token. Agents read the project, join the conversations they are added to, comment, and upload files. Everything they write is labelled as AI, and their files are always flagged **AI**. They cannot modify human-written files. See [docs/AGENT_API.md](docs/AGENT_API.md) and the example agent built on Claude in [examples/claude_agent.py](examples/claude_agent.py). |
| **Personal API keys** | Each researcher creates keys on their profile page. Their AI client reads what they can read and submits facts, reviews and Lean proofs, labelled with its model. |
| **Project copy** | Any member can download a `.zip` of everything they can see in a project: question, facts with their traceability, all file versions with sources, bibliography with PDFs, their conversations and comments, as readable documents and JSON. |
| **Search** | A search bar at the top (⌘K or Ctrl K) finds facts, conversations, files, references, comments, people and projects, in the current project or all of them. It ignores accents and only returns what the user can see. PDF contents are not searched. |
| **Guided tour** | First-use speech bubbles present the interface and each project's areas, adapted to the user's role. Progress is saved per account, and the tour can be replayed from the help center. |
| **Help center** | Searchable guides for every feature, in the dashboard. Articles are adapted to the current project, with live pointers to its facts to review, unread items, files and references, and suggested next steps. |
| **Notifications** | You are notified when someone @mentions you, replies to a thread you took part in, or adds you to a project or conversation. Unread badges appear on the left menu. Each file and bib entry has a "Mentions" tab that lists where it was cited. |

All AI-generated content records the model that produced it (required), the user it corresponds to, and its generation time when the client measured it.

Each user has their own read state. New items are highlighted, and iPhone-style red badges count unread items on the left menu, on lists, on graph nodes and on project cards.

Visitors who are not signed in see a public front page presenting these features with screenshots (`public/assets/img/landing/`, from a sample project).

The left vertical menu (Overview · Questions · Mail · Facts · Files · Biblio · People · Help · Feedback · Alerts) switches between these modes, like a webmail client.

## AI work, computed by the team

The platform centralizes and displays the research. All AI computation runs on the members' own computers, with their own Claude or ChatGPT account.

- **Extraction:** a file uploaded by a person queues a task to extract its facts, with exact quotations.
- **Conversations:** a participant can extract the results of a conversation, each cited to its message. A private conversation needs their confirmation, and only the messages present at that moment are read.
- **Comments in extraction:** extraction reads the comments on a file or reference, links them to the facts they concern, and can run again when people change them. Results still come only from the text.
- **Mathematical types:** facts can be browsed by kind, and each one reads like a paper, with definitions, statements, claims and proofs in separate blocks and an outline.
- **Checking:** on request, a model independent of the author reviews a fact, and a client with Lean can add a proof that it compiled in a sandbox with standard axioms only, once another model judges that the Lean statement matches the fact. A proved negation becomes an incorrect review.
- **Administration:** owners have an Admin page: empty the facts database, reset the extraction status of files and reference PDFs, queue extraction again, clear the notation, cancel or retry AI tasks. Destructive actions show what they delete, make a verified backup first and need the project title typed. Administrators run the same actions with `bin/admin.php` or `npm run admin` over SSH.
- **AI clients:** the AI work page shows which clients are online, what each one is doing, its version, and the computing time and tasks it finished in the project over 7 days, 30 days or all time, split between standard tasks and proof searches with the facts these produced. The overview, the project list and the AI page give each project's total. The overview marks members whose client is running.
- **Models:** each member chooses the model for each kind of work in their client. Automatic follows new Claude releases. An extraction is not repeated by a model known to be no stronger than one that finished it (`src/ModelOrder.php`).
- **Questions:** `@AI` in a message or comment, or **Ask AI** in a conversation, queues a task, and the answer appears in the same thread.
- **References:** the AI suggests checkable references, and a person accepts or rejects each one.
- **Derivation:** the AI derives new facts, or `oq.py danus` synchronizes a Danus fact graph.

The client is one Python file with no dependency, [`client/oq.py`](client/oq.py). The help center has step-by-step guides with screenshots for Claude and ChatGPT.

```bash
python3 oq.py setup
python3 oq.py doctor
python3 oq.py run
```

The client lists your projects, and you choose which ones are active or paused on this computer (`python3 oq.py projects`). Usage limits are shared by all active projects, and a paused project's requests remain available to other members.

A client too old for the platform is refused and shows **Update required**. Every change to what the client relies on must be recorded with `npm run protocol` (see [docs/DEPLOY.md](docs/DEPLOY.md)).

`python3 oq.py app` opens the graphic interface, and `client/desktop` packages it as a desktop app with the engine included (`cd client/desktop && npm install && npm run dist`). The Mac build is ad-hoc signed until a Developer ID certificate is configured. To publish an installer, place it in `client/releases` as `open-questions-ai-mac-arm64.dmg`, `-mac-x64.dmg`, `-windows.exe` or `-linux.AppImage`, with its version in a `.version` file (required for update notices) and optionally a `.sha256` file. Clients check GitHub Releases and the connected platform for updates. These files stay out of Git. `npm run deploy -- --installers` builds their checksum and version files and uploads them from `client/desktop/dist`. Users set how much of their subscription the client may use (`oq.py limits`). Its **Prove new facts** feature installs and runs Danus only when a user presses Start (`oq.py danus setup`, `oq.py danus run`), on ChatGPT in an isolated machine by default, or on Claude directly on a Mac as an experimental option (`--engine claude`).

**Publishing a client release.** Raise the version in `client/oq.py` and `client/desktop/package.json`, then create a GitHub Release tagged `vX.Y.Z` with the assets `oq.py` and any of `open-questions-ai-mac-arm64.dmg`, `open-questions-ai-mac-x64.dmg`, `open-questions-ai-windows.exe` and `open-questions-ai-linux.AppImage`. If the release needs new server features, raise `API_LEVEL` on both sides and write `requires-api: N` in the release notes, so that older platforms are not offered it. Drafts and pre-releases are ignored, which allows testing an installer before publishing it.

The AI runs read-only and does not receive the platform key. The content of a task is sent to the AI provider of the member whose client processes it.

## Installation

- [1. Requirements](#1-requirements)
- [2. Try it on your computer](#2-try-it-on-your-computer)
- [3. Prepare a production installation](#3-prepare-a-production-installation)
- [4. Install on your own server](#4-install-on-your-own-server)
- [5. Install on shared hosting (OVH or similar)](#5-install-on-shared-hosting-ovh-or-similar)
- [6. Configuration reference](#6-configuration-reference)
- [7. Check the installation](#7-check-the-installation)
- [8. First steps](#8-first-steps)
- [9. Backups](#9-backups)
- [10. Updating](#10-updating)
- [11. Troubleshooting](#11-troubleshooting)

### 1. Requirements

| Component | Needed | Notes |
|---|---|---|
| **PHP** | 8.1 or newer, 8.2 recommended | Extensions: `pdo_mysql` (or `pdo_sqlite` for local use), `curl`, `dom`, `fileinfo`, `iconv`, `mbstring`, `zip`. `intl` is optional |
| **Web server** | Apache 2.4 with `mod_rewrite` | `.htaccess` files must be allowed. They protect private folders, so other web servers need equivalent rules |
| **Database** | MySQL 8 or MariaDB | SQLite is enough to try the platform locally |
| **HTTPS** | Required in production | ORCID sign-in and secure cookies depend on it |
| **ORCID client** | Free | Required in production, not for a local trial |
| **Node.js** | 22 or newer, on your computer | Only for the deployment script of [section 5](#5-install-on-shared-hosting-ovh-or-similar) |

There is no Composer install and no build step. The browser loads Vue, Quill, PDF.js and KaTeX from the jsDelivr CDN, so users need access to it.

> **Tested so far:** PHP 8.4 with SQLite, on Apache with PHP-FPM and on PHP's built-in server. The MySQL/MariaDB setup and real ORCID sign-in have not been exercised yet, so try them on a test installation first.

Check your PHP version and extensions:

```bash
php -v
php -r 'foreach (["curl","dom","fileinfo","iconv","mbstring","zip","pdo_mysql","pdo_sqlite"] as $e) echo str_pad($e, 12), extension_loaded($e) ? "ok" : "MISSING", PHP_EOL;'
```

### 2. Try it on your computer

This takes a few minutes and needs only PHP with `pdo_sqlite`: no database server and no ORCID account.

```bash
git clone https://github.com/LudovicPatey/projects.git open-questions
cd open-questions
```

Create a local configuration:

```bash
cat > config/config.php <<'PHP'
<?php
return [
    'app_url' => 'http://localhost:8080',
    'env' => 'dev',
    'db' => ['dsn' => 'sqlite:' . __DIR__ . '/../storage/dev.sqlite', 'user' => null, 'password' => null],
    'orcid' => ['client_id' => '', 'client_secret' => '', 'sandbox' => true],
    'storage_path' => __DIR__ . '/../storage',
    'max_upload_mb' => 64,
    'project_creators' => [],
    'feedback_admins' => ['0000-0000-0000-0000'],
];
PHP
```

Create the tables and start the server:

```bash
php bin/install.php
php -S localhost:8080 -t public bin/dev-router.php
```

Open <http://localhost:8080>, and use the **Dev login** form at the top of the page. It accepts any ORCID iD, so you can sign in as several people from different browsers to try collaboration.

> **Never use `'env' => 'dev'` on a public server:** anyone could sign in as anyone.

### 3. Prepare a production installation

You need these three things for both kinds of installation.

**a. A domain with HTTPS,** for example `research.example.org`.

**b. A database.** On shared hosting, create it in the control panel and note its host, name, user and password. On your own server:

```sql
CREATE DATABASE open_questions CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'open_questions'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
GRANT ALL PRIVILEGES ON open_questions.* TO 'open_questions'@'localhost';
FLUSH PRIVILEGES;
```

**c. An ORCID API client:**

1. Sign in at <https://orcid.org/developer-tools> and register for the free **Public API**.
2. Enter your application's name and website.
3. Add this redirect URI, replacing the domain with yours. It must match exactly:

   ```text
   https://research.example.org/auth/callback
   ```

4. Note the **Client ID** (`APP-…`) and **Client secret**.

To test without real ORCID accounts, register at <https://sandbox.orcid.org/developer-tools> instead and set `'sandbox' => true`.

### 4. Install on your own server

These steps are for Debian or Ubuntu with Apache.

**1. Install the packages:**

```bash
sudo apt update
sudo apt install apache2 mariadb-server php libapache2-mod-php php-mysql php-curl php-xml php-mbstring php-zip git certbot python3-certbot-apache
sudo a2enmod rewrite headers
```

**2. Get the code:**

```bash
sudo git clone https://github.com/LudovicPatey/projects.git /var/www/open-questions
cd /var/www/open-questions
```

**3. Create the configuration,** then fill it in as described in [section 6](#6-configuration-reference):

```bash
sudo cp config/config.example.php config/config.php
sudo nano config/config.php
```

**4. Set the permissions.** PHP must be able to write to `storage/`, and only PHP should read the configuration:

```bash
sudo chown -R www-data:www-data storage
sudo chown root:www-data config/config.php
sudo chmod 640 config/config.php
```

**5. Create the tables:**

```bash
sudo -u www-data php bin/install.php
```

**6. Configure Apache.** The document root must be the `public/` folder. Create `/etc/apache2/sites-available/open-questions.conf`:

```apache
<VirtualHost *:80>
    ServerName research.example.org
    DocumentRoot /var/www/open-questions/public

    <Directory /var/www/open-questions/public>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

**7. Enable the site and HTTPS:**

```bash
sudo a2ensite open-questions
sudo systemctl reload apache2
sudo certbot --apache -d research.example.org --redirect
```

The files in `public/` set the upload limit to 64 MB. If uploads are still refused, set these values in `/etc/php/*/apache2/php.ini` and run `sudo systemctl restart apache2`:

```ini
upload_max_filesize = 64M
post_max_size = 80M
```

Continue with [section 7](#7-check-the-installation).

### 5. Install on shared hosting (OVH or similar)

The deployment script runs on **your computer** and uploads the application over SFTP. The hosting needs no SSH command, Node.js or Composer.

The site folder and data folder sit side by side in your hosting account:

```text
~/projects/         the site: the domain points here, only public/ is reachable
~/projects-data/    uploaded files and backups, outside the web root
```

**1. Attach the domain.** In the OVH Control Panel, open **Web Cloud → Hosting → Multisite**, and attach your domain to the root folder `projects`, with SSL enabled.

**2. Create a database** under **Web Cloud → Hosting → Databases**.

**3. Get the code on your computer:**

```bash
git clone https://github.com/LudovicPatey/projects.git open-questions
cd open-questions
mkdir -p cache
```

**4. Set your domain.** If it is not `projects.ludovicpatey.com`, change it in two files:

- the `SITE` constant at the top of `scripts/deploy.mjs`;
- `app_url` in `deploy/config.prod.example.php`.

**5. Enter your FTP account** in `cache/deploy.json`. The host and login are under **Web Hosting → FTP-SSH**. This file stays on your computer:

```json
{ "protocol": "sftp", "host": "ftp.clusterXXX.hosting.ovh.net", "user": "LOGIN", "dir": "projects" }
```

**6. Create the production configuration,** then fill in the database and ORCID values:

```bash
cp deploy/config.prod.example.php cache/config.prod.php
```

**7. Preview, then deploy.** ssh asks for your **FTP password**:

```bash
npm test
npm run deploy -- --dry-run
npm run deploy -- --config
```

`--config` also uploads your configuration. It is refused if a value is missing or if the file is not in production mode. You only need it the first time, or when the configuration changes.

The first page request creates the database tables. More details are in [docs/DEPLOY.md](docs/DEPLOY.md).

### 6. Configuration reference

| Setting | Description |
|---|---|
| `app_url` | Public URL, without a trailing slash. ORCID's redirect URI is built from it |
| `env` | `prod` on a server. `dev` enables the login without ORCID |
| `db.dsn` | For example `mysql:host=localhost;dbname=open_questions;charset=utf8mb4`. On OVH, the host looks like `xxxxx.mysql.db` |
| `db.user`, `db.password` | Database credentials |
| `orcid.client_id`, `orcid.client_secret` | Your ORCID API client |
| `orcid.sandbox` | `true` to use `sandbox.orcid.org` for tests |
| `storage_path` | Folder for uploads. It must be writable by PHP and **outside the web root** |
| `backup.path`, `backup.keep` | Backup folder (default: `backups/` inside the storage path) and number of backups kept (default 14) |
| `max_upload_mb` | Maximum size of an uploaded file. PHP's own limits also apply |
| `feedback_admins` | ORCID iDs of the people who read and answer bug reports and feature requests. **If it is empty, nobody can triage them.** |
| `project_creators` | ORCID iDs allowed to create projects. **Empty means anyone with an ORCID account who signs in** |

> On a public site, set `project_creators` to your own ORCID iD unless you want anyone to be able to create projects:
>
> ```php
> 'project_creators' => ['0000-0000-0000-0000'],
> ```

### 7. Check the installation

Replace the domain with yours:

```bash
curl -s https://research.example.org/api/me
curl -s -o /dev/null -w '%{http_code}\n' https://research.example.org/config/config.php
```

- The first command must show `"user":null` and `"dev":false`.
- The second must **not** print `200`. If it does, stop: your private files are exposed, so check the document root and `.htaccess` support.

Then open the site, sign in with ORCID, and create a test project.

### 8. First steps

1. Sign in with ORCID and create a project with its open question.
2. Under **People**, add your colleagues by ORCID iD. They do not need to have signed in before.
3. Upload papers under **Files** and add references under **Biblio**.
4. To let an AI client work on the project, create a personal key on your **profile page** and give it the instructions shown there. The API is described in [docs/AGENT_API.md](docs/AGENT_API.md).

### 9. Backups

Each member can optionally turn on readable copies of their projects in the AI client, weekly and keeping the last 4 unless changed (`python3 oq.py backup --on`). These do not replace the full server backup below.

```bash
php bin/backup.php                 # verified archive of the database and uploaded files
php bin/backup.php --list
php bin/restore.php ARCHIVE.zip    # checks it, saves the current data, then restores
```

Schedule a daily backup, and **keep a copy off the server**:

- **Your own server:** run `sudo crontab -u www-data -e` and add:

  ```cron
  0 3 * * * cd /var/www/open-questions && php bin/backup.php
  ```

- **OVH:** under **Web Cloud → Hosting → Scheduled tasks (Cron)**, add `projects/bin/backup.php` with PHP 8.2, daily, with email reports enabled.

Archives contain private research and personal data, but not `config/config.php`, so keep a copy of that file somewhere safe. The full procedure, including recovery on a new server, is in [docs/BACKUP.md](docs/BACKUP.md).

### 10. Updating

Back up first.

**Your own server:**

```bash
cd /var/www/open-questions
sudo -u www-data php bin/backup.php
sudo git pull
sudo -u www-data php bin/install.php
```

**Shared hosting,** from your computer:

```bash
git pull
npm run deploy -- --dry-run
npm run deploy
```

The database schema is upgraded automatically on the next request.

### 11. Troubleshooting

| Symptom | What to check |
|---|---|
| `Missing config/config.php` | Create the configuration ([section 4](#4-install-on-your-own-server) or [section 5](#5-install-on-shared-hosting-ovh-or-similar)) |
| Error 500 on every page | Read the PHP error log. Check the database settings, the PHP version and the extensions |
| Error 404 on every page except the home page | `mod_rewrite` is off, or `AllowOverride All` is missing |
| ORCID says the redirect URI is invalid | It must be exactly `app_url` followed by `/auth/callback`, with `https` |
| "ORCID authentication failed" | Wrong client ID or secret, or a sandbox client used with `'sandbox' => false` |
| Uploads fail | Check that `storage_path` is writable, and PHP's `upload_max_filesize` and `post_max_size` |
| API keys answer 401 | The key was revoked, or a proxy dropped the header: send it as `X-Api-Key` |
| Page stuck on "being restored" | A restore was interrupted: see [docs/BACKUP.md](docs/BACKUP.md) |
| Old interface after an update | Reload without cache |

## Project layout

```
public/              ← web root
  index.php          front controller + route table
  app.html           SPA shell (served by index.php only)
  assets/js/         main.js, store, api, editor (Quill+references), references, refs-client, dashboard, pdfviewer, comments, views/*
  assets/css/app.css
src/                 PHP classes (Db, Auth, Orcid, Storage, Sanitizer, References, BibTex, Access, Notify, Controllers/*)
sql/schema.mysql.sql database schema (also auto-converted for SQLite)
config/              config.example.php → config.php
storage/blobs/       uploaded files (content-addressed, outside the web root)
bin/install.php      creates the tables (re-run it after an update: it also applies schema upgrades)
docs/AGENT_API.md    API for AI agents
examples/            example agent (Python, Claude)
bin/dev-router.php   router for `php -S` in local development
deploy/              root .htaccess and production configuration template
scripts/deploy.mjs   upload to the live site (docs/DEPLOY.md)
```

## Security notes

- Every API call checks project membership. Conversations (and their comments) are visible to participants only.
- CSRF token on all state-changing requests. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- Rich text is cleaned server-side by an allow-list HTML sanitizer. Mention chips are rebuilt from their ids, and `javascript:` links are dropped.
- Uploads are stored outside the web root, named by SHA-256. They are served through PHP after an access check, with `nosniff`. Only PDFs are shown inline, and PDF uploads are checked for the `%PDF` signature.

## Ideas for next steps

- Email digests of notifications (OVH provides `mail()`).
- Self-hosting the JS libraries (copy them from jsDelivr into `public/vendor/`) if you prefer no CDN.

## License

Copyright (C) 2026 Ludovic Patey.

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License, version 3](LICENSE), as published by the Free Software Foundation. It is distributed without any warranty.

If you run a modified version as a network service, the license requires you to offer its users the corresponding source code. Point `SOURCE_URL` in `public/assets/js/client-download.js` to your copy. Research data stored in a deployment is not covered by this license.
