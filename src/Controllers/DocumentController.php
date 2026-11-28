<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Provenance;
use App\{Access, Activity, Auth, Db, HttpError, Request, Response, Storage};

/**
 * Project files. A "document" is a versioned unit made of one PDF plus optional
 * LaTeX sources (.tex, .bib, images, .zip...). Each document is flagged as
 * written by a human or by an AI.
 */
final class DocumentController
{
    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $rows = Db::all(
            "SELECT d.id, d.title, d.description, d.origin, d.ai_model, d.created_at, d.updated_at, d.current_version_id,
                    u.name AS created_by_name, v.version_no AS current_version_no, v.ai_user_id, v.ai_generation_ms, au.name AS ai_user_name,
                    (SELECT COUNT(*) FROM document_versions dv WHERE dv.document_id = d.id) AS version_count,
                    (SELECT COUNT(*) FROM version_files f WHERE f.version_id = d.current_version_id AND f.role <> 'pdf') AS source_count,
                    (SELECT COUNT(*) FROM comments c WHERE c.target_type = 'document' AND c.target_id = d.id AND c.parent_id IS NULL AND c.resolved = 0) AS open_threads
             FROM documents d JOIN users u ON u.id = d.created_by
             LEFT JOIN document_versions v ON v.id = d.current_version_id
             LEFT JOIN users au ON au.id = v.ai_user_id
             WHERE d.project_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC", [$pid]);
        Response::json(['documents' => $rows]);
    }

    public static function create(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $title = $r->str('title');
        if ($title === '') throw new HttpError(422, 'A title is required.');
        // Files uploaded by an AI agent are always flagged as AI-written, and AI files name their model.
        $prov = Provenance::resolve($r);
        $pdf = $r->files('pdf')[0] ?? throw new HttpError(422, 'A PDF is required.');
        $sources = $r->files('sources');

        $stamp = Provenance::stamp($prov['ai_model'], $r->input('generation_seconds'));
        $id = Db::tx(function () use ($r, $pid, $title, $prov, $pdf, $sources, $stamp) {
            $now = Db::now();
            $id = Db::insert('documents', [
                'project_id' => $pid, 'title' => mb_substr($title, 0, 255), 'description' => $r->str('description') ?: null,
                'origin' => $prov['origin'], 'ai_model' => $prov['ai_model'],
                'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now,
            ]);
            $vid = self::newVersion($id, $pdf, $sources, $r->str('notes') ?: 'Initial version', $prov['ai_model'], $stamp);
            Activity::touch($pid, 'document', $id, 'created');
            AiTaskController::queueDocument($pid, $id, $vid);
            return $id;
        });
        Response::json(self::present($id), 201);
    }

    public static function show(Request $r): never
    {
        $d = Access::document($r->int('id'));
        Response::json(self::present((int)$d['id']));
    }

    public static function update(Request $r): never
    {
        $d = self::writable($r->int('id'));
        $data = ['updated_at' => Db::now()];
        if ($r->input('title') !== null) {
            if ($r->str('title') === '') throw new HttpError(422, 'A title is required.');
            $data['title'] = mb_substr($r->str('title'), 0, 255);
        }
        if ($r->input('description') !== null) $data['description'] = $r->str('description') ?: null;
        if ($r->input('origin') !== null && !Auth::isAgent()) $data['origin'] = self::origin($r);
        if ($r->input('ai_model') !== null) $data['ai_model'] = mb_substr($r->str('ai_model'), 0, 120);
        if (($data['origin'] ?? $d['origin']) === 'human') {
            $data['ai_model'] = null;
        } elseif (($data['ai_model'] ?? $d['ai_model']) == '') {
            throw new HttpError(422, 'AI-generated content must state the model that produced it.');
        }
        Db::update('documents', $data, 'id = :id', ['id' => $d['id']]);
        // The current version carries the AI details: keep them consistent with the file.
        if ($d['current_version_id']) {
            if (($data['origin'] ?? $d['origin']) === 'human') {
                Db::update('document_versions', ['ai_model' => null, 'ai_user_id' => null, 'ai_generation_ms' => null], 'id = :id', ['id' => $d['current_version_id']]);
            } elseif (array_key_exists('ai_model', $data) && $data['ai_model'] !== $d['ai_model']) {
                Db::update('document_versions', ['ai_model' => $data['ai_model'], 'ai_user_id' => Auth::aiUserId()], 'id = :id', ['id' => $d['current_version_id']]);
            }
        }
        Activity::touch((int)$d['project_id'], 'document', (int)$d['id'], 'updated');
        Response::json(self::present((int)$d['id']));
    }

    public static function delete(Request $r): never
    {
        $d = Access::document($r->int('id'));
        if ((int)$d['created_by'] !== Auth::id()) Access::owner((int)$d['project_id']);
        Db::update('documents', ['deleted_at' => Db::now()], 'id = :id', ['id' => $d['id']]);
        Response::json(['ok' => true]);
    }

    public static function addVersion(Request $r): never
    {
        $d = self::writable($r->int('id'));
        $pdf = $r->files('pdf')[0] ?? throw new HttpError(422, 'A PDF is required for a new version.');
        $sources = $r->files('sources');
        $keep = $r->str('keep_sources') === '1' && !$sources;
        // A new version of an AI file names the model that produced this version.
        $model = $d['origin'] === 'ai'
            ? (Provenance::agentModel($r) ?? (mb_substr($r->str('ai_model'), 0, 120) ?: $d['ai_model']))
            : null;
        if ($d['origin'] === 'ai' && (string)$model === '') throw new HttpError(422, 'AI-generated content must state the model that produced it.');
        $stamp = $model !== null
            ? ['ai_user_id' => Auth::aiUserId(), 'ai_generation_ms' => Provenance::milliseconds($r->input('generation_seconds'))]
            : Provenance::stamp(null, null);
        Db::tx(function () use ($d, $pdf, $sources, $keep, $r, $model, $stamp) {
            $vid = self::newVersion((int)$d['id'], $pdf, $sources, $r->str('notes') ?: null, $model, $stamp);
            Activity::touch((int)$d['project_id'], 'document', (int)$d['id'], 'version', $vid);
            if ($model !== null) Db::update('documents', ['ai_model' => $model], 'id = :id', ['id' => $d['id']]);
            if ($keep && $d['current_version_id']) {
                Db::run("INSERT INTO version_files (version_id, role, filename, blob_id)
                         SELECT ?, role, filename, blob_id FROM version_files WHERE version_id = ? AND role <> 'pdf'",
                    [$vid, $d['current_version_id']]);
            }
            AiTaskController::queueDocument((int)$d['project_id'], (int)$d['id'], $vid);
        });
        Response::json(self::present((int)$d['id']), 201);
    }

    /** Restoring never deletes history: it creates a new version identical to the old one. */
    public static function restore(Request $r): never
    {
        $d = self::writable($r->int('id'));
        $old = Db::one('SELECT * FROM document_versions WHERE id = ? AND document_id = ?', [$r->int('vid'), $d['id']]);
        if (!$old) throw new HttpError(404, 'Version not found');
        Db::tx(function () use ($d, $old) {
            $vid = self::insertVersion((int)$d['id'], 'Restored from version ' . $old['version_no'], (int)$old['id'], $old['ai_model'],
                ['ai_user_id' => $old['ai_user_id'], 'ai_generation_ms' => $old['ai_generation_ms']]);
            Activity::touch((int)$d['project_id'], 'document', (int)$d['id'], 'restored', $vid);
            if ($old['ai_model'] !== null) Db::update('documents', ['ai_model' => $old['ai_model']], 'id = :id', ['id' => $d['id']]);
            Db::run('INSERT INTO version_files (version_id, role, filename, blob_id) SELECT ?, role, filename, blob_id FROM version_files WHERE version_id = ?',
                [$vid, $old['id']]);
        });
        Response::json(self::present((int)$d['id']));
    }

    public static function file(Request $r): never
    {
        $f = Db::one('SELECT f.*, v.document_id FROM version_files f JOIN document_versions v ON v.id = f.version_id WHERE f.id = ?', [$r->int('fid')]);
        if (!$f) throw new HttpError(404, 'File not found');
        Access::document((int)$f['document_id']);
        Storage::serve((int)$f['blob_id'], $f['filename'], !isset($r->query['download']));
    }

    /** Download a whole version (PDF + sources) as a zip archive. */
    public static function zip(Request $r): never
    {
        $v = Db::one('SELECT * FROM document_versions WHERE id = ?', [$r->int('vid')]);
        if (!$v) throw new HttpError(404, 'Version not found');
        $d = Access::document((int)$v['document_id']);
        if (!class_exists(\ZipArchive::class)) throw new HttpError(500, 'Zip support is not available on this server.');
        $tmp = tempnam(sys_get_temp_dir(), 'crpzip');
        $zip = new \ZipArchive();
        $zip->open($tmp, \ZipArchive::OVERWRITE);
        $used = [];
        foreach (Db::all('SELECT * FROM version_files WHERE version_id = ?', [$v['id']]) as $f) {
            $name = $f['filename'];
            for ($i = 2; isset($used[$name]); $i++) $name = pathinfo($f['filename'], PATHINFO_FILENAME) . "-$i." . pathinfo($f['filename'], PATHINFO_EXTENSION);
            $used[$name] = true;
            $zip->addFile(Storage::blob((int)$f['blob_id'])['path'], $name);
        }
        $zip->close();
        $fname = preg_replace('/[^\w\-]+/', '_', $d['title']) . '-v' . $v['version_no'] . '.zip';
        header('Content-Type: application/zip');
        header('Content-Length: ' . filesize($tmp));
        header('Content-Disposition: attachment; filename="' . $fname . '"');
        readfile($tmp);
        unlink($tmp);
        exit;
    }

    // ---------------------------------------------------------------------

    /** Agents may only modify AI-written files; humans may modify any file of their projects. */
    private static function writable(int $id): array
    {
        $d = Access::document($id);
        if (Auth::isAgent() && $d['origin'] !== 'ai') {
            throw new HttpError(403, 'AI agents cannot modify human-written files. Upload a new AI file instead.');
        }
        return $d;
    }

    private static function origin(Request $r): string
    {
        $o = $r->str('origin');
        if (!in_array($o, ['human', 'ai'], true)) throw new HttpError(422, "Please state whether this file was written by a human or by an AI.");
        return $o;
    }

    private static function insertVersion(int $docId, ?string $notes, ?int $restoredFrom = null, ?string $model = null, array $stamp = []): int
    {
        $no = (int)Db::value('SELECT COALESCE(MAX(version_no), 0) FROM document_versions WHERE document_id = ?', [$docId]) + 1;
        $vid = Db::insert('document_versions', $stamp + [
            'document_id' => $docId, 'version_no' => $no, 'notes' => $notes, 'restored_from_id' => $restoredFrom, 'ai_model' => $model,
            'uploaded_by' => Auth::id(), 'created_at' => Db::now(),
        ]);
        Db::update('documents', ['current_version_id' => $vid, 'updated_at' => Db::now()], 'id = :id', ['id' => $docId]);
        return $vid;
    }

    /**
     * The LaTeX document of a fact, compiled by an AI client: a new file, or a new version of the one already made from that fact.
     * It is not extracted: its facts are already the project's. @param array<string, string> $sources file name => content
     */
    public static function saveExport(int $pid, int $factId, string $title, string $description, string $pdfPath, array $sources, ?string $model, array $stamp): int
    {
        return Db::tx(function () use ($pid, $factId, $title, $description, $pdfPath, $sources, $model, $stamp) {
            $now = Db::now();
            $id = (int)Db::value('SELECT id FROM documents WHERE project_id = ? AND exported_fact_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [$pid, $factId]);
            $isNew = !$id;
            if ($id) Db::update('documents', ['title' => mb_substr($title, 0, 255), 'description' => $description, 'ai_model' => $model, 'updated_at' => $now], 'id = :id', ['id' => $id]);
            else $id = Db::insert('documents', ['project_id' => $pid, 'title' => mb_substr($title, 0, 255), 'description' => $description, 'origin' => 'ai', 'ai_model' => $model,
                'exported_fact_id' => $factId, 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
            $pdfBlob = Storage::storeFile($pdfPath, true, 'document.pdf');
            $vid = self::insertVersion($id, 'Assembled from the facts of the project', null, $model, $stamp);
            Db::insert('version_files', ['version_id' => $vid, 'role' => 'pdf', 'filename' => 'document.pdf', 'blob_id' => $pdfBlob]);
            foreach ($sources as $name => $content) {
                $tmp = tempnam(sys_get_temp_dir(), 'oqx');
                file_put_contents($tmp, $content);
                $role = str_ends_with($name, '.bib') ? 'bib' : 'source';
                Db::insert('version_files', ['version_id' => $vid, 'role' => $role, 'filename' => $name, 'blob_id' => Storage::storeFile($tmp, false, $name)]);
                @unlink($tmp);
            }
            Activity::touch($pid, 'document', $id, $isNew ? 'created' : 'version', $isNew ? null : $vid);
            return $id;
        });
    }

    private static function newVersion(int $docId, array $pdf, array $sources, ?string $notes, ?string $model = null, array $stamp = []): int
    {
        $pdfBlob = Storage::storeUpload($pdf, true);
        $vid = self::insertVersion($docId, $notes, null, $model, $stamp);
        Db::insert('version_files', ['version_id' => $vid, 'role' => 'pdf', 'filename' => self::safeName($pdf['name'], 'document.pdf'), 'blob_id' => $pdfBlob]);
        foreach ($sources as $s) {
            $name = self::safeName($s['name'], 'source');
            $role = strtolower(pathinfo($name, PATHINFO_EXTENSION)) === 'bib' ? 'bib' : 'source';
            Db::insert('version_files', ['version_id' => $vid, 'role' => $role, 'filename' => $name, 'blob_id' => Storage::storeUpload($s)]);
        }
        return $vid;
    }

    private static function safeName(string $name, string $fallback): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[^\p{L}\p{N}_.\- ]+/u', '_', $name);
        return mb_substr(trim($name, '. '), 0, 200) ?: $fallback;
    }

    public static function present(int $id): array
    {
        $d = Db::one('SELECT d.*, u.name AS created_by_name FROM documents d JOIN users u ON u.id = d.created_by WHERE d.id = ?', [$id]);
        $versions = Db::all(
            'SELECT v.*, u.name AS uploaded_by_name, au.name AS ai_user_name, r.version_no AS restored_from_no
             FROM document_versions v JOIN users u ON u.id = v.uploaded_by
             LEFT JOIN users au ON au.id = v.ai_user_id
             LEFT JOIN document_versions r ON r.id = v.restored_from_id
             WHERE v.document_id = ? ORDER BY v.version_no DESC', [$id]);
        $vids = array_column($versions, 'id');
        [$in, $params] = Db::in($vids);
        $files = Db::all("SELECT f.id, f.version_id, f.role, f.filename, b.size, b.sha256 FROM version_files f JOIN blobs b ON b.id = f.blob_id
                          WHERE f.version_id IN $in ORDER BY f.role, f.filename", $params);
        foreach ($versions as &$v) {
            $v['files'] = array_values(array_filter($files, fn($f) => $f['version_id'] == $v['id']));
            $pdf = array_values(array_filter($v['files'], fn($f) => $f['role'] === 'pdf'))[0] ?? null;
            $v['pdf_file_id'] = $pdf ? (int)$pdf['id'] : null;
            $v['pdf_sha'] = $pdf['sha256'] ?? null;
            $v['is_current'] = (int)$v['id'] === (int)$d['current_version_id'];
        }
        $d['versions'] = $versions;
        // A document assembled from a fact links back to it: the facts are its content, and the file is redone from them.
        $d['exported_fact'] = $d['exported_fact_id'] ? Db::one('SELECT id, label, title FROM facts WHERE id = ? AND deleted_at IS NULL', [$d['exported_fact_id']]) : null;
        $d['last_activity_id'] = Activity::latest((int)$d['project_id'], 'document', $id);
        // Its description, often an abstract pasted from the paper, renders with the paper's own macros and without its references.
        $d['tex_macros'] = \App\TexMacros::forDocument($id);
        $d['description_shown'] = $d['description'] !== null ? \App\TexMacros::dropRefs((string)$d['description']) : null;
        return $d;
    }
}
