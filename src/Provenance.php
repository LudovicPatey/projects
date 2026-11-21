<?php
declare(strict_types=1);

namespace App;

/**
 * Who produced a piece of content. Every AI-generated item must name its model,
 * and the name is stored on the item itself, so later changes to an agent's
 * default model never rewrite history.
 */
final class Provenance
{
    /** Model of the calling AI (request value, else the agent's default). Null for humans. */
    public static function agentModel(Request $r): ?string
    {
        return self::model($r->str('ai_model'));
    }

    public static function model(string $explicit): ?string
    {
        if (!Auth::isAi()) return null;
        $m = mb_substr(trim($explicit), 0, 120);
        if ($m === '' && Auth::isAgent()) $m = mb_substr((string)(Auth::user()['ai_model'] ?? ''), 0, 120);
        if ($m === '') {
            throw new HttpError(422, 'AI-generated content must state its model: send ai_model.');
        }
        return $m;
    }

    /** Who an AI output is for, and how long it took when the client measured it. */
    public static function stamp(?string $model, mixed $seconds): array
    {
        if ($model === null) return ['ai_user_id' => null, 'ai_generation_ms' => null];
        return ['ai_user_id' => Auth::aiUserId(), 'ai_generation_ms' => self::milliseconds($seconds)];
    }

    public static function milliseconds(mixed $seconds): ?int
    {
        if ($seconds === null || $seconds === '') return null;
        if (!is_numeric($seconds) || (float)$seconds < 0 || (float)$seconds > 2592000) {
            throw new HttpError(422, 'generation_seconds must be a number between 0 and 2592000 (30 days).');
        }
        return (int)round((float)$seconds * 1000);
    }

    /** @return array{origin:string, ai_model:?string} */
    public static function resolve(Request $r, ?string $defaultModel = null): array
    {
        if (Auth::isAi()) return ['origin' => 'ai', 'ai_model' => self::agentModel($r)];
        $origin = $r->str('origin');
        if (!in_array($origin, ['human', 'ai'], true)) {
            throw new HttpError(422, 'Please state whether this was written by a human or by an AI.');
        }
        if ($origin === 'human') return ['origin' => 'human', 'ai_model' => null];
        $model = mb_substr($r->str('ai_model'), 0, 120) ?: (string)$defaultModel;
        if ($model === '') throw new HttpError(422, 'AI-generated content must state the model that produced it.');
        return ['origin' => 'ai', 'ai_model' => $model];
    }
}
