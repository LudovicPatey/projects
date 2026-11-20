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

    public static function tx(callable $fn): mixed
    {
        $pdo = self::pdo();
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
        ];
        foreach ($migrations as $m) {
            try { self::pdo()->exec($m); } catch (\PDOException) { /* already applied */ }
        }
    }
}
