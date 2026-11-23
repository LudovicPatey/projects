<?php
declare(strict_types=1);

namespace App;

/**
 * Repairs the metadata of facts imported from Danus before the current client.
 * It never changes a statement, a proof, a review or a revision number. Every change is journaled and can be undone.
 */
final class FactMigration
{
    private const TITLE_MAX = 120;

    /** External references that an old import cut at each comma, put back together. Null when there is nothing safe to do. */
    public static function repairRefs(mixed $list): ?array
    {
        if (!is_array($list) || !$list || !array_is_list($list)) return null;
        foreach ($list as $x) if (!is_string($x)) return null;
        $s = '';
        foreach ($list as $raw) {
            $x = trim($raw);
            $bare = preg_replace('/\\\\./s', '', $s) ?? '';
            $open = substr_count($bare, '"') % 2 === 1;
            if (!$open && (preg_match('/^[\w -]+":/u', $x) || !preg_match('/^["{\[\d\-tfn]/', $x))) $x = '"' . $x . '"';
            $s .= ($s === '' ? '' : ', ') . $x;
        }
        $value = json_decode("[$s]", true);
        if (!is_array($value) || !$value) return null;
        foreach ($value as $v) if (!is_array($v) || array_is_list($v)) return null;
        return $value;
    }

    /** A title that was only the first characters of the statement becomes the start of its main result. */
    public static function betterTitle(string $title, string $statement): ?string
    {
        $clean = fn(string $x) => trim(preg_replace('/\s+/u', ' ', $x) ?? $x);
        $t = $clean($title); $all = $clean($statement);
        if (mb_strlen($t) < 60 || $all === $t || !str_starts_with($all, $t)) return null;
        $shown = preg_match('/(?:^|[\n.]\s+)((?:Main )?(?:Theorem|Lemma|Proposition|Corollary)\b.*)/su', $statement, $m) ? $clean($m[1]) : $all;
        if (mb_strlen($shown) > self::TITLE_MAX) {
            $cut = mb_substr($shown, 0, self::TITLE_MAX);
            $at = mb_strrpos($cut, ' ');
            $shown = rtrim($at !== false && $at > 60 ? mb_substr($cut, 0, $at) : $cut, ',;:') . '…';
        }
        return $shown !== $title ? $shown : null;
    }

    /** What would change. Reads only. */
    public static function plan(): array
    {
        $changes = []; $unrepaired = [];
        $facts = Db::all("SELECT f.id, f.label, f.kind, f.title, f.tool, r.statement_html FROM facts f
                          JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.tool = 'danus' ORDER BY f.id");
        foreach ($facts as $f) {
            $text = Sanitizer::toText((string)$f['statement_html']);
            $kind = FactKind::of((string)$f['kind'], $f['tool'], $text);
            if ($kind !== $f['kind']) $changes[] = ['type' => 'kind', 'table' => 'facts', 'id' => (int)$f['id'], 'column' => 'kind', 'label' => $f['label'], 'old' => $f['kind'], 'new' => $kind];
            $title = self::betterTitle((string)$f['title'], $text);
            if ($title !== null) $changes[] = ['type' => 'title', 'table' => 'facts', 'id' => (int)$f['id'], 'column' => 'title', 'label' => $f['label'], 'old' => $f['title'], 'new' => $title];
        }
        foreach (Db::all("SELECT r.id, r.revision_no, r.external_refs_json, f.label FROM fact_revisions r JOIN facts f ON f.id = r.fact_id
                          WHERE f.tool = 'danus' AND r.external_refs_json IS NOT NULL ORDER BY r.id") as $r) {
            $list = json_decode((string)$r['external_refs_json'], true);
            if (!is_array($list) || !array_filter($list, 'is_string')) continue;
            $fixed = self::repairRefs($list);
            if ($fixed === null) { $unrepaired[] = ['label' => $r['label'], 'revision' => (int)$r['revision_no']]; continue; }
            $changes[] = ['type' => 'references', 'table' => 'fact_revisions', 'id' => (int)$r['id'], 'column' => 'external_refs_json', 'label' => $r['label'],
                'old' => $r['external_refs_json'], 'new' => json_encode($fixed, JSON_UNESCAPED_UNICODE)];
        }
        $counts = ['kind' => 0, 'title' => 0, 'references' => 0];
        foreach ($changes as $c) $counts[$c['type']]++;
        return ['facts' => count($facts), 'counts' => $counts, 'changes' => $changes, 'unrepaired' => $unrepaired];
    }

    public static function dir(): string
    {
        $dir = rtrim((string)Config::get('storage_path'), '/') . '/migrations';
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new \RuntimeException("Cannot create $dir");
        return $dir;
    }

    private static function save(string $file, array $data): void
    {
        $tmp = "$file.tmp";
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        if ($json === false || file_put_contents($tmp, $json, LOCK_EX) === false || !chmod($tmp, 0600) || !rename($tmp, $file)) {
            throw new \RuntimeException("Cannot write the journal $file");
        }
    }

    public static function writePreview(array $plan): string
    {
        $file = self::dir() . '/preview-' . gmdate('Ymd-His') . '.json';
        self::save($file, $plan + ['created_at' => gmdate('c')]);
        return $file;
    }

    /** The journal is written first. A row changed since the plan was read is left alone. */
    public static function apply(array $plan, string $backup): array
    {
        $file = self::dir() . '/applied-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.json';
        $journal = ['created_at' => gmdate('c'), 'backup' => $backup, 'state' => 'started', 'changes' => $plan['changes']];
        self::save($file, $journal);
        $applied = 0; $skipped = 0;
        Db::tx(function () use ($plan, &$applied, &$skipped) {
            foreach ($plan['changes'] as $c) {
                $n = self::swap($c['table'], $c['column'], $c['id'], $c['old'], $c['new']);
                if ($n === 1) $applied++; else $skipped++;
            }
        });
        self::save($file, ['state' => 'applied', 'applied' => $applied, 'skipped' => $skipped] + $journal);
        return ['file' => $file, 'applied' => $applied, 'skipped' => $skipped];
    }

    /** Undoes the latest migration. A value edited since then is kept. */
    public static function undo(): array
    {
        $files = glob(self::dir() . '/applied-*.json') ?: [];
        sort($files);
        $file = end($files);
        if (!$file) return ['file' => null, 'restored' => 0, 'kept' => 0, 'state' => 'none'];
        $journal = json_decode((string)file_get_contents($file), true);
        if (!is_array($journal) || !isset($journal['changes'])) throw new \RuntimeException("Unreadable journal $file");
        if (($journal['state'] ?? '') === 'undone') return ['file' => $file, 'restored' => 0, 'kept' => 0, 'state' => 'already undone'];
        $restored = 0; $kept = 0;
        Db::tx(function () use ($journal, &$restored, &$kept) {
            foreach ($journal['changes'] as $c) {
                $n = self::swap($c['table'], $c['column'], (int)$c['id'], $c['new'], $c['old']);
                if ($n === 1) $restored++; elseif ((string)self::current($c) !== (string)$c['old']) $kept++;
            }
        });
        self::save($file, ['state' => 'undone', 'restored' => $restored, 'kept' => $kept, 'undone_at' => gmdate('c')] + $journal);
        return ['file' => $file, 'restored' => $restored, 'kept' => $kept, 'state' => 'undone'];
    }

    private static function target(string $table, string $column): void
    {
        $allowed = ['facts' => ['kind', 'title'], 'fact_revisions' => ['external_refs_json']];
        if (!in_array($column, $allowed[$table] ?? [], true)) throw new \RuntimeException("Refused: $table.$column");
    }

    private static function swap(string $table, string $column, int $id, ?string $from, ?string $to): int
    {
        self::target($table, $column);
        return Db::run("UPDATE $table SET $column = ? WHERE id = ? AND $column = ?", [$to, $id, $from])->rowCount();
    }

    private static function current(array $c): mixed
    {
        self::target($c['table'], $c['column']);
        return Db::value("SELECT {$c['column']} FROM {$c['table']} WHERE id = ?", [$c['id']]);
    }
}
