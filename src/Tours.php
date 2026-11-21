<?php
declare(strict_types=1);

namespace App;

/** Which first-use tutorials an account has already seen, stored as "home,project". */
final class Tours
{
    public const KINDS = ['home', 'project'];

    /** @return list<string> */
    public static function parse(mixed $stored): array
    {
        if (!is_string($stored)) return [];
        return array_values(array_intersect(self::KINDS, explode(',', $stored)));
    }

    /** The stored value with $seen added, or null when $seen is not a list of known tutorials. */
    public static function merge(mixed $stored, mixed $seen): ?string
    {
        if (!is_array($seen) || !array_is_list($seen)) return null;
        foreach ($seen as $kind) {
            if (!in_array($kind, self::KINDS, true)) return null;
        }
        return implode(',', array_values(array_intersect(self::KINDS, [...self::parse($stored), ...$seen])));
    }
}
