<?php
declare(strict_types=1);

namespace App;

final class Config
{
    private static array $c = [];

    public static function load(array $c): void { self::$c = $c; }

    public static function get(string $key, mixed $default = null): mixed
    {
        $v = self::$c;
        foreach (explode('.', $key) as $k) {
            if (!is_array($v) || !array_key_exists($k, $v)) return $default;
            $v = $v[$k];
        }
        return $v;
    }

    public static function isDev(): bool { return self::get('env') === 'dev'; }

    public static function appUrl(): string { return rtrim((string)self::get('app_url', ''), '/'); }
}
