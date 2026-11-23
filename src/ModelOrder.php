<?php
declare(strict_types=1);

namespace App;

/**
 * A partial order on AI models, read from their names so that new releases need no update.
 *
 * A is at least as strong as B only when both belong to one line, A's tier is not lower, and
 * A's version is not older. Everything else is incomparable: Opus 4 and Sonnet 5, Claude and
 * GPT, or an unknown name. Incomparable models may each do the work, since neither is known
 * to make the other redundant.
 */
final class ModelOrder
{
    private const CLAUDE_TIERS = ['haiku' => 1, 'sonnet' => 2, 'opus' => 3];

    /** @return array{line:string, tier:int, version:array{int,int}}|null */
    public static function parse(?string $model): ?array
    {
        $m = strtolower(trim((string)$model));
        if ($m === '' || str_contains($m, 'default model')) return null;
        if (preg_match('/^claude-(haiku|sonnet|opus)-(\d{1,2})(?:[-.](\d{1,2}))?(?:-\d{8})?$/', $m, $x)
            || preg_match('/^claude-()(\d{1,2})(?:-(\d{1,2}))?-(?:haiku|sonnet|opus)(?:-\d{8})?$/', $m, $x)) {
            if ($x[1] === '') { preg_match('/(haiku|sonnet|opus)/', $m, $t); $x[1] = $t[1]; }
            return ['line' => 'claude', 'tier' => self::CLAUDE_TIERS[$x[1]], 'version' => [(int)$x[2], (int)($x[3] ?? 0)]];
        }
        if (preg_match('/^claude-([a-z]+)-(\d{1,2})(?:[-.](\d{1,2}))?(?:-\d{8})?$/', $m, $x)) {
            return ['line' => 'claude-' . $x[1], 'tier' => 0, 'version' => [(int)$x[2], (int)($x[3] ?? 0)]];
        }
        if (preg_match('/^gpt-(\d{1,2})(?:\.(\d{1,2}))?(?:-([a-z0-9-]+))?$/', $m, $x)) {
            return ['line' => 'gpt' . (isset($x[3]) ? '-' . $x[3] : ''), 'tier' => 0, 'version' => [(int)$x[1], (int)($x[2] ?? 0)]];
        }
        return null;
    }

    public static function atLeast(?string $a, ?string $b): bool
    {
        $x = self::parse($a); $y = self::parse($b);
        if (!$x || !$y || $x['line'] !== $y['line']) return false;
        return $x['tier'] >= $y['tier'] && $x['version'] >= $y['version'];
    }

    /** Whether one of the models that already did this work makes a run by $model redundant. */
    public static function covered(array $doneBy, ?string $model): bool
    {
        foreach ($doneBy as $done) if (self::atLeast((string)$done, $model)) return true;
        return false;
    }
}
