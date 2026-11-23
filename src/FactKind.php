<?php
declare(strict_types=1);

namespace App;

/** Danus does not state a kind, so its facts are stored as lemmas. Their own text says what they are. */
final class FactKind
{
    private const PRIORITY = ['theorem', 'proposition', 'corollary', 'lemma', 'conjecture', 'definition'];

    public static function of(string $kind, ?string $tool, string $statement): string
    {
        if ($kind !== 'lemma' || $tool !== 'danus') return $kind;
        if (!preg_match_all('/(?:^|[\n.]\s*)(?:Main\s+)?(Theorem|Proposition|Corollary|Lemma|Conjecture|Definition)(?:\s+\d+(?:\.\d+)*)?[.:]/u', $statement, $m)) return $kind;
        $found = array_map('strtolower', $m[1]);
        foreach (self::PRIORITY as $k) if (in_array($k, $found, true)) return $k;
        return $kind;
    }
}
