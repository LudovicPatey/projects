<?php
declare(strict_types=1);

namespace App;

/**
 * What a fact rests on. A cited result states a result of another work without its proof: only a person who read the source
 * can accept it. A proved fact has its proof here, and that proof may rely only on facts of the database, cited results included,
 * so that it can be checked against them. An outside reference its proof still uses directly leaves its dependencies incomplete.
 */
final class FactBasis
{
    /** Kinds and labels that claim nothing to prove. */
    public const NO_PROOF_KINDS = ['definition', 'conjecture', 'remark'];
    public const NO_PROOF_LABELS = ['plan', 'dead_end', 'direction', 'obstacle', 'master_guidance'];

    /** 'proved' | 'cited' | 'none' (a definition, a conjecture, a remark, a plan: nothing to establish) */
    public static function of(string $displayKind, array $labels, bool $hasProof): string
    {
        if ($hasProof) return 'proved';
        if (in_array($displayKind, self::NO_PROOF_KINDS, true) || array_intersect($labels, self::NO_PROOF_LABELS)) return 'none';
        return 'cited';
    }

    /**
     * The outside references a proof uses: the bibliography entries it cites, and its external references.
     * @return list<array{key: string, label: string, bib_id: ?int}>
     */
    public static function outsideRefs(?string $proofHtml, ?string $externalRefsJson): array
    {
        $out = [];
        if (preg_match_all('#<span class="mention" data-type="bib" data-id="(\d+)"(?: data-label="([^"]*)")?#', (string)$proofHtml, $m, PREG_SET_ORDER)) {
            foreach ($m as $x) $out['bib:' . $x[1]] ??= ['key' => 'bib:' . $x[1], 'label' => html_entity_decode($x[2] ?? '', ENT_QUOTES | ENT_HTML5, 'UTF-8') ?: 'Reference ' . $x[1], 'bib_id' => (int)$x[1]];
        }
        $list = json_decode((string)$externalRefsJson, true);
        if (is_array($list) && $list) {
            $list = FactMigration::repairRefs($list) ?? $list;
            foreach ($list as $r) {
                $key = 'ext:' . substr(sha1(json_encode($r, JSON_UNESCAPED_UNICODE) ?: ''), 0, 16);
                $out[$key] ??= ['key' => $key, 'label' => self::refLabel($r), 'bib_id' => null];
            }
        }
        return array_values($out);
    }

    public static function refLabel(mixed $r): string
    {
        if (!is_array($r)) return mb_substr(trim((string)(is_scalar($r) ? $r : json_encode($r))), 0, 200) ?: 'Reference';
        $s = fn($k) => is_scalar($r[$k] ?? null) ? trim((string)$r[$k]) : '';
        $authors = is_array($r['authors'] ?? null) ? implode(', ', array_filter(array_map(fn($a) => is_scalar($a) ? (string)$a : '', $r['authors']))) : ($s('authors') ?: $s('author'));
        $label = trim(implode(', ', array_filter([$authors, $s('title') ?: $s('key'), $s('year')])));
        if ($s('cited_for') !== '') $label .= ($label !== '' ? ': ' : '') . $s('cited_for');
        return mb_substr($label, 0, 200) ?: 'Reference';
    }

    /**
     * Which outside references are settled: linked to a fact it still depends on, marked as not used as a result,
     * or, for a bibliography entry, stated by a cited result it depends on whose source is that entry.
     * @param array<string, ?int> $links ref_key => cited fact id (null: not used as a result)
     * @param list<int> $deps
     * @param array<int, list<int>> $bibOf fact id => bibliography entries among its sources
     * @return list<array> each reference with 'resolved' and 'fact_id' (the fact that states it, when known)
     */
    public static function resolve(array $refs, array $links, array $deps, array $bibOf): array
    {
        foreach ($refs as &$r) {
            $r['fact_id'] = null; $r['not_used'] = false;
            if (array_key_exists($r['key'], $links)) {
                if ($links[$r['key']] === null) $r['not_used'] = true;
                elseif (in_array($links[$r['key']], $deps, true)) $r['fact_id'] = $links[$r['key']];
            }
            if ($r['fact_id'] === null && !$r['not_used'] && $r['bib_id'] !== null) {
                foreach ($deps as $d) if (in_array($r['bib_id'], $bibOf[$d] ?? [], true)) { $r['fact_id'] = $d; break; }
            }
            $r['resolved'] = $r['not_used'] || $r['fact_id'] !== null;
        }
        unset($r);
        return $refs;
    }

    /**
     * The status of a cited result. A person accepts it after reading the source. A source check by an AI is evidence,
     * shown as 'source_confirmed', and does not count when the model that wrote the fact made it.
     * @param list<array> $reviews of the current revision; @param list<array> $checks source checks of the current revision, newest first
     */
    public static function citedStatus(?string $retractedAt, array $reviews, array $checks, ?string $factModel): string
    {
        if ($retractedAt) return 'retracted';
        if (array_filter($reviews, fn($v) => $v['statement_verdict'] === 'false' || ($v['statement_verdict'] === null && $v['verdict'] === 'incorrect'))) return 'disputed';
        if (array_filter($reviews, fn($v) => $v['reviewer_kind'] === 'human' && ($v['verdict'] === 'correct' || $v['statement_verdict'] === 'true'))) return 'accepted';
        $same = fn($m) => (string)$factModel !== '' && mb_strtolower(trim((string)$factModel)) === mb_strtolower(trim((string)$m));
        $latest = array_values(array_filter($checks, fn($c) => !$same($c['ai_model'])))[0] ?? null;
        return $latest && $latest['verdict'] === 'confirmed' ? 'source_confirmed' : 'unchecked';
    }
}
