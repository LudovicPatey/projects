<?php
declare(strict_types=1);

namespace App;

use App\Controllers\FactController;

/**
 * Which facts to verify first, for the AI reviews and for people alike, and how far each one is checked.
 *
 * A check is independent when it comes from a person, or from an AI of another company than the one whose model wrote the proof:
 * two Claude models, or two GPT models, share their training and their blind spots. A fact's priority is what rests on it: an
 * answer to a question first, then the results worth reading it supports, then the number of facts that rely on it, directly or
 * not; among equals, the least checked first.
 */
final class Verification
{
    /** How far a proof is checked, from least to most. */
    public const LEVELS = ['none', 'same_ai', 'other_ai', 'person'];

    /** The statuses of a proved fact that still waits for a check: not settled by people, not disputed. */
    private const OPEN = ['unchecked', 'ai_checked'];

    /** The company behind a model, read from its name: "claude-opus-5-5" and "opus" are Anthropic, "gpt-5.5" and "codex" OpenAI. */
    public static function company(?string $model): ?string
    {
        $m = mb_strtolower(trim((string)$model));
        if ($m === '') return null;
        if (preg_match('/^(claude|opus|sonnet|haiku|fable)\b|anthropic/', $m)) return 'anthropic';
        if (preg_match('/^(gpt|chatgpt|codex|o\d)\b|^gpt-|openai/', $m)) return 'openai';
        if (str_contains($m, 'gemini')) return 'google';
        return preg_split('/[-_:\/\s.]/', $m)[0] ?: $m;
    }

    /** Short names a client may send for a model, standing for any of its versions: "opus" is claude-opus-5-5 as well. */
    private const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

    /** Whether two names may be the same model: equal, or one an alias and the other a version of it. */
    public static function sameModel(?string $a, ?string $b): bool
    {
        $a = mb_strtolower(trim((string)$a)); $b = mb_strtolower(trim((string)$b));
        if ($a === '' || $b === '') return false;
        if ($a === $b) return true;
        foreach ([[$a, $b], [$b, $a]] as [$x, $y]) if (in_array($x, self::ALIASES, true) && preg_match('/(^|[-_])' . preg_quote($x, '/') . '([-_]|$)/', $y)) return true;
        return false;
    }

    /**
     * How far the current revision is checked, from the reviews that found its proof correct: by a person, by an AI of another
     * company than its author, or only by one of the same company. A proof written by a person is checked independently by any AI.
     * @param list<array{verdict: string, reviewer_kind: string, ai_model: ?string}> $reviews
     * @return array{0: string, 1: list<string>} the level, and the companies whose AI found it correct
     */
    public static function level(?string $author, array $reviews): array
    {
        $level = 'none'; $companies = [];
        $own = self::company($author);
        foreach ($reviews as $v) {
            if ($v['verdict'] !== 'correct') continue;
            if ($v['reviewer_kind'] === 'human') { $level = 'person'; continue; }
            $co = self::company($v['ai_model']) ?? 'unknown';
            $companies[] = $co;
            $mine = ($own === null || $co !== $own) ? 'other_ai' : 'same_ai';
            if (array_search($mine, self::LEVELS, true) > array_search($level, self::LEVELS, true)) $level = $mine;
        }
        return [$level, array_values(array_unique($companies))];
    }

    /**
     * The proved facts that still wait for a check, most important first. Each: its score, its level, the questions whose answers
     * rest on it (proposed or ratified), the results worth reading it supports, and how many facts rely on it.
     * @return array<int, array{score: int, level: string, checked_by: list<string>, answers: list<array{id: int, title: string, state: string}>, worth: int, rests: int}>
     */
    public static function rank(int $pid, ?array $graph = null): array
    {
        $byId = array_column(($graph ?? FactController::graph($pid))['facts'], null, 'id');
        // What each fact rests on, itself included, computed once: a chain shared by many facts is walked once.
        $memo = [];
        $below = function (int $id, array $seen = []) use (&$below, &$memo, $byId): array {
            if (isset($memo[$id])) return $memo[$id];
            if (isset($seen[$id]) || !isset($byId[$id])) return [];
            $out = [$id => true];
            foreach ($byId[$id]['deps'] as $d) $out += $below((int)$d, $seen + [$id => true]);
            return $memo[$id] = $out;
        };
        $rests = []; $worth = [];
        foreach ($byId as $id => $f) {
            if ($f['retracted_at'] !== null) continue;
            foreach (array_keys($below($id)) as $a) {
                if ($a !== $id) $rests[$a] = ($rests[$a] ?? 0) + 1;
                if (!empty($f['worth_reading'])) $worth[$a] = ($worth[$a] ?? 0) + 1;
            }
        }
        $answers = [];
        foreach (Db::all("SELECT a.fact_id, a.state, q.id, q.title FROM question_answers a JOIN open_questions q ON q.id = a.question_id
                          WHERE a.project_id = ? AND a.state IN ('proposed', 'ratified') AND q.deleted_at IS NULL ORDER BY a.state = 'ratified' DESC, a.id", [$pid]) as $a) {
            foreach (array_keys($below((int)$a['fact_id'])) as $x) $answers[$x][(int)$a['id']] ??= ['id' => (int)$a['id'], 'title' => (string)$a['title'], 'state' => (string)$a['state']];
        }
        $out = [];
        foreach ($byId as $id => $f) {
            if ($f['basis'] !== 'proved' || $f['retracted_at'] !== null || !in_array($f['status'], self::OPEN, true)) continue;
            $level = $f['check_level'] ?? 'none';
            if ($level === 'person') continue;
            $ans = array_values($answers[$id] ?? []);
            $score = ($ans ? 1000 + 50 * min(count($ans), 4) : 0) + 100 * min($worth[$id] ?? 0, 5) + 10 * min($rests[$id] ?? 0, 50)
                + ['none' => 40, 'same_ai' => 25, 'other_ai' => 0][$level] + (in_array($f['proof_origin'], ['ai', 'mixed'], true) ? 15 : 0);
            $out[$id] = ['score' => $score, 'level' => $level, 'checked_by' => $f['checked_by'] ?? [], 'answers' => $ans, 'worth' => $worth[$id] ?? 0, 'rests' => $rests[$id] ?? 0];
        }
        uksort($out, fn($a, $b) => [$out[$b]['score'], $a] <=> [$out[$a]['score'], $b]);
        return $out;
    }

    /**
     * The companies whose AI reviewed proofs in this project lately, or whose client asked for work: a fact checked only by its own
     * company's AI waits for one of the others only when one is around. @return list<string>
     */
    public static function companiesAround(int $pid): array
    {
        $since = gmdate('Y-m-d H:i:s', time() - 30 * 86400);
        $models = array_merge(
            array_column(Db::all("SELECT DISTINCT v.ai_model FROM fact_reviews v JOIN facts f ON f.id = v.fact_id WHERE f.project_id = ? AND v.reviewer_kind <> 'human' AND v.created_at >= ?", [$pid, $since]), 'ai_model'),
            array_column(Db::all('SELECT DISTINCT c.ai_model FROM ai_clients c JOIN project_members m ON m.user_id = c.user_id WHERE m.project_id = ? AND c.last_seen_at >= ?', [$pid, $since]), 'ai_model'),
            array_column(Db::all("SELECT DISTINCT ai_model FROM ai_tasks WHERE project_id = ? AND kind IN ('review', 'proof_review') AND status = 'done' AND finished_at >= ?", [$pid, $since]), 'ai_model'));
        return array_values(array_unique(array_filter(array_map([self::class, 'company'], $models))));
    }

    /** The list's summary of one fact's priority: what the interface shows, nothing more. */
    public static function brief(array $x): array
    {
        return ['score' => $x['score'], 'level' => $x['level'], 'answers' => array_map(fn($a) => ['title' => $a['title'], 'state' => $a['state']], array_slice($x['answers'], 0, 3)),
            'answer_count' => count($x['answers']), 'worth' => $x['worth'], 'rests' => $x['rests']];
    }
}
