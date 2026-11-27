<?php
declare(strict_types=1);

namespace App;

/**
 * The facts that a statement or a proof names the way its paper does, "Lemma 2.4" or "Theorem 3", so that the page can link them.
 * Extraction keeps the paper's numbering in the text, and records it in the fact's extraction id (oq-t42-lem-2.4), its title or
 * the start of its quotation. A name is resolved among the facts the proof depends on first, then among the facts found in the
 * same sources, and only when exactly one fact of that kind has that number: a wrong link is worse than none.
 */
final class FactRefs
{
    /** The words papers use, and the kind of fact each one names. */
    public const WORDS = ['Lemma' => 'lemma', 'Theorem' => 'theorem', 'Proposition' => 'proposition', 'Corollary' => 'corollary',
        'Claim' => 'claim', 'Definition' => 'definition', 'Remark' => 'remark', 'Fact' => 'fact', 'Observation' => 'observation', 'Conjecture' => 'conjecture'];
    /** Abbreviations in extraction ids. */
    private const PREFIX = ['lem' => 'lemma', 'lemma' => 'lemma', 'thm' => 'theorem', 'theorem' => 'theorem', 'prop' => 'proposition', 'cor' => 'corollary',
        'claim' => 'claim', 'def' => 'definition', 'rem' => 'remark', 'fact' => 'fact', 'obs' => 'observation', 'conj' => 'conjecture'];

    /** "Lemma 2.4", "Theorem~3" in plain text. Group 1: the word; group 2: the number. */
    public static function pattern(): string
    {
        return '/\b(' . implode('|', array_keys(self::WORDS)) . ')[\s~]+(\d+(?:\.\d+)*)\b/u';
    }

    /** The names a text uses, normalized ("Lemma 2.4"), once each. @return list<array{0: string, 1: string, 2: string}> [name, kind, number] */
    public static function names(string $text): array
    {
        preg_match_all(self::pattern(), $text, $m, PREG_SET_ORDER);
        $out = [];
        foreach ($m as $x) $out["$x[1] $x[2]"] = ["$x[1] $x[2]", self::WORDS[$x[1]], $x[2]];
        return array_values($out);
    }

    /** The numbers under which a fact appears in its paper. @return list<array{0: ?string, 1: string}> [kind or null, number] */
    public static function numbers(?string $externalId, string $title, array $quotes): array
    {
        $out = [];
        preg_match_all('/(?<![a-z])(' . implode('|', array_keys(self::PREFIX)) . ')[-:_.]?(\d+(?:[.-]\d+)*)/i', (string)$externalId, $m, PREG_SET_ORDER);
        foreach ($m as $x) $out[] = [self::PREFIX[strtolower($x[1])], str_replace('-', '.', $x[2])];
        foreach (array_merge([$title], $quotes) as $t) {
            if (preg_match('/^\s*(' . implode('|', array_keys(self::WORDS)) . ')[\s~]+(\d+(?:\.\d+)*)\b/u', (string)$t, $x)) $out[] = [self::WORDS[$x[1]], $x[2]];
        }
        return $out;
    }

    /**
     * The facts that the texts of fact $fid name by their paper's number. @return list<array{text: string, fact_id: int}>
     */
    public static function resolve(int $pid, int $fid, array $texts): array
    {
        $batch = self::batchRefs($pid, $fid, implode("\n", $texts));
        $names = self::names(implode("\n", $texts));
        if (!$names) return $batch;
        $deps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ?', [$fid]), 'depends_on_id'));
        $same = array_map('intval', array_column(Db::all("SELECT DISTINCT o.fact_id FROM fact_sources s
            JOIN facts f ON f.id = s.fact_id AND s.revision_no = f.current_revision
            JOIN fact_sources o ON o.source_type = s.source_type AND o.source_id = s.source_id AND o.covers <> 'context'
            JOIN facts g ON g.id = o.fact_id AND o.revision_no = g.current_revision AND g.project_id = f.project_id
            WHERE s.fact_id = ? AND s.covers <> 'context' AND s.source_type IN ('bib', 'document') AND o.fact_id <> ?", [$fid, $fid]), 'fact_id'));
        $ids = array_values(array_unique(array_merge($deps, $same)));
        if (!$ids) return $batch;
        [$in, $p] = Db::in($ids);
        $facts = [];
        foreach (Db::all("SELECT id, kind, title, external_id, current_revision FROM facts WHERE id IN $in AND project_id = ? AND deleted_at IS NULL AND retracted_at IS NULL", array_merge($p, [$pid])) as $f) {
            $quotes = array_column(Db::all("SELECT quote FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND covers <> 'context' LIMIT 5", [$f['id'], $f['current_revision']]), 'quote');
            $facts[(int)$f['id']] = ['kind' => $f['kind'], 'numbers' => self::numbers($f['external_id'], (string)$f['title'], $quotes)];
        }
        $out = [];
        foreach ($names as [$name, $kind, $number]) {
            foreach ([$deps, $same] as $pool) {
                $hits = array_values(array_filter($pool, fn($id) => isset($facts[$id]) && self::has($facts[$id]['numbers'], $kind, $number)));
                if (count($hits) > 1) $hits = array_values(array_filter($hits, fn($id) => $facts[$id]['kind'] === $kind)) ?: $hits;
                if (count($hits) === 1) { $out[] = ['text' => $name, 'fact_id' => $hits[0]]; break; }
                if ($hits) break; // several facts carry this number: no link rather than a wrong one
            }
        }
        return array_merge($batch, $out);
    }

    /**
     * Facts an AI sent in one answer name each other by the refs it gave them ("By lem:full-match-gives-left-match"), kept in
     * their external ids (oq-t{task}-{ref}). Such a name in the text links to that fact. Clients before 1.22.6 cut refs to 32
     * characters: a name that begins with a ref of exactly that length matches it too. Newer imports write links instead.
     * @return list<array{text: string, fact_id: int}>
     */
    private static function batchRefs(int $pid, int $fid, string $text): array
    {
        $ext = (string)Db::value('SELECT external_id FROM facts WHERE id = ?', [$fid]);
        if (!preg_match('/^(oq-t\d+-)/', $ext, $m) || !preg_match_all('/(?<![\w:\/-])[a-z]{2,8}:[A-Za-z0-9][\w.:-]*[A-Za-z0-9]/', $text, $found)) return [];
        $refs = [];
        foreach (Db::all('SELECT id, external_id FROM facts WHERE project_id = ? AND id <> ? AND external_id LIKE ? AND deleted_at IS NULL AND retracted_at IS NULL', [$pid, $fid, $m[1] . '%']) as $f) {
            $refs[substr((string)$f['external_id'], strlen($m[1]))] = (int)$f['id'];
        }
        $out = [];
        foreach (array_unique($found[0]) as $name) {
            $hit = $refs[$name] ?? null;
            if ($hit === null) foreach ($refs as $ref => $id) if (strlen($ref) === 32 && str_starts_with($name, $ref)) { $hit = $id; break; }
            if ($hit !== null) $out[] = ['text' => $name, 'fact_id' => $hit];
        }
        return $out;
    }

    private static function has(array $numbers, string $kind, string $number): bool
    {
        foreach ($numbers as [$k, $n]) if ($n === $number && ($k === null || $k === $kind)) return true;
        return false;
    }
}
