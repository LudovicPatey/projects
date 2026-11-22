<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, BibTex, Db, HttpError, Provenance, Request, Response, Storage};

final class BibController
{
    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $rows = Db::all(
            "SELECT b.id, b.cite_key, b.entry_type, b.title, b.authors, b.year, b.venue, b.doi, b.url, b.ai_model, b.ai_user_id, b.ai_generation_ms, au.name AS ai_user_name,
                    CASE WHEN b.pdf_blob_id IS NULL THEN 0 ELSE 1 END AS has_pdf, b.created_at, u.name AS added_by,
                    (SELECT COUNT(*) FROM comments c WHERE c.target_type = 'bib' AND c.target_id = b.id) AS comment_count
             FROM bib_entries b JOIN users u ON u.id = b.created_by LEFT JOIN users au ON au.id = b.ai_user_id
             WHERE b.project_id = ? ORDER BY b.cite_key", [$pid]);
        Response::json(['entries' => $rows]);
    }

    public static function show(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        Response::json(self::present($b));
    }

    public static function present(array $b): array
    {
        $fields = json_decode($b['fields_json'], true) ?: [];
        $b['fields'] = $fields;
        $b['bibtex'] = BibTex::write($b['entry_type'], $b['cite_key'], $fields);
        $b['has_pdf'] = $b['pdf_blob_id'] !== null;
        $b['added_by'] = Db::value('SELECT name FROM users WHERE id = ?', [$b['created_by']]);
        $b['ai_user_name'] = $b['ai_user_id'] ? Db::value('SELECT name FROM users WHERE id = ?', [$b['ai_user_id']]) : null;
        $b['last_activity_id'] = Activity::latest((int)$b['project_id'], 'bib', (int)$b['id']);
        if ($b['has_pdf']) {
            $blob = Storage::blob((int)$b['pdf_blob_id']);
            $b['pdf'] = [
                'blob_id' => (int)$b['pdf_blob_id'], 'size' => (int)$blob['size'], 'uploaded_at' => $b['pdf_uploaded_at'],
                'uploaded_by' => Db::value('SELECT name FROM users WHERE id = ?', [$b['pdf_uploaded_by']]),
            ];
        }
        unset($b['fields_json']);
        return $b;
    }

    /** Accepts {bibtex: "..."} (one or many entries), {doi: "..."} or {entry_type, cite_key, fields: {...}}. */
    public static function create(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $entries = [];
        if ($r->str('doi') !== '') {
            $entries = BibTex::parse(BibTex::fetchDoi($r->str('doi')));
        } elseif ($r->str('bibtex') !== '') {
            $entries = BibTex::parse($r->str('bibtex'));
        } else {
            $fields = array_filter(array_map(fn($v) => is_scalar($v) ? trim((string)$v) : '', (array)$r->input('fields', [])), fn($v) => $v !== '');
            if (empty($fields['title'])) throw new HttpError(422, 'A title is required.');
            $entries = [['type' => $r->str('entry_type') ?: 'article', 'key' => $r->str('cite_key'), 'fields' => $fields]];
        }
        if (!$entries) throw new HttpError(422, 'No BibTeX entry could be read.');

        $created = []; $skipped = [];
        foreach ($entries as $e) {
            $fields = array_change_key_case($e['fields']);
            if (!empty($fields['doi']) && Db::value('SELECT 1 FROM bib_entries WHERE project_id = ? AND LOWER(doi) = LOWER(?)', [$pid, $fields['doi']])) {
                $skipped[] = $e['key'] ?: ($fields['title'] ?? '?');
                continue;
            }
            $key = self::uniqueKey($pid, $e['key'] !== '' ? $e['key'] : self::makeKey($fields));
            $now = Db::now();
            $created[] = $bid = Db::insert('bib_entries', BibTex::columns($fields) + $stamp + [
                'project_id' => $pid, 'cite_key' => $key, 'entry_type' => strtolower(preg_replace('/\W/', '', $e['type']) ?: 'misc'),
                'fields_json' => json_encode($fields, JSON_UNESCAPED_UNICODE),
                'ai_model' => $model, 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now,
            ]);
            Activity::touch($pid, 'bib', $bid, 'created');
        }
        Response::json(['created' => $created, 'skipped' => $skipped], 201);
    }

    public static function update(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        if ($r->str('bibtex') !== '') {
            $e = BibTex::parse($r->str('bibtex'))[0] ?? null;
            if (!$e) throw new HttpError(422, 'Invalid BibTeX.');
            $type = $e['type']; $key = $e['key']; $fields = array_change_key_case($e['fields']);
        } else {
            $type = $r->str('entry_type') ?: $b['entry_type'];
            $key = $r->str('cite_key') ?: $b['cite_key'];
            $fields = array_filter(array_map(fn($v) => is_scalar($v) ? trim((string)$v) : '', (array)$r->input('fields', [])), fn($v) => $v !== '');
        }
        if (empty($fields['title'])) throw new HttpError(422, 'A title is required.');
        if ($key !== $b['cite_key']) $key = self::uniqueKey((int)$b['project_id'], $key);
        $model = Provenance::agentModel($r);
        Db::update('bib_entries', BibTex::columns($fields) + ($model !== null ? Provenance::stamp($model, $r->input('generation_seconds')) : []) + [
            'cite_key' => $key, 'entry_type' => strtolower(preg_replace('/\W/', '', $type) ?: 'misc'),
            'fields_json' => json_encode($fields, JSON_UNESCAPED_UNICODE), 'updated_at' => Db::now(),
            'ai_model' => $model ?? $b['ai_model'],
        ], 'id = :id', ['id' => $b['id']]);
        Activity::touch((int)$b['project_id'], 'bib', (int)$b['id'], 'updated');
        Response::json(self::present(Access::bib((int)$b['id'])));
    }

    public static function delete(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        if ((int)$b['created_by'] !== Auth::id()) Access::owner((int)$b['project_id']);
        Db::run("DELETE FROM comments WHERE target_type = 'bib' AND target_id = ?", [$b['id']]);
        Db::run('DELETE FROM bib_entries WHERE id = ?', [$b['id']]);
        Response::json(['ok' => true]);
    }

    public static function uploadPdf(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        $file = $r->files('pdf')[0] ?? throw new HttpError(422, 'No PDF received.');
        $blob = Storage::storeUpload($file, true);
        Db::update('bib_entries', ['pdf_blob_id' => $blob, 'pdf_uploaded_by' => Auth::id(), 'pdf_uploaded_at' => Db::now(), 'updated_at' => Db::now()],
            'id = :id', ['id' => $b['id']]);
        Activity::touch((int)$b['project_id'], 'bib', (int)$b['id'], 'pdf');
        Response::json(self::present(Access::bib((int)$b['id'])));
    }

    public static function removePdf(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        Db::update('bib_entries', ['pdf_blob_id' => null, 'pdf_uploaded_by' => null, 'pdf_uploaded_at' => null], 'id = :id', ['id' => $b['id']]);
        Activity::touch((int)$b['project_id'], 'bib', (int)$b['id'], 'pdf_removed');
        Response::json(self::present(Access::bib((int)$b['id'])));
    }

    public static function pdf(Request $r): never
    {
        $b = Access::bib($r->int('id'));
        if (!$b['pdf_blob_id']) throw new HttpError(404, 'No PDF for this entry.');
        Storage::serve((int)$b['pdf_blob_id'], $b['cite_key'] . '.pdf', !isset($r->query['download']));
    }

    public static function export(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $out = [];
        foreach (Db::all('SELECT entry_type, cite_key, fields_json FROM bib_entries WHERE project_id = ? ORDER BY cite_key', [$pid]) as $b) {
            $out[] = BibTex::write($b['entry_type'], $b['cite_key'], json_decode($b['fields_json'], true) ?: []);
        }
        header('Content-Type: application/x-bibtex; charset=utf-8');
        header('Content-Disposition: attachment; filename="project-' . $pid . '.bib"');
        echo implode("\n\n", $out) . "\n";
        exit;
    }

    public static function makeKey(array $f): string
    {
        $first = preg_split('/\s+and\s+/i', $f['author'] ?? 'anon')[0];
        $last = str_contains($first, ',') ? explode(',', $first)[0] : (preg_split('/\s+/', trim($first)) ?: ['anon'])[count(preg_split('/\s+/', trim($first)) ?: ['anon']) - 1];
        $word = '';
        foreach (preg_split('/\s+/', BibTex::plain($f['title'] ?? '')) as $w) {
            if (mb_strlen($w) > 3) { $word = $w; break; }
        }
        $key = BibTex::plain($last) . ($f['year'] ?? '') . $word;
        $key = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $key) ?: 'ref';
        return strtolower(preg_replace('/[^A-Za-z0-9]/', '', $key)) ?: 'ref';
    }

    public static function uniqueKey(int $pid, string $key): string
    {
        $key = preg_replace('/[^\w:\-.+\/]/', '', $key) ?: 'ref';
        $base = $key; $i = 0;
        while (Db::value('SELECT 1 FROM bib_entries WHERE project_id = ? AND cite_key = ?', [$pid, $key])) {
            $key = $base . chr(ord('a') + $i++);
        }
        return $key;
    }
}
