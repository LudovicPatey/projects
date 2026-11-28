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
| **Projects** | Many projects. Each has a title, the open question (rich text with LaTeX), a status (open / solved / archived), and owners and members. A project is **private** (the default): only its members see it. An owner can make it **public** (People → Who can join): every signed-in researcher then sees its card (title, main question, owners, member count, nothing inside) under **Public projects you can join**, and can **ask to join** with a short motivation (20 to 1000 characters). Owners are notified, see the requests with their motivation under People and in **Needs your attention**, and accept (the researcher becomes a member) or decline with an optional note; the requester is notified, can withdraw a pending request, and may ask again a week after a decline. One pending request per researcher and project; AI agents and API keys cannot ask or answer (`src/Controllers/JoinController.php`, `join_requests`). |
| **Accounts** | Sign-in through ORCID OAuth (`/authenticate` scope). Owners add researchers by ORCID iD, even if they have never signed in. Their public ORCID name is fetched automatically. |
| **Bibliography** | Add entries by DOI or arXiv id (doi.org content negotiation), by pasting BibTeX (several entries at once), or by hand. You can edit the BibTeX, export the whole project as `.bib`, and copy `\cite{…}`. Each entry can have **one PDF**: upload, replace or remove it, view it in the app, and ask an AI client to **extract its facts**. Progress bars show how many references have a PDF and how many PDFs were extracted, and one button queues all the remaining ones. |
| **Files** | A versioned unit with **one PDF** plus optional **LaTeX sources** (`.tex`, `.bib`, figures, `.zip`). Each file is marked **Human** (teal) or **AI** (violet, with the model name). The mark shows in the list, in a filter, in a badge and as a banner on the file. You can upload a new version (optionally keeping the previous sources) and restore an old version. A restore creates a new version, so history is never lost. You can download a version as `.zip` and preview text sources in the app. |
| **Open questions** | Several big questions per project, split into a tree of sub-questions, with status, priority, comments, unread badges and links to facts, files and references. Each question has **proof strategies** whose every change is a revision, with a timeline and restore. AI clients can propose a **positive or negative answer backed by a fact**, and a human ratifies it once a human has endorsed that fact. Questions and strategies can be commented on and **@mentioned** from messages and comments. |
| **Facts** | A database of statements with proof and intuition, linked by dependencies, in the spirit of the Danus fact graph. Written only by AI clients through the API, so they follow one format: extracted from papers or conversations with a page and quote, or deduced (Danus graphs can be imported). Each fact has Danus labels (counterexample, conclusion, dead end…) and a trace: whether its proof comes from a human or an AI, who is credited, and what it builds on. A fact is a **cited result** (a result of another work stated without its proof, which only a person who read the source accepts; an AI checks the source as evidence, on its own as soon as the cited result arrives; the native prover may build on any cited result unless people dispute it or its source states something else, and a result worth reading lists the cited results it relies on that nobody accepted yet) or a **proved fact**, whose proof relies only on facts of the database and is reviewed against them; a proof that still uses an outside result directly is flagged, with what relies on it, until that result is linked to the fact that states it. Humans endorse facts in one click, or accept the result while disputing its proof, and humans and AI can review them (correct / gap / incorrect, and whether the result itself is true), with optional Lean proofs. Anyone can propose another proof of a fact, reviewed on its own: one accepted proof checks the fact. **Project notation** gives one agreed meaning per symbol (for example FS(X) with or without 0), for the objects its parameters stand for: an entry `Y \leq X` whose X and Y are infinite block sequences applies to those only, and leaves $\leq$ between numbers alone; the page colors the parameters, gives their type on hover, and says what each choice changes and what it leaves as it is. A letter under a relation, the $c$ of $\le_c$, or typed "not a parameter", names the symbol and is no parameter. Each symbol several facts define says when the notation sweep compares and settles it, or that it left it to the members, and shows its wordings in groups of equivalent ones, each with the entry it is (`notation_classes`). More generally, whatever a sweep is still due on (a rewrite, its check, a source check, a proof review, an entry's types, a second reading) is marked **Not final yet** with that pass, so that nobody fixes by hand what an AI is about to redo. AI clients propose entries and rewrite each fact in the agreed notation beside its unchanged, reviewed text, and each use of a symbol in a fact's formulas is underlined with dots and shows its meaning on hover, and definitions live there rather than among the facts. Extraction proposes no notation: each fact defines its own symbols, and project symbols are decided by a review of the whole project. After the last waiting extraction, an AI client **consolidates** the database: it proposes merging facts that state the same result in two sources, dependencies across sources, correct kinds, remarks that are really open questions, the cited results behind the outside references of proofs, and free **subject tags**; it settles the **project notation** itself (adopting, keeping local or setting aside entries, choosing the most common convention when sources disagree, never changing what a person decided) and queues the rewrite of every fact in it; it marks the facts that are real progress, which appear as **Worth reading** on each member's overview until they open them; it applies at once what it rates with high confidence (except turning a remark into an open question), and notation and tags, which change no result, when it rates them probable too, and people accept or reject the rest; every change is recorded in the history of its facts and can be undone, a merge by an **unmerge** that restores the duplicate with its sources, dependencies, proof, stars and links. An owner can turn automatic changes off. The list and graph filter by tag. Shown as a filterable list or an interactive graph. Members star the facts that matter: the graph can show only the key facts, linked through the others, or the area around one fact, so it stays readable when the database is huge. The interface polls a compact list in columns, and gets `304 Not Modified` when nothing changed, so large databases stay light. Edits create revisions that need fresh reviews, and retracting a fact flags everything that depends on it. Facts have comment threads and can be @mentioned. The platform stores Lean proofs but does not run Lean. |
| **Conversations** | Webmail-style, in three columns: list (Inbox / Starred / Archived, search, unread counts), the selected linear conversation, then comments. A conversation is open to the **whole project** (every member reads and answers it, including those who join later; nobody leaves it, and facts extracted from it need no confirmation) or to **chosen people** only, who can add others later. The choice is made when it starts and is final. You can edit your messages, star, archive, mark as unread and leave a conversation with chosen people. |
| **Comments** | Threads (a root comment plus replies) that are separate from conversations. They attach to a conversation, a file or a bibliography entry. Select text in a **PDF** or in a **message** to anchor a thread to that passage. Highlights are drawn on the PDF, and clicking one jumps to its thread and back. Threads can be resolved or reopened. On files, comments are tied to a version. |
| **Universal references** | Type `@` in any rich text to cite a person, question, strategy or strategy version, answer, fact, review, Lean proof, file or file version, reference, conversation, message, comment or project. Chips show the live title and status, with a preview on hover, and never reveal a private conversation to a non-participant. |
| **Feedback** | A button on every page to report a bug or request a feature. Reports are private to their author and the administrators, who set a status and answer, with a badge when something changes. |
| **Dashboards** | A project overview with what needs your attention, progress on the questions, the state of facts and strategies, activity and team, plus a summary page for each section. |
| **Rich text** | Bold, italics, lists, code, links and quotes. **@mentions** of researchers, files and bibliography entries are clickable chips. `$…$` and `$$…$$` are rendered with KaTeX. Ctrl/⌘+Enter sends. |
| **AI agents** | Owners create agents (People → AI agents) that act through an API token. Agents read the project, join the conversations they are added to and every whole-project conversation, comment, and upload files. Everything they write is labelled as AI, and their files are always flagged **AI**. They cannot modify human-written files. See [docs/AGENT_API.md](docs/AGENT_API.md) and the example agent built on Claude in [examples/claude_agent.py](examples/claude_agent.py). |
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
- **Conversations:** a participant can extract the results of a conversation, each cited to its message. A private conversation (chosen people, when some members are not among them) needs their confirmation; a whole-project one does not, and only the messages present at that moment are read.
- **Comments in extraction:** extraction reads the comments on a file or reference, links them to the facts they concern, and can run again when people change them. Results still come only from the text.
- **Mathematical types:** facts can be browsed by kind, and each one reads like a paper, with definitions, statements, claims and proofs in separate blocks and an outline.
- **Checking:** on request, a model independent of the author reviews a fact, and a client with Lean can add a proof that it compiled in a sandbox with standard axioms only, once another model judges that the Lean statement matches the fact. A checked proof whose whole chain is checked becomes a LaTeX article with its PDF, compiled by a client with LaTeX and added to the files as AI-generated: its dependencies proved before use, results of other works cited. A Lean proof may take dependencies as hypotheses, as the informal proof does, once that model judges that none says more than its fact: it is then shown as compiling relative to them, each with its own Lean state. A proved negation becomes an incorrect review.
- **Administration:** owners have an Admin page: empty the facts database, reset the extraction status of files and reference PDFs, queue extraction again, clear the notation, cancel or retry AI tasks. Destructive actions show what they delete, make a verified backup first and need the project title typed. Administrators run the same actions with `bin/admin.php` or `npm run admin` over SSH. Owners can also create a read-only **audit key** for one project, which expires and can be revoked, and `npm run audit:fetch` saves the project for a local audit, done as `docs/AUDIT.md` describes.
- **Procedures:** reasoning work (answering @AI, reviewing the notation, consolidating the facts) is defined by the platform in `src/Procedures.php`: instructions, the JSON schema of the answer, and how the platform applies it. Clients from 1.12.0 receive the recipe with each task, run it with the model their user chose, and send the answer to `/api/ai/tasks/{id}/answer`, so a new procedure needs no new client unless it needs a new capability. Each new procedure stays off on a computer until its user turns it on (`oq.py procedures`), except those the client release already knew of (from 1.13.0: `source_check`, which reads the source of a cited result).
- **AI clients:** the AI work page shows which clients are online, what each one is doing, its version, and the computing time and tasks it finished in the project over 7 days, 30 days or all time, split between standard tasks and proof searches with the facts these produced. The overview, the project list and the AI page give each project's total. The overview marks members whose client is running.
- **Models:** each member chooses the model for each kind of work in their client. Automatic follows new Claude releases. An extraction is not repeated by a model known to be no stronger than one that finished it (`src/ModelOrder.php`).
- **Questions:** `@AI` in a message or comment, or **Ask AI** in a conversation, queues a task, and the answer appears in the same thread.
- **Instructions:** `@AI` in a comment is an instruction about what it is on (`src/Instructions.php`): an AI replies in the thread and starts what it asks among the actions possible there, each through its own checks. On a fact, a variant beside it (checked by another company's AI, added by a member as a new fact; the fact stays), a correction, a repair, a review; on a question, strategies, sub-questions, searches and a check of the answers; on a file or a reference, a new extraction; on a notation entry, a proposed change. The line under each comment box lists them. Older clients answer the comment as a question.
- **Scheduling:** AI clients take light work someone waits for before heavy background work (`AiTaskController::PRIORITY`: questions, reviews and source checks before consolidation, notation and proof searches, rewrites and extractions last), a member's own request before the same work queued automatically, and a task only once those it waits for are finished (a consolidation after the extractions adding facts; rewrites in the project notation after the consolidation). The AI page shows the queue by kind, with progress, and each kind expands to its tasks in the order they will run.
- **Sweeps:** upkeep no one waits for (checking the sources of cited results, rewriting facts in the project notation, consolidating) is one task per kind and project, queued once the project is quiet and taking what is stale a batch at a time when a client starts it, instead of one task per fact (`src/Sweeps.php`; settings under `sweeps` in `config.php`).
- **AI request limit:** each person makes at most 40 AI requests in any 24 hours (`AiTaskController::MAX_REQUESTS_PER_DAY`). The AI page shows a meter of their use, every AI button its count and greys out at the limit, and only the requests a person makes count, never the platform's own upkeep.
- **Decisions the AI takes for people:** a second AI compares each rewrite in the project notation with its original, and hides one that changes the meaning; another reading of the consolidation's uncertain proposals applies those it agrees with and drops the others; a notation sweep settles the symbols several facts define and the project notation lacks, and types the parameters of entries nobody typed; a member who finds a statement wrong asks for a correction: an AI proposes corrected statements with proofs, an AI of another company checks each against the source, a member chooses which supersede the fact as new facts, and each fact that relied on it is read again, relinked or repaired (`src/StatementFix.php`, `src/Relink.php`); a repair loop answers each flaw an AI review finds: an AI of another company repairs the proof or answers the review, one of the reviewer's side checks it, for up to three rounds, until they agree on a proof or on a gap, or leave it to people (`src/ProofRepair.php`); a review sweep referees the proofs nobody checked independently, in one priority shared with people (`src/Verification.php`: what an answer to a question rests on first, then what results worth reading and many facts rest on), with another company's AI than the proof's author whenever a client has one (the `proof_review` procedure, which each client turns on); a suggested reference whose DOI or arXiv record has its title and first author joins the bibliography (`src/BibCheck.php`, settings under `bib_check`). People can overrule each one, and the project setting that lets the consolidation apply what it is sure of turns the last two off.
- **Answers proposed by the AI:** after extractions, proof searches and new proved facts, the consolidation reads the project's questions with the whole database, and proposes an answer when facts settle one, with its reason and its caveats, as a proposed answer a member ratifies or rejects; undo withdraws it.
- **References:** the AI suggests checkable references, and a person accepts or rejects each one.
- **Derivation:** the AI derives new facts, or `oq.py danus` synchronizes a Danus fact graph.
- **Native prover (experimental):** `oq.py prove` runs a proof search on the project's own facts, in the spirit of Danus (whose Apache-2.0 instructions it adapts): campaigns shared by members' clients, a lead that gives lanes and revises a strategy (every 30 minutes, or a continuous lead session with its own tools), worker sessions with tools served by the client over MCP, a fresh verifier before any fact is created, cited results checked against their source, and `oq.py prove stats` to compare with Danus. See `docs/PROVER.md`. `third_party/danus` keeps the Danus files it adapts, at the commit the client installs, and `npm run danus:upstream` audits what changed upstream so that improvements can be carried over.

The client is one Python file with no dependency, [`client/oq.py`](client/oq.py). The help center has step-by-step guides with screenshots for Claude and ChatGPT.

```bash
python3 oq.py setup
python3 oq.py doctor
python3 oq.py run
```

The client lists your projects, and you choose which ones are active or paused on this computer (`python3 oq.py projects`). Usage limits are shared by all active projects, and a paused project's requests remain available to other members.

A client too old for the platform is refused and shows **Update required**. Every change to what the client relies on must be recorded with `npm run protocol` (see [docs/DEPLOY.md](docs/DEPLOY.md)).

`python3 oq.py app` opens the graphic interface, and `client/desktop` packages it as a desktop app with the engine included (`cd client/desktop && npm install && npm run dist`; `npm run dist:linux` builds the Linux AppImage in Docker from any computer, on Debian 11 so that it runs on most distributions since 2020, x86-64; the **Client installers** GitHub Actions workflow builds every installer on GitHub's computers, each on its own system (Mac Apple Silicon and Intel, Windows, Linux), by hand or for a tag `vX.Y.Z`, and attaches them to a draft release of that tag). The Mac build is ad-hoc signed until a Developer ID certificate is configured. To publish an installer, place it in `client/releases` as `open-questions-ai-mac-arm64.dmg`, `-mac-x64.dmg`, `-windows.exe` or `-linux.AppImage`, with its version in a `.version` file (required for update notices) and optionally a `.sha256` file. Clients check GitHub Releases and the connected platform for updates. These files stay out of Git. `npm run deploy -- --installers` builds their checksum and version files and uploads them from `client/desktop/dist`. Users set how much of their subscription the client may use (`oq.py limits`). Its **Prove new facts** feature merges the project's database into Danus before every start (established facts as facts Danus builds on, unchecked ones as claims its verifier may check and review, strategies as directions; `GET /api/projects/{id}/proving-context`), continues one Danus project per question, and installs and runs Danus only when a user presses Start (`oq.py danus setup`, `oq.py danus run`), on ChatGPT in an isolated machine by default, or on Claude directly on a Mac as an experimental option (`--engine claude`).

**Publishing a client release.** Raise the version in `client/oq.py` and `client/desktop/package.json`, then push a tag `vX.Y.Z`: the **Client installers** workflow builds the Mac (Apple Silicon and Intel), Windows and Linux installers and attaches them, with `oq.py`, to a draft release of that tag. Check it and publish the release, then `npm run deploy -- --installers` downloads them from the release and puts them on the site. In short, a GitHub Release tagged `vX.Y.Z` with the assets `oq.py` and any of `open-questions-ai-mac-arm64.dmg`, `open-questions-ai-mac-x64.dmg`, `open-questions-ai-windows.exe` and `open-questions-ai-linux.AppImage`. If the release needs new server features, raise `API_LEVEL` on both sides and write `requires-api: N` in the release notes, so that older platforms are not offered it. Drafts and pre-releases are ignored, which allows testing an installer before publishing it.

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

**7. Preview, then deploy.** ssh asks for your **FTP password**, unless `~/.netrc` has it (`machine HOST login LOGIN password PASSWORD`, `chmod 600`; see [docs/DEPLOY.md](docs/DEPLOY.md)):

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

- Every API call checks project membership. A public project shows non-members only its card (`GET /api/projects/public`); its contents stay behind membership. Conversations (and their comments) are visible to participants only; every member takes part in a whole-project conversation (`conversations.visibility = 'project'`), joining it when they join the project (`Access::syncProjectConversations`).
- CSRF token on all state-changing requests. Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS. A device stays signed in for 60 days after its last visit through a second cookie, `crp_login` (a random selector and secret; only the secret's SHA-256 is stored, in `login_tokens`), which signs it in again when its PHP session is gone, for example after the host clears idle sessions. A wrong secret for a known selector deletes that login. Signing out deletes it for that device.
- Rich text is cleaned server-side by an allow-list HTML sanitizer. Mention chips are rebuilt from their ids, and `javascript:` links are dropped.
- Uploads are stored outside the web root, named by SHA-256. They are served through PHP after an access check, with `nosniff`. Only PDFs are shown inline, and PDF uploads are checked for the `%PDF` signature.

## Ideas for next steps

- Email digests of notifications (OVH provides `mail()`).
- Self-hosting the JS libraries (copy them from jsDelivr into `public/vendor/`) if you prefer no CDN.

## License

Copyright (C) 2026 Ludovic Patey.

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License, version 3](LICENSE), as published by the Free Software Foundation. It is distributed without any warranty.

If you run a modified version as a network service, the license requires you to offer its users the corresponding source code. Point `SOURCE_URL` in `public/assets/js/client-download.js` to your copy. Research data stored in a deployment is not covered by this license.
