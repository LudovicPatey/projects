<?php
declare(strict_types=1);

namespace App;

/**
 * The macros a paper defines in its LaTeX source (\newcommand{\msf}{\mathsf}, \def\N{\mathbb N}, \DeclareMathOperator{\Th}{Th}), so
 * that text taken from it, such as an abstract pasted as a file's description, renders as the paper does. Given to KaTeX as its
 * `macros`. And a text's cross-references (\ref, \cite), which point inside the paper, are taken out.
 */
final class TexMacros
{
    private const MAX_BYTES = 2_000_000;
    private const MAX_MACROS = 300;

    /** @return array<string, string> by command, as KaTeX takes them: "\\msf" => "\\mathsf" */
    public static function parse(string $tex): array
    {
        $tex = preg_replace('/(?<!\\\\)%.*$/m', '', $tex) ?? $tex; // comments
        $out = [];
        $n = strlen($tex);
        $re = '/\\\\(?:(?:re)?newcommand\*?|providecommand\*?|DeclareMathOperator\*?|def)\s*/';
        $offset = 0;
        while (count($out) < self::MAX_MACROS && preg_match($re, $tex, $m, PREG_OFFSET_CAPTURE, $offset)) {
            $kind = $m[0][0]; $i = $m[0][1] + strlen($kind); $offset = $i;
            // The name: {\name} or \name.
            if (($tex[$i] ?? '') === '{') { $name = self::group($tex, $i); if ($name === null) continue; [$name, $i] = $name; $name = trim($name); }
            elseif (preg_match('/\G\\\\([A-Za-z]+|.)/', $tex, $nm, 0, $i)) { $name = $nm[0]; $i += strlen($nm[0]); }
            else continue;
            if (!preg_match('/^\\\\[A-Za-z]+$/', $name)) continue;
            if (str_starts_with(ltrim($kind, '\\'), 'def')) {
                // \def\name#1#2{...}: only its parameter text is skipped.
                while ($i < $n && $tex[$i] !== '{') $i++;
            } else {
                while ($i < $n && ctype_space($tex[$i])) $i++;
                if (($tex[$i] ?? '') === '[') { $close = strpos($tex, ']', $i); if ($close === false) continue; $i = $close + 1; }
                while ($i < $n && ctype_space($tex[$i])) $i++;
                if (($tex[$i] ?? '') === '[') continue; // an optional argument with a default: KaTeX cannot take it
            }
            $body = self::group($tex, $i);
            if ($body === null) continue;
            [$text, $offset] = $body;
            $text = trim($text);
            if (str_contains($kind, 'DeclareMathOperator')) $text = '\\operatorname' . (str_ends_with(rtrim($kind), '*') ? '*' : '') . '{' . $text . '}';
            if ($text === '' || strlen($text) > 500 || str_contains($text, $name)) continue; // recursive: left out
            $out[$name] ??= $text;
        }
        return $out;
    }

    /** The balanced {...} group starting at $i. @return array{0: string, 1: int}|null its content, and the offset after it */
    private static function group(string $s, int $i): ?array
    {
        if (($s[$i] ?? '') !== '{') return null;
        $depth = 0;
        for ($j = $i, $n = strlen($s); $j < $n; $j++) {
            $c = $s[$j];
            if ($c === '\\') { $j++; continue; }
            if ($c === '{') $depth++;
            elseif ($c === '}' && --$depth === 0) return [substr($s, $i + 1, $j - $i - 1), $j + 1];
        }
        return null;
    }

    /** The macros of a file's current version, from its LaTeX sources. @return array<string, string> */
    public static function forDocument(int $documentId): array
    {
        $files = Db::all("SELECT f.filename, b.sha256 FROM documents d JOIN version_files f ON f.version_id = d.current_version_id JOIN blobs b ON b.id = f.blob_id
                          WHERE d.id = ? AND f.role = 'source' ORDER BY f.id", [$documentId]);
        $out = []; $read = 0;
        foreach ($files as $f) {
            if (!preg_match('/\.(tex|sty|cls|ltx)$/i', (string)$f['filename'])) continue;
            $path = Storage::pathFor((string)$f['sha256']);
            $size = is_file($path) ? (int)filesize($path) : 0;
            if (!$size || $read + $size > self::MAX_BYTES) continue;
            $read += $size;
            $out += self::parse((string)file_get_contents($path));
        }
        return $out;
    }

    /** Cross-references and citations point inside the paper: taken out of a text shown on its own. */
    public static function dropRefs(string $text): string
    {
        // "(Lemma \ref{x})" says nothing once the number is gone: the whole parenthesis goes.
        $text = preg_replace('/\s*\(\s*(?:[A-Za-z]+\.?\s*)?~?\\\\(?:(?:eq|auto|page|c|C|name)?ref|cite[pt]?)\*?(?:\[[^\]]*\])*\{[^{}]*\}\s*\)/', '', $text) ?? $text;
        $text = preg_replace('/\s*~?\\\\(?:eq|auto|page|c|C|name)?ref\*?\{[^{}]*\}/', '', $text) ?? $text;
        $text = preg_replace('/\s*~?\\\\cite[pt]?\*?(?:\[[^\]]*\])*\{[^{}]*\}/', '', $text) ?? $text;
        return preg_replace('/\(\s*\)/', '', $text) ?? $text;
    }
}
