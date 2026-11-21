# Backup and restoration

A backup is one `.zip` archive containing **all platform data**: every application table (projects, users,
conversations, comments, facts, reviews, API key hashes, read state…) and every uploaded file.
Each table and file is checked by SHA-256, and each new archive is fully verified before it is kept.

An archive does **not** contain `config/config.php`, which holds your database password and ORCID secret.
Keep a copy of that file in a password manager.

> **Archives contain private research and personal data.** Treat them like the database itself.
> They are created readable by the owner only, in `storage/backups/`, outside the web root.

## Create a backup

```bash
php bin/backup.php
```

The oldest regular backups are then removed, keeping 14 by default (`backup.keep` in the config, or `--keep=30`).

```bash
php bin/backup.php --list
php bin/backup.php --verify oq-backup-20261121-030000.zip
```

| Exit code | Meaning |
|---|---|
| 0 | Backup created and verified |
| 1 | Failed: no new backup was kept |
| 2 | Backup created, but some uploaded files were already missing or damaged. They are listed: investigate them |

## Automate it on OVH

In the OVH Control Panel, open **Web Cloud → Hosting → your hosting → Scheduled tasks (Cron) → Add**:

- **Command:** `research-platform/bin/backup.php` (path from your hosting root)
- **Language:** PHP 8.2
- **Frequency:** daily, at night
- **Email report:** enabled, so that you hear about failures

Check after the first run that `php bin/backup.php --list` shows the new archive. OVH limits how long a scheduled task may run,
so if your files grow very large, check that backups still finish.

## Keep a copy elsewhere

**A backup stored only on the server does not protect you if you lose the hosting.** Copy archives regularly to another machine:

```bash
rsync -av --include='oq-*' --exclude='*' USER@SSH_HOST:research-platform/storage/backups/ ~/open-questions-backups/
```

Then check what you copied:

```bash
cd ~/open-questions-backups && shasum -a 256 -c oq-backup-20261121-030000.zip.sha256
```

## Restore

Restoring **replaces all current data** with the content of the archive. It needs SSH access to the hosting.

1. Choose the archive:

   ```bash
   php bin/backup.php --list
   ```

2. Restore it:

   ```bash
   php bin/restore.php oq-backup-20261121-030000.zip
   ```

   You will be asked to type `RESTORE`. Use `--yes` in a script.

3. Sign in and check the projects, a few files and the facts.

Exit code 0 means a clean restore, 1 means it failed, and 2 means it completed with a warning about data that was already damaged in the backup.

The tool then proceeds as follows:

1. It verifies the whole archive. If anything is wrong, nothing is changed.
2. It saves the current data to `storage/backups/oq-pre-restore-*.zip`, so **a restore can be undone** by restoring that file. These copies are never removed automatically.
3. The site shows a maintenance page.
4. It restores the files, then replaces the tables in one transaction. On failure, the database stays as it was.
5. It applies any schema upgrade and reopens the site.

Uploaded files that are not in the archive stay on disk, unused. Tables of other software in the same database are never touched.

If the process is killed during a restore, the site stays in maintenance. Run the restore again. To reopen the site with the data as it is, delete `storage/maintenance.flag`.

## Recover on a new server

1. Deploy the application as described in the [README](../README.md).
2. Put your `config/config.php` back, with the new database credentials and URL.
3. Create the tables:

   ```bash
   php bin/install.php
   ```

4. Copy the archive to `storage/backups/`, then restore it. There is nothing to preserve, so you can skip the safety copy:

   ```bash
   php bin/restore.php oq-backup-20261121-030000.zip --no-safety-backup
   ```

An archive can move between MySQL/MariaDB and SQLite. An archive made by a **newer** version of the application is refused: update the application first.

## Test your backups

A backup you have never restored is only a hope. A few times a year, restore the latest archive on a separate installation with its own database and storage folder,
and check that you can sign in and open a project.
