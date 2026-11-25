# Deployment

The live site is <https://projects.ludovicpatey.com>, on OVH web hosting. Files are sent to the folder
`projects/` of the FTP account.

```text
~/projects/         the site: the domain points here, only public/ is reachable
~/projects-data/    uploaded files and backups, outside the web root, never touched by a deployment
```

## Deploying

```bash
npm test                     # checks what would be uploaded
npm run deploy -- --dry-run  # lists what would be uploaded
npm run deploy               # uploads what changed
npm run deploy -- --installers  # also uploads the desktop installers
```

There is no build step. `npm run deploy` checks the PHP syntax, then uploads over SFTP the files whose content changed since
the last deployment to the same target. ssh asks for the **FTP password** in the terminal (an SSH key works too).
The hashes of uploaded files are kept in `cache/deploy-manifest.json`, and `--all` uploads everything again.

`--installers` takes the installers built in `client/desktop/dist` (`npm run dist` in `client/desktop`, and `npm run dist:linux` for the Linux AppImage, which needs Docker running), and uploads each one to `client/releases` with its checksum and version files. It refuses a build older than `client/oq.py`, or client versions that differ. A download started during the upload can be incomplete.

Nothing is ever deleted on the server, so files removed from the repository stay there, unused. A failed upload stops the transfer and
leaves the manifest unchanged, so the next deployment sends those files again.

`npm run deploy` refuses to upload when the client protocol changed without a recorded decision (see below).

### AI clients and protocol changes

The AI clients run on members' computers and are updated by them, so a deployment must not silently break the clients already installed.
`npm run protocol` compares what the client relies on (the routes it calls and all the server code they reach) with the last decision in `protocol/client-protocol.json`.

- If older clients still work, record it: `npm run protocol -- --compatible "reason"`.
- If they would break, release a new client first: raise `VERSION` in `client/oq.py` and `client/desktop/package.json`, then run `npm run protocol -- --breaking "reason"`. This sets the minimum client version in `src/ClientProtocol.php`. Deploy with `--installers` and publish a GitHub release, so that members can update.

The platform answers an older official client with HTTP 426. The client stops working and shows **Update required**, and nothing is lost: waiting tasks stay in the queue. Programs other than the official client, with another `User-Agent`, are not affected.

The database schema updates itself on the first request after a deployment that changes it, so no SSH command is needed.
Before a deployment that changes `sql/schema.mysql.sql`, make a backup (see [BACKUP.md](BACKUP.md)).

## Update existing facts

Facts imported from Danus by older clients may have a kind stored as `lemma`, a title cut from the statement, and external references cut at their commas. The migration repairs those three fields. It **never changes a statement, a proof, a review, a revision number or a modification date**.

**With SSH (recommended).** Deploy, then run one command from your computer:

```bash
npm run deploy
npm run migrate:facts
```

It uses the host and login of `cache/deploy.json`, and ssh asks for the FTP password once. It updates the database schema if needed, shows the preview, and applies only after you type `APPLY`. A verified backup is made first, and nothing changes if it fails.

```bash
npm run migrate:facts -- --details   # also show each change
npm run migrate:facts -- --preview   # preview only
npm run migrate:facts -- --undo      # undo the latest migration, after you type UNDO
```

Undo restores the previous values, except those someone has edited since. Some OVH plans allow SFTP but not SSH commands. In that case, the command stops without changing anything, and you can use a scheduled task.

**Without SSH.** In **Web Cloud → Hosting → your hosting → Scheduled tasks (Cron) → Add**, use **PHP 8.2** and turn on the **email report**. Schedule `projects/bin/migrate-facts-preview.php`, then replace it with `projects/bin/migrate-facts-apply.php`, then **delete the task**. To go back, schedule `projects/bin/migrate-facts-undo.php` once and delete the task. The full preview is saved in `projects-data/migrations/preview-*.json`.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Failed: nothing was changed |
| 2 | Applied, but some facts changed meanwhile and were left alone. Run it again |

Settings are read from `cache/deploy.json` (git-ignored):

```json
{ "protocol": "sftp", "host": "ftp.clusterXXX.hosting.ovh.net", "user": "LOGIN", "dir": "projects" }
```

`--protocol ftp` uses FTP with TLS through curl, for hosts that support it (OVH does not). The password is then asked, or read from
`PROJECTS_FTP_PASSWORD`, and is never stored. `--host`, `--user` and `--dir` override the settings.

**What is uploaded, and only that:** the root `.htaccess` (`deploy/htaccess.txt`), `.ovhconfig`, `public/`, `src/`, `sql/`, the three
server tools of `bin/`, and `config/config.example.php`. Never `config/config.php`, `storage/`, `cache/`, tests, documentation or the
development router.

## Administer a project

Owners have an **Admin** page in each project. Administrators can run the same actions on the server:

```bash
php bin/admin.php --project 3
php bin/admin.php --project 3 reset_facts --requeue
php bin/admin.php --project 3 reset_facts --requeue --apply
```

The first command lists what the project holds and the actions. Without `--apply`, an action only shows what it would change. Actions: `cancel_waiting`, `retry_failed`, `requeue_extraction`, `reset_extraction` (`--requeue`), `clear_notation` (`--all`), `reset_facts` (`--requeue`, `--notation`). The last three delete data and make a verified backup first. The bibliography, its PDFs, files, conversations, questions and members are never changed.

From your computer, over SSH, with the settings of `cache/deploy.json`:

```bash
npm run admin -- --project 3 reset_facts --requeue
```

It shows the preview, then runs the action after you type `APPLY`.

## First installation (once)

1. **Domain.** In the OVH Control Panel, under Web Cloud → Hosting → Multisite, attach `projects.ludovicpatey.com` to the root folder
   `projects`, with SSL enabled. Add the DNS entry if OVH does not offer to do it.
2. **Database.** Under Web Cloud → Hosting → Databases, create a MySQL or MariaDB database, or reuse one: the application only touches its own tables.
3. **ORCID.** At <https://orcid.org/developer-tools>, register a public API client with the redirect URI
   `https://projects.ludovicpatey.com/auth/callback`.
4. **Configuration.** Fill in the production file, which stays on your computer and out of git:

   ```bash
   cp deploy/config.prod.example.php cache/config.prod.php
   ```

5. **Upload**, with the configuration this one time:

   ```bash
   npm run deploy -- --config
   ```

   The upload is refused if the file is incomplete, is not in `prod` mode, or uses the ORCID sandbox.
   On the server it is readable by the account only. Use `--config` again whenever you change it.

6. **Check.** <https://projects.ludovicpatey.com/api/me> must answer
   `{"user":null,...,"dev":false,...}`. This first request creates the tables. Then sign in with ORCID and create a project.

7. **Backups.** Schedule `projects/bin/backup.php` daily, as described in [BACKUP.md](BACKUP.md).

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| `Missing config/config.php` | Run `npm run deploy -- --config` |
| Error 500 on every page | Open Web Hosting → Logs in the OVH panel. Check the database settings and that PHP is 8.2 (`.ovhconfig`) |
| ORCID sign-in fails | The redirect URI registered with ORCID must be exactly `https://projects.ludovicpatey.com/auth/callback` |
| API keys answer 401 | The key was revoked, or a proxy dropped the header: send it as `X-Api-Key` |
| Old interface after a deployment | Reload without cache |
| "being restored" page stays on | A restore was interrupted: see [BACKUP.md](BACKUP.md) |

To go back to an earlier version, check out that commit and run `npm run deploy`. If the schema changed in between, restore the backup
made before the deployment.
