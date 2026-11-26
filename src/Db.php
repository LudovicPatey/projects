<?php
declare(strict_types=1);

namespace App;

use PDO;

final class Db
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (!self::$pdo) {
            self::$pdo = new PDO(
                Config::get('db.dsn'),
                Config::get('db.user'),
                Config::get('db.password'),
                [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]
            );
            if (self::isSqlite()) self::$pdo->exec('PRAGMA foreign_keys = ON');
        }
        return self::$pdo;
    }

    public static function isSqlite(): bool
    {
        return str_starts_with((string)Config::get('db.dsn'), 'sqlite:');
    }

    public static function run(string $sql, array $params = []): \PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $r = self::run($sql, $params)->fetch();
        return $r === false ? null : $r;
    }

    public static function value(string $sql, array $params = []): mixed
    {
        $r = self::run($sql, $params)->fetchColumn();
        return $r === false ? null : $r;
    }

    public static function insert(string $table, array $data): int
    {
        $cols = array_keys($data);
        $sql = sprintf(
            'INSERT INTO %s (%s) VALUES (%s)',
            $table,
            implode(',', $cols),
            implode(',', array_map(fn($c) => ':' . $c, $cols))
        );
        self::run($sql, $data);
        return (int)self::pdo()->lastInsertId();
    }

    public static function update(string $table, array $data, string $where, array $params = []): void
    {
        $set = implode(',', array_map(fn($c) => "$c = :set_$c", array_keys($data)));
        $p = [];
        foreach ($data as $k => $v) $p["set_$k"] = $v;
        self::run("UPDATE $table SET $set WHERE $where", array_merge($p, $params));
    }

    private static int $depth = 0;

    /** Runs $fn in a transaction. Inside another one it is a savepoint: a failure undoes only its own changes. */
    public static function tx(callable $fn): mixed
    {
        $pdo = self::pdo();
        if ($pdo->inTransaction()) {
            $sp = 'sp' . ++self::$depth;
            $pdo->exec("SAVEPOINT $sp");
            try {
                $r = $fn();
                $pdo->exec("RELEASE SAVEPOINT $sp");
                return $r;
            } catch (\Throwable $e) {
                $pdo->exec("ROLLBACK TO SAVEPOINT $sp");
                $pdo->exec("RELEASE SAVEPOINT $sp");
                throw $e;
            } finally {
                self::$depth--;
            }
        }
        $pdo->beginTransaction();
        try {
            $r = $fn();
            $pdo->commit();
            return $r;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /** IN (...) placeholder helper: returns [sql fragment, params]. */
    public static function in(array $values): array
    {
        if (!$values) return ['(NULL)', []];
        return ['(' . implode(',', array_fill(0, count($values), '?')) . ')', array_values($values)];
    }

    public static function now(): string { return gmdate('Y-m-d H:i:s'); }

    /**
     * In production, applies the schema once after a deployment that changed it,
     * so that FTP-only hosting needs no command on the server.
     */
    public static function ensureSchema(): void
    {
        if (Config::isDev()) return;
        $files = [__DIR__ . '/../sql/schema.mysql.sql', __FILE__];
        $version = '';
        foreach ($files as $f) $version .= filesize($f) . ':' . filemtime($f) . ';';
        $dir = rtrim((string)Config::get('storage_path'), '/');
        $stamp = "$dir/schema.version";
        if (is_file($stamp) && trim((string)file_get_contents($stamp)) === $version) return;
        if (!is_dir($dir)) mkdir($dir, 0750, true);
        $lock = fopen("$dir/.schema.lock", 'c');
        if (!$lock) throw new \RuntimeException('Cannot lock the schema upgrade.');
        flock($lock, LOCK_EX);
        try {
            if (!is_file($stamp) || trim((string)file_get_contents($stamp)) !== $version) {
                self::install();
                file_put_contents($stamp, $version, LOCK_EX);
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /** Runs the schema (MySQL file, converted on the fly for SQLite). */
    public static function install(): void
    {
        $sql = file_get_contents(__DIR__ . '/../sql/schema.mysql.sql');
        if (self::isSqlite()) {
            $sql = preg_replace('/^SET NAMES.*$/m', '', $sql);
            $sql = str_replace('INT UNSIGNED AUTO_INCREMENT PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT', $sql);
            $sql = preg_replace('/\) ENGINE=.*;/', ');', $sql);
            $sql = preg_replace('/UNIQUE KEY \w+ \(/', 'UNIQUE (', $sql);
            $sql = preg_replace('/^\s*KEY \w+ \([^)]*\),\s*$/m', '', $sql);
            $sql = str_replace(' UNSIGNED', '', $sql);
        }
        $sql = preg_replace('/--.*$/m', '', $sql);
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
            self::pdo()->exec($stmt);
        }
        // Upgrades of existing installations (each one fails harmlessly if already applied).
        $migrations = [
            "ALTER TABLE users ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'human'",
            'ALTER TABLE users ADD COLUMN ai_model VARCHAR(120) NULL',
            'ALTER TABLE messages ADD COLUMN ai_model VARCHAR(120) NULL',
            'ALTER TABLE comments ADD COLUMN ai_model VARCHAR(120) NULL',
            'ALTER TABLE document_versions ADD COLUMN ai_model VARCHAR(120) NULL',
            'ALTER TABLE bib_entries ADD COLUMN ai_model VARCHAR(120) NULL',
            'ALTER TABLE users ADD COLUMN tours_seen VARCHAR(60) NULL',
            'ALTER TABLE users ADD COLUMN first_login_at DATETIME NULL',
        ];
        foreach (['messages', 'comments', 'document_versions', 'bib_entries', 'fact_revisions', 'fact_reviews', 'fact_lean'] as $t) {
            $migrations[] = "ALTER TABLE $t ADD COLUMN ai_user_id INT UNSIGNED NULL";
            $migrations[] = "ALTER TABLE $t ADD COLUMN ai_generation_ms INT UNSIGNED NULL";
        }
        $migrations[] = 'ALTER TABLE fact_lean ADD COLUMN check_user_id INT UNSIGNED NULL';
        $migrations[] = 'ALTER TABLE fact_lean ADD COLUMN check_generation_ms INT UNSIGNED NULL';
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN source_blob_id INT UNSIGNED NULL';
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN comments_hash CHAR(40) NULL';
        $migrations[] = 'ALTER TABLE fact_sources ADD COLUMN comment_role VARCHAR(10) NULL';
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN snapshot_json TEXT NULL';
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN started_at DATETIME NULL';
        $migrations[] = 'ALTER TABLE ai_clients ADD COLUMN version VARCHAR(20) NULL';
        $migrations[] = 'ALTER TABLE fact_reviews ADD COLUMN statement_verdict VARCHAR(8) NULL';
        $migrations[] = 'ALTER TABLE fact_rephrasings ADD COLUMN local_json TEXT NULL';
        $migrations[] = 'ALTER TABLE notations ADD COLUMN facts_json TEXT NULL';
        $migrations[] = 'ALTER TABLE facts ADD COLUMN merged_into INT UNSIGNED NULL';
        $migrations[] = 'ALTER TABLE facts ADD COLUMN topics_json TEXT NULL';
        foreach (['confidence VARCHAR(8) NULL', 'auto_applied TINYINT(1) NOT NULL DEFAULT 0', 'undo_json MEDIUMTEXT NULL', 'undone_by INT UNSIGNED NULL', 'undone_at DATETIME NULL'] as $c) {
            $migrations[] = "ALTER TABLE fact_suggestions ADD COLUMN $c";
        }
        $migrations[] = 'ALTER TABLE projects ADD COLUMN consolidation_auto TINYINT(1) NOT NULL DEFAULT 1';
        foreach (['highlight_reason TEXT NULL', 'highlight_at DATETIME NULL', 'highlight_model VARCHAR(120) NULL', 'highlight_activity INT UNSIGNED NULL'] as $c) $migrations[] = "ALTER TABLE facts ADD COLUMN $c";
        $migrations[] = 'ALTER TABLE notations ADD COLUMN auto_suggestion_id INT UNSIGNED NULL';
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN priority SMALLINT NOT NULL DEFAULT 50';
        $migrations[] = 'ALTER TABLE projects ADD COLUMN sweeps_checked_at DATETIME NULL';
        // Upkeep queued one fact at a time, before sweeps: the sweeps take it over.
        $migrations[] = "DELETE FROM ai_tasks WHERE status = 'pending' AND kind IN ('notation', 'source_check') AND (dedupe_key LIKE 'nota:%' OR dedupe_key LIKE 'srcchk:%' OR dedupe_key LIKE 'srcb:%')";
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN after_json TEXT NULL';
        $migrations[] = 'CREATE INDEX idx_ai_task_schedule ON ai_tasks (status, priority, id)';
        // Tasks waiting from before the scheduler take their kind's priority. A kind whose priority is the default of 50 needs nothing.
        foreach (['ask' => 10, 'review' => 20, 'source_check' => 30, 'bib' => 30, 'consolidate' => 40, 'lean' => 40, 'extract' => 70] as $k => $v) {
            $migrations[] = "UPDATE ai_tasks SET priority = $v WHERE kind = '$k' AND priority = 50 AND status IN ('pending', 'running')";
        }
        $migrations[] = "UPDATE ai_tasks SET priority = CASE WHEN source_type = 'fact' THEN 60 ELSE 40 END WHERE kind = 'notation' AND priority = 50 AND status IN ('pending', 'running')";
        // Decisions an AI takes for people: checking rewrites, a second reading of proposals, references checked against their record.
        foreach (['check_ai_model VARCHAR(120) NULL', 'check_ai_user_id INT UNSIGNED NULL', 'check_ai_generation_ms INT UNSIGNED NULL'] as $c) $migrations[] = "ALTER TABLE fact_rephrasings ADD COLUMN $c";
        foreach (['second_verdict VARCHAR(8) NULL', 'second_reason TEXT NULL', 'second_ai_model VARCHAR(120) NULL', 'second_at DATETIME NULL'] as $c) $migrations[] = "ALTER TABLE fact_suggestions ADD COLUMN $c";
        foreach (['auto_added TINYINT(1) NOT NULL DEFAULT 0', 'verified_by VARCHAR(20) NULL'] as $c) $migrations[] = "ALTER TABLE bib_suggestions ADD COLUMN $c";
        $migrations[] = "ALTER TABLE prover_campaigns ADD COLUMN lead_mode VARCHAR(12) NOT NULL DEFAULT 'periodic'";
        // MySQL cut kinds longer than 10 characters, such as "consolidate": room for procedure names, and the cut rows repaired.
        if (!self::isSqlite()) $migrations[] = 'ALTER TABLE ai_tasks MODIFY kind VARCHAR(40) NOT NULL';
        // The objects a notation entry is written with, X and Y in "Y \\leq X", and their type: it applies to those only.
        $migrations[] = 'ALTER TABLE notations ADD COLUMN params_json TEXT NULL';
        // Whether a source check had the text of the source: one made blind is made again once the source is readable.
        $migrations[] = 'ALTER TABLE fact_source_checks ADD COLUMN had_source TINYINT(1) NULL';
        // The AI requests a person made, against their daily limit. Before, every task without a dedupe key counted, sweeps included:
        // the platform's own upkeep counted against whoever's client asked for work. The count starts afresh: the window is 24 hours.
        $migrations[] = 'ALTER TABLE ai_tasks ADD COLUMN counted TINYINT(1) NOT NULL DEFAULT 0';
        // A question the AI asks the members about its rewrite or its check of a source: shown until a person answers it.
        $migrations[] = 'ALTER TABLE fact_rephrasings ADD COLUMN doubt_text TEXT NULL';
        $migrations[] = 'ALTER TABLE fact_source_checks ADD COLUMN doubt_text TEXT NULL';
        // One AI review per model, not per member: the new key first, so that the foreign key on fact_id always has an index.
        // SQLite cannot change a table's keys: an existing local database keeps one review per member (FactController::recordReview).
        if (!self::isSqlite()) {
            $migrations[] = 'ALTER TABLE fact_reviews ADD UNIQUE KEY uq_fact_review_model (fact_id, revision_no, reviewer_id, reviewer_kind, ai_model)';
            $migrations[] = 'ALTER TABLE fact_reviews DROP INDEX uq_fact_review';
        }
        foreach ($migrations as $m) {
            try { self::pdo()->exec($m); } catch (\PDOException) { /* already applied */ }
        }
        self::pdo()->exec("UPDATE ai_tasks SET kind = 'consolidate' WHERE kind = 'consolidat'");
        // Existing AI content gets its author's model, or an explicit "unspecified".
        $agentModel = fn(string $col) => "COALESCE((SELECT u.ai_model FROM users u WHERE u.id = $col), 'unspecified')";
        $agents = "(SELECT id FROM users WHERE kind = 'agent')";
        foreach ([
            "UPDATE messages SET ai_model = {$agentModel('messages.author_id')} WHERE ai_model IS NULL AND author_id IN $agents",
            "UPDATE comments SET ai_model = {$agentModel('comments.author_id')} WHERE ai_model IS NULL AND author_id IN $agents",
            "UPDATE bib_entries SET ai_model = {$agentModel('bib_entries.created_by')} WHERE ai_model IS NULL AND created_by IN $agents",
            "UPDATE documents SET ai_model = {$agentModel('documents.created_by')} WHERE origin = 'ai' AND (ai_model IS NULL OR ai_model = '')",
            "UPDATE document_versions SET ai_model = (SELECT d.ai_model FROM documents d WHERE d.id = document_versions.document_id)
             WHERE ai_model IS NULL AND document_id IN (SELECT id FROM documents WHERE origin = 'ai')",
        ] as $backfill) {
            self::pdo()->exec($backfill);
        }
        // Extractions from before PDFs were tracked are attributed to the PDF now attached.
        self::pdo()->exec("UPDATE ai_tasks SET source_blob_id = (SELECT b.pdf_blob_id FROM bib_entries b WHERE b.id = ai_tasks.source_id)
                           WHERE kind = 'extract' AND source_type = 'bib' AND source_blob_id IS NULL");
        // Bibliography display fields are derived from the BibTeX fields: refresh them.
        foreach (self::pdo()->query('SELECT id, title, authors, venue, fields_json FROM bib_entries')->fetchAll() as $b) {
            $c = BibTex::columns(json_decode($b['fields_json'], true) ?: []);
            if ($c['title'] !== $b['title'] || $c['authors'] !== $b['authors'] || $c['venue'] !== $b['venue']) {
                self::update('bib_entries', ['title' => $c['title'], 'authors' => $c['authors'], 'venue' => $c['venue']], 'id = :id', ['id' => $b['id']]);
            }
        }
        // Pieces of symbols cut at a LaTeX thin space, X\\ out of X\\,\\tilde\\in\\,U, before the cut was fixed.
        \App\Controllers\NotationController::repairCut();
        // Existing AI content is attributed to the owner who issued the agent's token, or to its author.
        foreach (['messages' => 'author_id', 'comments' => 'author_id', 'bib_entries' => 'created_by', 'document_versions' => 'uploaded_by',
                  'fact_revisions' => 'author_id', 'fact_reviews' => 'reviewer_id', 'fact_lean' => 'created_by'] as $t => $col) {
            self::pdo()->exec("UPDATE $t SET ai_user_id = COALESCE((SELECT MAX(k.created_by) FROM api_tokens k WHERE k.agent_user_id = $t.$col), $t.$col)
                               WHERE ai_user_id IS NULL AND ai_model IS NOT NULL");
        }
    }
}
