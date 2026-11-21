<?php
declare(strict_types=1);

namespace App;

/** Minimal but robust BibTeX parser / writer. */
final class BibTex
{
    /** @return list<array{type:string,key:string,fields:array<string,string>}> */
    public static function parse(string $src): array
    {
        $entries = [];
        $len = strlen($src);
        $i = 0;
        while (($at = strpos($src, '@', $i)) !== false) {
            $i = $at + 1;
            if (!preg_match('/\G\s*([A-Za-z]+)\s*([{(])/A', $src, $m, 0, $i)) continue;
            $type = strtolower($m[1]);
            $i += strlen($m[0]);
            $close = $m[2] === '{' ? '}' : ')';
            if (in_array($type, ['comment', 'preamble', 'string'], true)) {
                $i = self::skipBalanced($src, $i - 1);
                continue;
            }
            // key
            $comma = strpos($src, ',', $i);
            if ($comma === false) break;
            $key = trim(substr($src, $i, $comma - $i));
            $i = $comma + 1;
            $fields = [];
            while ($i < $len) {
                // skip whitespace and commas
                while ($i < $len && (ctype_space($src[$i]) || $src[$i] === ',')) $i++;
                if ($i >= $len || $src[$i] === $close) { $i++; break; }
                if (!preg_match('/\G([A-Za-z0-9_\-:.]+)\s*=\s*/A', $src, $fm, 0, $i)) {
                    $i++;
                    continue;
                }
                $name = strtolower($fm[1]);
                $i += strlen($fm[0]);
                $value = '';
                // value: concatenation of {..}, ".." or bare words joined by #
                while ($i < $len) {
                    $c = $src[$i];
                    if ($c === '{') {
                        $end = self::skipBalanced($src, $i);
                        $value .= substr($src, $i + 1, $end - $i - 2);
                        $i = $end;
                    } elseif ($c === '"') {
                        $j = $i + 1; $depth = 0;
                        while ($j < $len) {
                            if ($src[$j] === '{') $depth++;
                            elseif ($src[$j] === '}') $depth--;
                            elseif ($src[$j] === '"' && $depth === 0) break;
                            $j++;
                        }
                        $value .= substr($src, $i + 1, $j - $i - 1);
                        $i = $j + 1;
                    } else {
                        preg_match('/\G[^,#}\s)]+/A', $src, $wm, 0, $i);
                        $value .= $wm[0] ?? '';
                        $i += max(1, strlen($wm[0] ?? ''));
                    }
                    while ($i < $len && ctype_space($src[$i])) $i++;
                    if ($i < $len && $src[$i] === '#') { $i++; while ($i < $len && ctype_space($src[$i])) $i++; continue; }
                    break;
                }
                $fields[$name] = trim(preg_replace('/\s+/', ' ', $value));
            }
            if ($key !== '') $entries[] = ['type' => $type, 'key' => $key, 'fields' => $fields];
        }
        return $entries;
    }

    private static function skipBalanced(string $s, int $open): int
    {
        $depth = 0; $len = strlen($s);
        $o = $s[$open]; $c = $o === '(' ? ')' : '}';
        for ($j = $open; $j < $len; $j++) {
            if ($s[$j] === $o) $depth++;
            elseif ($s[$j] === $c) { $depth--; if ($depth === 0) return $j + 1; }
        }
        return $len;
    }

    public static function write(string $type, string $key, array $fields): string
    {
        $lines = [];
        foreach ($fields as $k => $v) {
            if ($v === '' || $v === null) continue;
            $lines[] = '  ' . str_pad($k, 10) . ' = {' . $v . '}';
        }
        return "@$type{" . $key . ",\n" . implode(",\n", $lines) . "\n}";
    }

    /** Removes TeX braces/commands for display. */
    public static function plain(string $s): string
    {
        $s = preg_replace('/\\\\(textit|textbf|emph|mathrm|text)\{([^{}]*)\}/', '$2', $s);
        $marks = ["'" => "\u{301}", '`' => "\u{300}", '^' => "\u{302}", '"' => "\u{308}", '~' => "\u{303}", '=' => "\u{304}", '.' => "\u{307}",
            'H' => "\u{30B}", 'c' => "\u{327}", 'k' => "\u{328}", 'u' => "\u{306}", 'v' => "\u{30C}", 'r' => "\u{30A}"];
        $accent = fn($m) => $m[2] . $marks[$m[1]];
        $s = preg_replace_callback('/\\\\([\'`^"~=.])\s*\{?\\\\?([A-Za-z])\}?/', $accent, $s);
        $s = preg_replace_callback('/\\\\([Hckuvr])(?:\s+|\s*\{)\\\\?([A-Za-z])\}?/', $accent, $s);
        $letters = ['ss' => 'ß', 'ae' => 'æ', 'AE' => 'Æ', 'oe' => 'œ', 'OE' => 'Œ', 'aa' => 'å', 'AA' => 'Å', 'o' => 'ø', 'O' => 'Ø', 'l' => 'ł', 'L' => 'Ł'];
        $s = preg_replace_callback('/\\\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L)(?![A-Za-z])\s*/', fn($m) => $letters[$m[1]], $s);
        $s = str_replace(['---', '--'], ['—', '–'], $s);
        $s = str_replace(['{', '}', '\\&', '~'], ['', '', '&', ' '], $s);
        if (class_exists(\Normalizer::class)) $s = \Normalizer::normalize($s, \Normalizer::FORM_C) ?: $s;
        return trim($s);
    }

    /** "Tao, Terence" becomes "Terence Tao". */
    private static function displayName(string $name): string
    {
        $parts = array_map('trim', explode(',', self::plain($name)));
        return match (count($parts)) {
            2 => $parts[1] . ' ' . $parts[0],
            3 => $parts[2] . ' ' . $parts[0] . ' ' . $parts[1],
            default => implode(', ', $parts),
        };
    }

    /** Columns stored for listing/sorting. */
    public static function columns(array $fields): array
    {
        $authors = $fields['author'] ?? ($fields['editor'] ?? '');
        $authors = implode(', ', array_map(fn($a) => self::displayName(trim($a)), preg_split('/\s+and\s+/i', $authors) ?: []));
        $venue = $fields['journal'] ?? $fields['booktitle'] ?? $fields['publisher'] ?? $fields['school'] ?? $fields['howpublished'] ?? '';
        if (!$venue && !empty($fields['eprint'])) $venue = 'arXiv:' . $fields['eprint'];
        $url = $fields['url'] ?? '';
        if (!$url && !empty($fields['eprint']) && strtolower($fields['archiveprefix'] ?? 'arxiv') === 'arxiv') $url = 'https://arxiv.org/abs/' . $fields['eprint'];
        return [
            'title' => self::plain($fields['title'] ?? '(untitled)'),
            'authors' => $authors,
            'year' => substr(preg_replace('/\D/', '', $fields['year'] ?? ''), 0, 4) ?: null,
            'venue' => self::plain($venue) ?: null,
            'doi' => ($fields['doi'] ?? '') ?: null,
            'url' => $url ?: null,
        ];
    }

    /** Fetch BibTeX for a DOI (or arXiv id) via doi.org content negotiation. */
    public static function fetchDoi(string $id): string
    {
        $id = trim($id);
        $id = preg_replace('#^https?://(dx\.)?doi\.org/#i', '', $id);
        $id = preg_replace('#^https?://arxiv\.org/(abs|pdf)/#i', '', $id);
        $id = preg_replace('#^arxiv:#i', '', $id);
        $id = preg_replace('#v\d+$|\.pdf$#', '', $id);
        if (preg_match('#^(\d{4}\.\d{4,5}|[a-z\-]+(\.[A-Z]{2})?/\d{7})$#i', $id)) $id = '10.48550/arXiv.' . $id;
        if (!preg_match('#^10\.\d{4,9}/\S+$#', $id)) throw new HttpError(422, 'Not a valid DOI or arXiv identifier.');
        try {
            return Orcid::http('https://doi.org/' . $id, null, ['Accept: application/x-bibtex; charset=utf-8']);
        } catch (\Throwable) {
            throw new HttpError(404, "No metadata found for $id.");
        }
    }
}
