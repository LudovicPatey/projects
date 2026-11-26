<?php
declare(strict_types=1);

namespace App;

/**
 * Checks a reference an AI suggested against its public record: the DOI at Crossref, or the arXiv id at arXiv. A reference whose
 * record has the same title and its first author is real, and is added to the bibliography without a person. Only the identifier is
 * sent, never anything about the project or its members.
 *
 * Settings in config.php under "bib_check": enabled (true), crossref ("https://api.crossref.org/works/"), arxiv
 * ("https://export.arxiv.org/api/query?id_list="), seconds (20: the time all checks of one request may take).
 */
final class BibCheck
{
    /** @return ?array{by: string, year: ?string, venue: ?string} where the record was found, and what it adds; null when not confirmed */
    public static function verify(array $s, float $deadline): ?array
    {
        if (!Config::get('bib_check.enabled', true) || microtime(true) > $deadline) return null;
        try {
            if ($s['doi']) {
                $r = self::crossref((string)$s['doi'], $deadline);
                if ($r && self::matches($s, $r)) return ['by' => 'crossref', 'year' => $r['year'], 'venue' => $r['venue']];
            }
            if ($s['arxiv'] && microtime(true) <= $deadline) {
                $r = self::arxiv((string)$s['arxiv'], $deadline);
                if ($r && self::matches($s, $r)) return ['by' => 'arxiv', 'year' => $r['year'], 'venue' => null];
            }
        } catch (\Throwable) { /* unreachable or malformed: a person decides */ }
        return null;
    }

    /** The same work: the titles agree, and the first author the AI named is an author of the record. */
    public static function matches(array $s, array $record): bool
    {
        if (!self::sameTitle((string)$s['title'], (string)$record['title'])) return false;
        $first = self::surname(explode(' and ', (string)(BibTex::authorList($s['authors'] ?? null) ?? ''))[0] ?? '');
        if ($first === '') return false;
        foreach ($record['authors'] as $a) if (self::fold(self::surname($a)) === self::fold($first)) return true;
        return false;
    }

    public static function sameTitle(string $a, string $b): bool
    {
        $a = self::words($a); $b = self::words($b);
        if (!$a || !$b) return false;
        if ($a === $b) return true;
        if (min(count($a), count($b)) < 3) return false; // too short to tell apart from another work
        // Most words in common, a long word spelled one letter apart counting as the same (colorings, colourings).
        $left = $b; $found = 0;
        foreach ($a as $w) {
            foreach ($left as $i => $v) {
                if ($w === $v || (strlen($w) >= 5 && levenshtein($w, $v) <= 1)) { $found++; unset($left[$i]); break; }
            }
        }
        return $found / max(count($a), count($b)) >= 0.8;
    }

    /** @return list<string> */
    private static function words(string $t): array
    {
        $t = self::fold(preg_replace('/\\\\[a-zA-Z]+|[{}$^_]/', ' ', $t) ?? $t);
        return array_values(array_filter(preg_split('/[^a-z0-9]+/', $t) ?: [], fn($w) => $w !== ''));
    }

    private static function fold(string $t): string
    {
        $t = mb_strtolower(trim($t));
        $ascii = function_exists('iconv') ? @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $t) : false;
        return is_string($ascii) && $ascii !== '' ? strtolower($ascii) : $t;
    }

    /** "Hindman, Neil", "Neil Hindman" → Hindman. */
    private static function surname(string $name): string
    {
        $name = trim($name);
        if (str_contains($name, ',')) return trim(explode(',', $name)[0]);
        $parts = preg_split('/\s+/u', $name) ?: [];
        return (string)end($parts);
    }

    private static function fetch(string $url, float $deadline): string
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => max(1, (int)min(8, ceil($deadline - microtime(true)))), CURLOPT_USERAGENT => 'OpenQuestions-reference-check/1.0']);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false || $code >= 400) throw new \RuntimeException("HTTP $code");
        return (string)$body;
    }

    /** @return ?array{title: string, authors: list<string>, year: ?string, venue: ?string} */
    private static function crossref(string $doi, float $deadline): ?array
    {
        $j = json_decode(self::fetch(Config::get('bib_check.crossref', 'https://api.crossref.org/works/') . rawurlencode($doi), $deadline), true);
        $m = $j['message'] ?? null;
        if (!is_array($m) || !($m['title'][0] ?? null)) return null;
        $year = $m['issued']['date-parts'][0][0] ?? $m['published']['date-parts'][0][0] ?? null;
        return ['title' => (string)$m['title'][0], 'authors' => array_values(array_filter(array_map(fn($a) => (string)($a['family'] ?? $a['name'] ?? ''), (array)($m['author'] ?? [])))),
            'year' => $year ? (string)$year : null, 'venue' => isset($m['container-title'][0]) ? mb_substr((string)$m['container-title'][0], 0, 255) : null];
    }

    /** @return ?array{title: string, authors: list<string>, year: ?string} */
    private static function arxiv(string $id, float $deadline): ?array
    {
        $xml = @simplexml_load_string(self::fetch(Config::get('bib_check.arxiv', 'https://export.arxiv.org/api/query?id_list=') . rawurlencode($id), $deadline));
        if (!$xml) return null;
        $xml->registerXPathNamespace('a', 'http://www.w3.org/2005/Atom');
        $entry = $xml->xpath('//a:entry')[0] ?? null;
        if (!$entry || trim((string)$entry->title) === '' || stripos((string)$entry->title, 'error') === 0) return null;
        $authors = [];
        foreach ($entry->author as $a) $authors[] = (string)$a->name;
        $year = preg_match('/^(\d{4})/', (string)$entry->published, $m) ? $m[1] : null;
        return ['title' => preg_replace('/\s+/', ' ', trim((string)$entry->title)) ?? '', 'authors' => $authors, 'year' => $year];
    }
}
