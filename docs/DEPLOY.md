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

`--installers` takes the installers built in `client/desktop/dist` (`npm run dist` in `client/desktop`), and uploads each one to `client/releases` with its checksum and version files. It refuses a build older than `client/oq.py`, or client versions that differ. A download started during the upload can be incomplete.

Nothing is ever deleted on the server, so files removed from the repository stay there, unused. A failed upload stops the transfer and
leaves the manifest unchanged, so the next deployment sends those files again.

The database schema updates itself on the first request after a deployment that changes it, so no SSH command is needed.
Before a deployment that changes `sql/schema.mysql.sql`, make a backup (see [BACKUP.md](BACKUP.md)).

Settings are read from `cache/deploy.json` (git-ignored):

```json
{ "protocol": "sftp", "host": "ftp.clusterXXX.hosting.ovh.net", "user": "LOGIN", "dir": "projects" }
```

`--protocol ftp` uses FTP with TLS through curl, for hosts that support it (OVH does not). The password is then asked, or read from
`PROJECTS_FTP_PASSWORD`, and is never stored. `--host`, `--user` and `--dir` override the settings.

**What is uploaded, and only that:** the root `.htaccess` (`deploy/htaccess.txt`), `.ovhconfig`, `public/`, `src/`, `sql/`, the three
server tools of `bin/`, and `config/config.example.php`. Never `config/config.php`, `storage/`, `cache/`, tests, documentation or the
development router.

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
