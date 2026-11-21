<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Db, HttpError, Request, Response};

/**
 * Global search over what the current user can see. The text is matched in PHP rather than in SQL,
 * so that it behaves the same on MySQL and SQLite, ignores accents ("Erdos" finds "Erdős") and
 * never matches HTML markup. Email addresses and quotes from private sources are not searched.
 */
final class SearchController
{
    private const GROUPS = ['fact' => 'Facts', 'conversation' => 'Conversations', 'file' => 'Files', 'reference' => 'Bibliography',
        'comment' => 'Comments', 'person' => 'People', 'project' => 'Projects'];
    private const PREVIEW = 5;
    private const FULL = 50;
    private const LETTERS = ['ø' => 'o', 'ł' => 'l', 'đ' => 'd', 'ð' => 'd', 'ħ' => 'h', 'ı' => 'i', 'ß' => 'ss', 'æ' => 'ae', 'œ' => 'oe', 'þ' => 'th',
        '–' => '-', '—' => '-', '−' => '-', '‐' => '-', '’' => "'", '‘' => "'", '“' => '"', '”' => '"',
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'å' => 'a', 'ā' => 'a', 'ă' => 'a', 'ą' => 'a', 'ç' => 'c', 'ć' => 'c', 'č' => 'c', 'ď' => 'd',
        'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e', 'ē' => 'e', 'ė' => 'e', 'ę' => 'e', 'ě' => 'e', 'ğ' => 'g', 'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'ī' => 'i', 'į' => 'i',
        'ľ' => 'l', 'ĺ' => 'l', 'ñ' => 'n', 'ń' => 'n', 'ň' => 'n', 'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ö' => 'o', 'ō' => 'o', 'ő' => 'o', 'ŕ' => 'r', 'ř' => 'r',
        'ś' => 's', 'š' => 's', 'ş' => 's', 'ș' => 's', 'ť' => 't', 'ţ' => 't', 'ț' => 't', 'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ū' => 'u', 'ů' => 'u', 'ű' => 'u', 'ų' => 'u',
        'ý' => 'y', 'ÿ' => 'y', 'ź' => 'z', 'ż' => 'z', 'ž' => 'z'];

    public static function search(Request $r): never
    {
        $started = microtime(true);
        $raw = $r->query['q'] ?? '';
        $q = is_string($raw) ? trim(mb_substr($raw, 0, 120)) : '';
        $terms = array_values(array_unique(preg_split('/\s+/u', self::fold($q), -1, PREG_SPLIT_NO_EMPTY) ?: []));
        $terms = array_slice($terms, 0, 8);
        $wanted = is_string($r->query['type'] ?? null) ? $r->query['type'] : '';
        if ($wanted !== '' && !isset(self::GROUPS[$wanted])) throw new HttpError(422, 'Unknown search type.');
        $current = is_scalar($r->query['project'] ?? null) ? (int)$r->query['project'] : 0;
        if ($current) Access::member($current);
        $scope = ($r->query['scope'] ?? '') === 'project' ? 'project' : 'all';
        if ($scope === 'project' && !$current) throw new HttpError(422, 'A project is required for this scope.');
        if (mb_strlen(implode('', $terms)) < 2) Response::json(['query' => $q, 'total' => 0, 'groups' => []]);

        $me = Auth::id();
        $projects = Db::all('SELECT p.id, p.title, p.status, p.question_html FROM projects p
                             JOIN project_members m ON m.project_id = p.id AND m.user_id = ?' . ($scope === 'project' ? ' WHERE p.id = ' . $current : ''), [$me]);
        $titles = array_column($projects, 'title', 'id');
        $x = (object)['pids' => array_map('intval', array_keys($titles)), 'terms' => $terms, 'me' => $me];

        $found = [];
        foreach (array_keys(self::GROUPS) as $type) {
            if ($wanted !== '' && $wanted !== $type) continue;
            $found[$type] = match ($type) {
                'fact' => self::facts($x),
                'conversation' => self::conversations($x),
                'file' => self::files($x),
                'reference' => self::references($x),
                'comment' => self::comments($x),
                'person' => self::people($x, $current),
                'project' => self::projects($x, $projects),
            };
        }

        $limit = $wanted !== '' ? self::FULL : self::PREVIEW;
        $groups = [];
        $total = 0;
        foreach ($found as $type => $items) {
            if (!$items) continue;
            foreach ($items as &$it) if ((int)$it['project_id'] === $current) $it['score'] += 20;
            unset($it);
            usort($items, fn($a, $b) => $b['score'] <=> $a['score'] ?: strcmp((string)$b['at'], (string)$a['at']) ?: $a['id'] <=> $b['id']);
            $total += count($items);
            $results = array_map(function ($it) use ($type, $titles) {
                unset($it['score']);
                return $it + ['type' => $type, 'project_title' => $titles[$it['project_id']] ?? ''];
            }, array_slice($items, 0, $limit));
            $groups[] = ['type' => $type, 'label' => self::GROUPS[$type], 'total' => count($items), 'results' => $results];
        }
        usort($groups, fn($a, $b) => (int)(($b['results'][0]['project_id'] ?? 0) === $current) <=> (int)(($a['results'][0]['project_id'] ?? 0) === $current));
        Response::json(['query' => $q, 'total' => $total, 'groups' => $groups, 'took_ms' => (int)round((microtime(true) - $started) * 1000)]);
    }

    // ---------------------------------------------------------------------

    private static function facts(object $x): array
    {
        [$in, $params] = Db::in($x->pids);
        $extra = [];
        foreach (Db::all("SELECT v.fact_id, v.body_html FROM fact_reviews v JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision
                          WHERE f.project_id IN $in AND f.deleted_at IS NULL AND v.body_html IS NOT NULL", $params) as $v) {
            $extra[(int)$v['fact_id']]['review'][] = self::plain($v['body_html']);
        }
        foreach (Db::all("SELECT l.fact_id, l.decl_name, l.code FROM fact_lean l JOIN facts f ON f.id = l.fact_id AND l.revision_no = f.current_revision
                          WHERE f.project_id IN $in AND f.deleted_at IS NULL", $params) as $l) {
            $extra[(int)$l['fact_id']]['lean'][] = trim($l['decl_name'] . ' ' . $l['code']);
        }
        $out = [];
        $rows = Db::all("SELECT f.id, f.project_id, f.label, f.kind, f.title, f.labels_json, f.method, f.tool, f.ai_model, f.updated_at,
                                r.statement_html, r.proof_html, r.intuition_html, r.glossary_json
                         FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                         WHERE f.project_id IN $in AND f.deleted_at IS NULL", $params);
        foreach ($rows as $f) {
            $id = (int)$f['id'];
            $labels = json_decode((string)$f['labels_json'], true) ?: [];
            $m = self::match($f['title'], [
                'statement' => self::plain($f['statement_html']), 'proof' => self::plain((string)$f['proof_html']), 'intuition' => self::plain((string)$f['intuition_html']),
                'review' => implode(' ', $extra[$id]['review'] ?? []), 'Lean' => implode(' ', $extra[$id]['lean'] ?? []),
                'glossary' => $f['glossary_json'] ? implode(' ', array_map(fn($k, $v) => $k . ' ' . (is_scalar($v) ? $v : ''), array_keys((array)json_decode($f['glossary_json'], true)), (array)json_decode($f['glossary_json'], true))) : '',
                'details' => implode(' ', [$f['kind'], str_replace('_', ' ', implode(' ', $labels)), $f['method'], $f['tool'], $f['ai_model']]),
            ], $x->terms, $f['label']);
            if ($m) $out[] = self::item($id, (int)$f['project_id'], $f['title'], $m, $f['updated_at'], ['view' => 'facts', 'id' => $id], $f['label']);
        }
        return $out;
    }

    /** Only the conversations this user takes part in. One result per conversation, its best message. */
    private static function conversations(object $x): array
    {
        [$in, $params] = Db::in($x->pids);
        $best = [];
        $rows = Db::all("SELECT c.id, c.project_id, c.subject, c.last_message_at, m.body_html, u.name AS author
                         FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ?
                         JOIN messages m ON m.conversation_id = c.id JOIN users u ON u.id = m.author_id
                         WHERE c.project_id IN $in ORDER BY m.id", array_merge([$x->me], $params));
        foreach ($rows as $c) {
            $id = (int)$c['id'];
            $m = self::match($c['subject'], ['message' => self::plain($c['body_html']), 'author' => $c['author']], $x->terms);
            if (!$m || (isset($best[$id]) && $best[$id]['score'] >= $m['score'])) continue;
            $best[$id] = self::item($id, (int)$c['project_id'], $c['subject'], $m, $c['last_message_at'], ['view' => 'conversations', 'id' => $id], $c['author']);
        }
        return array_values($best);
    }

    private static function files(object $x): array
    {
        [$in, $params] = Db::in($x->pids);
        $names = [];
        foreach (Db::all("SELECT v.document_id, v.notes, f.filename FROM document_versions v JOIN documents d ON d.id = v.document_id
                          LEFT JOIN version_files f ON f.version_id = v.id WHERE d.project_id IN $in AND d.deleted_at IS NULL", $params) as $v) {
            $names[(int)$v['document_id']][(string)$v['filename']] = true;
            if ($v['notes']) $names[(int)$v['document_id']][(string)$v['notes']] = true;
        }
        $out = [];
        foreach (Db::all("SELECT d.id, d.project_id, d.title, d.description, d.origin, d.ai_model, d.updated_at, u.name AS author
                          FROM documents d JOIN users u ON u.id = d.created_by WHERE d.project_id IN $in AND d.deleted_at IS NULL", $params) as $d) {
            $id = (int)$d['id'];
            $m = self::match($d['title'], ['description' => (string)$d['description'], 'file' => implode(' ', array_keys($names[$id] ?? [])),
                'details' => trim($d['author'] . ' ' . $d['ai_model'])], $x->terms);
            if ($m) $out[] = self::item($id, (int)$d['project_id'], $d['title'], $m, $d['updated_at'], ['view' => 'files', 'id' => $id], $d['origin'] === 'ai' ? 'AI' : 'Human');
        }
        return $out;
    }

    private static function references(object $x): array
    {
        [$in, $params] = Db::in($x->pids);
        $out = [];
        foreach (Db::all("SELECT id, project_id, cite_key, title, authors, year, venue, doi, updated_at FROM bib_entries WHERE project_id IN $in", $params) as $b) {
            $m = self::match($b['title'], ['authors' => (string)$b['authors'], 'venue' => trim($b['venue'] . ' ' . $b['year']), 'doi' => (string)$b['doi']], $x->terms, $b['cite_key']);
            if ($m) {
                if ($m['field'] === null) $m['snippet'] = trim($b['authors'] . ($b['year'] ? " ({$b['year']})" : ''));
                $out[] = self::item((int)$b['id'], (int)$b['project_id'], $b['title'], $m, $b['updated_at'], ['view' => 'bib', 'id' => (int)$b['id']], $b['cite_key']);
            }
        }
        return $out;
    }

    /** A comment is found only if its target is visible: private conversations are left out here. */
    private static function comments(object $x): array
    {
        [$in, $params] = Db::in($x->pids);
        $targets = ['fact' => [], 'document' => [], 'bib' => [], 'conversation' => []];
        foreach (Db::all("SELECT id, label AS t FROM facts WHERE project_id IN $in AND deleted_at IS NULL", $params) as $t) $targets['fact'][(int)$t['id']] = $t['t'];
        foreach (Db::all("SELECT id, title AS t FROM documents WHERE project_id IN $in AND deleted_at IS NULL", $params) as $t) $targets['document'][(int)$t['id']] = $t['t'];
        foreach (Db::all("SELECT id, cite_key AS t FROM bib_entries WHERE project_id IN $in", $params) as $t) $targets['bib'][(int)$t['id']] = $t['t'];
        foreach (Db::all("SELECT c.id, c.subject AS t FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ? WHERE c.project_id IN $in",
            array_merge([$x->me], $params)) as $t) $targets['conversation'][(int)$t['id']] = $t['t'];
        $views = ['fact' => 'facts', 'document' => 'files', 'bib' => 'bib', 'conversation' => 'conversations'];
        $out = [];
        foreach (Db::all("SELECT c.id, c.project_id, c.target_type, c.target_id, c.parent_id, c.body_html, c.anchor_json, c.created_at, u.name AS author
                          FROM comments c JOIN users u ON u.id = c.author_id WHERE c.project_id IN $in", $params) as $c) {
            $target = $targets[$c['target_type']][(int)$c['target_id']] ?? null;
            if ($target === null) continue;
            $anchor = $c['anchor_json'] ? (json_decode($c['anchor_json'], true)['quote'] ?? '') : '';
            $m = self::match('', ['comment' => self::plain($c['body_html']), 'passage' => (string)$anchor, 'author' => $c['author']], $x->terms);
            if (!$m) continue;
            $link = ['view' => $views[$c['target_type']], 'id' => (int)$c['target_id'], 'query' => ['comment' => (int)($c['parent_id'] ?: $c['id'])]];
            $out[] = self::item((int)$c['id'], (int)$c['project_id'], 'On ' . $target, $m, $c['created_at'], $link, $c['author']);
        }
        return $out;
    }

    /** Name, ORCID iD, affiliation and AI model. Never the email address. */
    private static function people(object $x, int $current): array
    {
        [$in, $params] = Db::in($x->pids);
        $out = [];
        foreach (Db::all("SELECT u.id, u.name, u.orcid, u.affiliation, u.kind, u.ai_model, m.project_id, m.role, m.joined_at
                          FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id IN $in", $params) as $u) {
            $id = (int)$u['id'];
            $agent = $u['kind'] === 'agent';
            $hit = self::match($u['name'], ['ORCID' => $agent ? '' : (string)$u['orcid'], 'affiliation' => (string)$u['affiliation'], 'model' => (string)$u['ai_model']], $x->terms);
            if (!$hit) continue;
            if (isset($out[$id]) && (int)$u['project_id'] !== $current) continue;
            if ($hit['field'] === null) $hit['snippet'] = $agent ? (string)$u['ai_model'] : ((string)$u['affiliation'] ?: (string)$u['orcid']);
            $out[$id] = self::item($id, (int)$u['project_id'], $u['name'], $hit, $u['joined_at'], ['view' => 'members', 'query' => ['user' => $id]], $agent ? 'AI agent' : $u['role']);
        }
        return array_values($out);
    }

    private static function projects(object $x, array $projects): array
    {
        $out = [];
        foreach ($projects as $p) {
            $m = self::match($p['title'], ['question' => self::plain((string)$p['question_html'])], $x->terms);
            if ($m) $out[] = self::item((int)$p['id'], (int)$p['id'], $p['title'], $m, '', ['view' => 'overview'], $p['status']);
        }
        return $out;
    }

    // ---------------------------------------------------------------------

    private static function item(int $id, int $project, string $title, array $m, ?string $at, array $link, ?string $badge): array
    {
        return ['id' => $id, 'project_id' => $project, 'title' => $title, 'snippet' => $m['snippet'], 'field' => $m['field'],
            'badge' => $badge, 'link' => $link, 'score' => $m['score'], 'at' => (string)$at];
    }

    /** All terms must appear somewhere. A match in the title or key ranks first. */
    private static function match(string $title, array $fields, array $terms, string $key = ''): ?array
    {
        $ft = self::fold($title);
        $fk = $key === '' ? '' : self::fold($key);
        $all = "$ft\n$fk";
        $folded = [];
        foreach ($fields as $name => $text) {
            if ($text === '') continue;
            $f = self::fold($text);
            $folded[$name] = [$text, $f];
            $all .= "\n$f";
        }
        foreach ($terms as $t) if (!str_contains($all, $t)) return null;

        $phrase = implode(' ', $terms);
        $score = 0;
        if ($ft === $phrase || $fk === $phrase) $score += 100;
        elseif (str_starts_with($ft, $phrase) || ($fk !== '' && str_starts_with($fk, $phrase))) $score += 60;
        elseif (str_contains($ft, $phrase) || str_contains($fk, $phrase)) $score += 35;
        foreach ($terms as $t) {
            if (str_contains($ft, $t) || str_contains($fk, $t)) $score += 12;
            if (preg_match('/(^|[^\p{L}\p{N}])' . preg_quote($t, '/') . '/u', "$ft $fk")) $score += 6;
        }
        $order = 0;
        foreach ($folded as $name => [$text, $f]) {
            foreach ($terms as $t) if (str_contains($f, $t)) { $score += max(1, 4 - $order); break; }
            $order++;
        }

        // The excerpt shows the first field containing a term. If only the title matched, the start of the first field.
        foreach ($folded as $name => [$text, $f]) {
            foreach ($terms as $t) {
                $bytes = strpos($f, $t);
                if ($bytes !== false) return ['score' => $score, 'field' => $name, 'snippet' => self::excerpt($text, $f, mb_strlen(substr($f, 0, $bytes)))];
            }
        }
        $first = reset($folded);
        return ['score' => $score, 'field' => null, 'snippet' => $first ? self::excerpt($first[0], $first[1], 0) : ''];
    }

    /** A short passage around a position, which never cuts a $...$ formula in two. */
    private static function excerpt(string $text, string $folded, int $pos): string
    {
        $len = mb_strlen($text);
        $flen = max(1, mb_strlen($folded));
        if ($flen !== $len) $pos = (int)round($pos * $len / $flen);
        $start = max(0, $pos - 55);
        $end = min($len, $start + 175);
        if ($start > 0) {
            $space = mb_strrpos(mb_substr($text, 0, $start), ' ');
            if ($space !== false && $start - $space < 20) $start = $space + 1;
            $before = mb_substr($text, 0, $start);
            if (substr_count($before, '$') % 2 === 1) $start = (int)mb_strrpos($before, '$');
        }
        if ($end < $len) {
            $slice = mb_substr($text, $start, $end - $start);
            if (substr_count($slice, '$') % 2 === 1) {
                $next = mb_strpos($text, '$', $end);
                if ($next !== false && $next - $end < 120) $end = $next + 1;
                else $end = $start + (int)mb_strrpos($slice, '$');
            }
        }
        return ($start > 0 ? '…' : '') . trim(mb_substr($text, $start, $end - $start)) . ($end < $len ? '…' : '');
    }

    private static function plain(string $html): string
    {
        if ($html === '') return '';
        $text = preg_replace('#</(p|li|h\d|blockquote|pre)>|<br\s*/?>#i', ' ', $html) ?? $html;
        $text = html_entity_decode(strip_tags($text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    }

    public static function fold(string $s): string
    {
        $s = mb_strtolower($s, 'UTF-8');
        $s = strtr($s, self::LETTERS);
        return preg_replace('/\p{Mn}+/u', '', $s) ?? $s; // decomposed accents
    }
}
