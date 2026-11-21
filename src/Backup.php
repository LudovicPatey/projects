<?php
declare(strict_types=1);

namespace App;

use PDO;

/**
 * Backup and restoration of the platform: every application table plus the uploaded files,
 * in one self-checking zip archive. The database is stored as JSON lines, so an archive
 * can be restored on MySQL/MariaDB or SQLite. Secrets from config/config.php are not included.
 */
final class Backup
{
    public const FORMAT = 1;
    private const PREFIX = 'oq-backup';
    private const SAFETY_PREFIX = 'oq-pre-restore';

    /** @var resource|null */
    private static $lock = null;

    public static function dir(): string
    {
        $default = rtrim((string)Config::get('storage_path'), '/') . '/backups';
        $dir = rtrim((string)Config::get('backup.path', $default), '/');
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create the backup folder $dir");
        }
        return $dir;
    }

    public static function maintenanceFile(): string
    {
        return rtrim((string)Config::get('storage_path'), '/') . '/maintenance.flag';
    }

    /** Creates, then fully verifies, a new archive. @return array{file:string, size:int, manifest:array} */
    public static function create(): array
    {
        self::lock();
        try {
            return self::build(self::PREFIX);
        } finally {
            self::unlock();
        }
    }

    /** Checks the structure and the SHA-256 of everything in an archive. @return array the manifest */
    public static function verify(string $file): array
    {
        if (!is_file($file)) throw new \RuntimeException("Archive not found: $file");
        $zip = new \ZipArchive();
        $code = $zip->open($file, \ZipArchive::RDONLY | \ZipArchive::CHECKCONS);
        if ($code !== true) throw new \RuntimeException("The archive is damaged (zip error $code).");
        try {
            $raw = $zip->getFromName('manifest.json');
            $m = $raw === false ? null : json_decode($raw, true);
            if (!is_array($m) || ($m['app'] ?? '') !== 'open-questions') throw new \RuntimeException('This is not an Open Questions backup.');
            if (($m['format'] ?? 0) !== self::FORMAT) throw new \RuntimeException('Unsupported backup format: ' . json_encode($m['format'] ?? null));
            if (!is_array($m['tables'] ?? null) || !is_array($m['blobs'] ?? null)) throw new \RuntimeException('The manifest is incomplete.');
            foreach ($m['tables'] as $table => $t) {
                self::assertName((string)$table);
                foreach ($t['columns'] ?? [] as $column) self::assertName((string)$column);
                $stream = $zip->getStream("db/$table.jsonl");
                if (!$stream) throw new \RuntimeException("Table $table is missing from the archive.");
                $hash = hash_init('sha256');
                $rows = 0;
                while (($line = fgets($stream)) !== false) { hash_update($hash, $line); $rows++; }
                fclose($stream);
                if (!hash_equals((string)$t['sha256'], hash_final($hash)) || $rows !== (int)$t['rows']) {
                    throw new \RuntimeException("Table $table is corrupted in the archive.");
                }
            }
            foreach ($m['blobs'] as $b) {
                $sha = (string)($b['sha256'] ?? '');
                self::assertSha($sha);
                $stream = $zip->getStream(self::blobEntry($sha));
                if (!$stream) throw new \RuntimeException("File $sha is missing from the archive.");
                $hash = hash_init('sha256');
                hash_update_stream($hash, $stream);
                fclose($stream);
                if (!hash_equals($sha, hash_final($hash))) throw new \RuntimeException("File $sha is corrupted in the archive.");
            }
            return $m;
        } finally {
            $zip->close();
        }
    }

    /**
     * Replaces the application data by the content of an archive. Nothing is changed unless the
     * archive is valid, and the database import is all or nothing.
     * @return array{manifest:array, safety:?string, broken_references:int}
     */
    public static function restore(string $file, bool $safetyBackup = true): array
    {
        @set_time_limit(0);
        self::lock();
        $flag = self::maintenanceFile();
        try {
            $m = self::verify($file);
            Db::install();
            self::assertCompatible($m);
            self::assertSpace((int)array_sum(array_column($m['blobs'], 'size')));

            $safety = $safetyBackup ? self::build(self::SAFETY_PREFIX)['file'] : null;

            if (file_put_contents($flag, gmdate('c')) === false) throw new \RuntimeException('Cannot enable maintenance mode.');
            $zip = new \ZipArchive();
            if ($zip->open($file, \ZipArchive::RDONLY) !== true) throw new \RuntimeException('Cannot read the archive.');
            try {
                self::restoreBlobs($zip, $m);
                $broken = self::restoreTables($zip, $m);
            } finally {
                $zip->close();
            }
            Db::install(); // applies schema upgrades when the archive is older than the application
            return ['manifest' => $m, 'safety' => $safety, 'broken_references' => $broken];
        } finally {
            @unlink($flag);
            self::unlock();
        }
    }

    /** Keeps the newest regular backups. Safety copies made before a restore are never removed. */
    public static function prune(?int $keep = null): array
    {
        $keep = max(1, $keep ?? (int)Config::get('backup.keep', 14));
        $files = glob(self::dir() . '/' . self::PREFIX . '-*.zip') ?: [];
        rsort($files);
        $removed = [];
        foreach (array_slice($files, $keep) as $f) {
            if (unlink($f)) { @unlink($f . '.sha256'); $removed[] = basename($f); }
        }
        return $removed;
    }

    /** @return list<array{name:string, path:string, size:int, date:string}> newest first */
    public static function list(): array
    {
        $files = glob(self::dir() . '/oq-*.zip') ?: [];
        usort($files, fn($a, $b) => filemtime($b) <=> filemtime($a) ?: strcmp($b, $a));
        return array_map(fn($f) => ['name' => basename($f), 'path' => $f, 'size' => (int)filesize($f), 'date' => gmdate('Y-m-d H:i', (int)filemtime($f)) . ' UTC'], $files);
    }

    // ---------------------------------------------------------------------

    private static function build(string $prefix): array
    {
        @set_time_limit(0);
        $dir = self::dir();
        $name = $prefix . '-' . gmdate('Ymd-His');
        for ($i = 2; file_exists("$dir/$name.zip"); $i++) $name = $prefix . '-' . gmdate('Ymd-His') . "-$i";
        $target = "$dir/$name.zip";
        $part = "$target.part";
        $tmp = "$dir/.tmp-" . bin2hex(random_bytes(6));
        if (!mkdir($tmp, 0700)) throw new \RuntimeException('Cannot create a temporary folder.');
        try {
            [$tables, $rows] = self::dumpTables($tmp);
            $blobs = []; $problems = []; $bytes = 0;
            foreach ($rows as $b) {
                $path = Storage::pathFor($b['sha256']);
                if (!is_file($path)) {
                    $problems[] = ['sha256' => $b['sha256'], 'problem' => 'missing'];
                } elseif (hash_file('sha256', $path) !== $b['sha256']) {
                    $problems[] = ['sha256' => $b['sha256'], 'problem' => 'corrupted'];
                } else {
                    $size = (int)filesize($path);
                    $blobs[] = ['sha256' => $b['sha256'], 'size' => $size];
                    $bytes += $size;
                }
            }
            self::assertSpace($bytes);
            $manifest = [
                'app' => 'open-questions', 'format' => self::FORMAT, 'created_at' => gmdate('c'),
                'driver' => Db::pdo()->getAttribute(PDO::ATTR_DRIVER_NAME), 'php' => PHP_VERSION,
                'tables' => $tables, 'blobs' => $blobs, 'problems' => $problems,
            ];
            $zip = new \ZipArchive();
            if ($zip->open($part, \ZipArchive::CREATE | \ZipArchive::EXCL) !== true) throw new \RuntimeException('Cannot create the archive.');
            foreach (array_keys($tables) as $table) {
                $zip->addFile("$tmp/$table.jsonl", "db/$table.jsonl");
            }
            foreach ($blobs as $b) {
                $entry = self::blobEntry($b['sha256']);
                $zip->addFile(Storage::pathFor($b['sha256']), $entry);
                $zip->setCompressionName($entry, \ZipArchive::CM_STORE); // PDFs barely compress
            }
            $zip->addFromString('manifest.json', json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
            if (!$zip->close()) throw new \RuntimeException('Could not write the archive. Is the disk full?');
            chmod($part, 0600);
            self::verify($part);
            if (!rename($part, $target)) throw new \RuntimeException('Could not finalize the archive.');
            file_put_contents("$target.sha256", hash_file('sha256', $target) . '  ' . basename($target) . "\n");
            chmod("$target.sha256", 0600);
            return ['file' => $target, 'size' => (int)filesize($target), 'manifest' => $manifest];
        } finally {
            @unlink($part);
            foreach (glob("$tmp/*") ?: [] as $f) @unlink($f);
            @rmdir($tmp);
        }
    }

    /** Dumps all tables from one consistent snapshot of the database. */
    private static function dumpTables(string $tmp): array
    {
        $pdo = Db::pdo();
        $mysql = !Db::isSqlite();
        if ($mysql) {
            $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false); // large tables stay out of memory
        } else {
            $pdo->beginTransaction();
        }
        try {
            $tables = [];
            foreach (self::tables() as $table) {
                $columns = self::columns($table);
                $out = fopen("$tmp/$table.jsonl", 'wb');
                $hash = hash_init('sha256');
                $count = 0;
                $st = $pdo->query("SELECT * FROM $table");
                while (($row = $st->fetch(PDO::FETCH_ASSOC)) !== false) {
                    $line = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
                    if (fwrite($out, $line) !== strlen($line)) throw new \RuntimeException('Could not write the dump. Is the disk full?');
                    hash_update($hash, $line);
                    $count++;
                }
                $st->closeCursor();
                fclose($out);
                $tables[$table] = ['rows' => $count, 'sha256' => hash_final($hash), 'columns' => $columns];
            }
            if ($mysql) $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
            $blobs = Db::all('SELECT sha256 FROM blobs');
            return [$tables, $blobs];
        } finally {
            if ($mysql) {
                $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
                $pdo->exec('COMMIT');
            } else {
                $pdo->rollBack();
            }
        }
    }

    private static function restoreBlobs(\ZipArchive $zip, array $m): void
    {
        foreach ($m['blobs'] as $b) {
            $sha = $b['sha256'];
            $dest = Storage::pathFor($sha);
            if (is_file($dest) && hash_file('sha256', $dest) === $sha) continue;
            if (!is_dir(dirname($dest)) && !mkdir(dirname($dest), 0750, true) && !is_dir(dirname($dest))) {
                throw new \RuntimeException('Cannot create the file store.');
            }
            $in = $zip->getStream(self::blobEntry($sha));
            $partial = "$dest.restore";
            $out = fopen($partial, 'wb');
            if (!$in || !$out) throw new \RuntimeException("Cannot restore file $sha.");
            $copied = stream_copy_to_stream($in, $out);
            fclose($in);
            fclose($out);
            if ($copied === false || hash_file('sha256', $partial) !== $sha || !rename($partial, $dest)) {
                @unlink($partial);
                throw new \RuntimeException("Cannot restore file $sha. Is the disk full?");
            }
        }
    }

    /** Replaces all application tables in one transaction: a failure leaves the database as it was. */
    private static function restoreTables(\ZipArchive $zip, array $m): int
    {
        $pdo = Db::pdo();
        $sqlite = Db::isSqlite();
        $pdo->exec($sqlite ? 'PRAGMA foreign_keys = OFF' : 'SET FOREIGN_KEY_CHECKS = 0');
        try {
            $pdo->beginTransaction();
            try {
                foreach (self::tables() as $table) $pdo->exec("DELETE FROM $table");
                foreach ($m['tables'] as $table => $t) {
                    $stream = $zip->getStream("db/$table.jsonl");
                    if (!$stream) throw new \RuntimeException("Cannot read table $table.");
                    $columns = $t['columns'];
                    $st = $pdo->prepare(sprintf('INSERT INTO %s (%s) VALUES (%s)', $table, implode(',', $columns), implode(',', array_fill(0, count($columns), '?'))));
                    $count = 0;
                    while (($line = fgets($stream)) !== false) {
                        $row = json_decode($line, true, 8, JSON_THROW_ON_ERROR);
                        $st->execute(array_map(fn($c) => $row[$c] ?? null, $columns));
                        $count++;
                    }
                    fclose($stream);
                    $found = (int)$pdo->query("SELECT COUNT(*) FROM $table")->fetchColumn();
                    if ($count !== (int)$t['rows'] || $found !== (int)$t['rows']) throw new \RuntimeException("Row count mismatch in table $table.");
                }
                // References already broken in the source are reported, not refused:
                // otherwise a safety copy of a damaged database could not be put back.
                $broken = $sqlite ? count($pdo->query('PRAGMA foreign_key_check')->fetchAll()) : 0;
                $pdo->commit();
                return $broken;
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $e;
            }
        } finally {
            $pdo->exec($sqlite ? 'PRAGMA foreign_keys = ON' : 'SET FOREIGN_KEY_CHECKS = 1');
        }
    }

    /** Only the tables of this application: an OVH database may be shared with other software. */
    private static function tables(): array
    {
        $sql = (string)file_get_contents(__DIR__ . '/../sql/schema.mysql.sql');
        preg_match_all('/CREATE TABLE IF NOT EXISTS (\w+)/', $sql, $found);
        $existing = Db::isSqlite()
            ? array_column(Db::all("SELECT name FROM sqlite_master WHERE type = 'table'"), 'name')
            : array_column(Db::pdo()->query('SHOW TABLES')->fetchAll(PDO::FETCH_NUM), 0);
        return array_values(array_intersect($found[1], $existing));
    }

    private static function columns(string $table): array
    {
        if (Db::isSqlite()) return array_column(Db::all("PRAGMA table_info($table)"), 'name');
        return array_column(Db::all("SHOW COLUMNS FROM $table"), 'Field');
    }

    /** An archive from a newer version of the application cannot be loaded safely. */
    private static function assertCompatible(array $m): void
    {
        $current = self::tables();
        foreach ($m['tables'] as $table => $t) {
            if (!in_array($table, $current, true)) throw new \RuntimeException("Unknown table $table: update the application before restoring.");
            $missing = array_diff($t['columns'], self::columns($table));
            if ($missing) throw new \RuntimeException("Unknown columns in $table (" . implode(', ', $missing) . '): update the application before restoring.');
        }
    }

    private static function assertSpace(int $bytes): void
    {
        $free = @disk_free_space(self::dir());
        if ($free !== false && $free < $bytes * 1.1 + 10485760) {
            throw new \RuntimeException('Not enough disk space: about ' . round(($bytes * 1.1 + 10485760) / 1048576) . ' MB needed.');
        }
    }

    private static function assertName(string $name): void
    {
        if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/', $name)) throw new \RuntimeException('Invalid name in the manifest.');
    }

    private static function assertSha(string $sha): void
    {
        if (!preg_match('/^[0-9a-f]{64}$/', $sha)) throw new \RuntimeException('Invalid file hash in the manifest.');
    }

    private static function blobEntry(string $sha): string
    {
        return 'blobs/' . substr($sha, 0, 2) . '/' . substr($sha, 2, 2) . '/' . $sha;
    }

    private static function lock(): void
    {
        $path = rtrim((string)Config::get('storage_path'), '/') . '/.backup.lock';
        $fh = fopen($path, 'c');
        if (!$fh || !flock($fh, LOCK_EX | LOCK_NB)) throw new \RuntimeException('Another backup or restore is already running.');
        self::$lock = $fh;
    }

    private static function unlock(): void
    {
        if (self::$lock) { flock(self::$lock, LOCK_UN); fclose(self::$lock); self::$lock = null; }
    }
}
