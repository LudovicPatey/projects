<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Config, Db, HttpError, Request, Sanitizer, Storage};

/**
 * Lets any project member download a complete copy of what they can see in a project:
 * readable documents, original files, and structured JSON. Private conversations of other
 * members, email addresses, API credentials and read state are never included.
 */
final class ExportController
{
    private const JSON = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    public static function project(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        if (!class_exists(\ZipArchive::class)) throw new HttpError(500, 'Zip support is not available on this server.');
        $me = Auth::id();
        // The export can take a while: do not block the user's other requests.
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        @set_time_limit(0);

        $dir = rtrim((string)Config::get('storage_path'), '/') . '/tmp';
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) throw new HttpError(500, 'Cannot prepare the export.');
        foreach (glob("$dir/export-*.zip") ?: [] as $old) {
            if (filemtime($old) < time() - 21600) @unlink($old);
        }
        $lock = fopen("$dir/export-$me.lock", 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) throw new HttpError(429, 'Your previous export is still being prepared.');
        $tmp = "$dir/export-" . bin2hex(random_bytes(8)) . '.zip';
        register_shutdown_function(function () use ($tmp, $lock) {
            @unlink($tmp);
            flock($lock, LOCK_UN);
            fclose($lock);
        });

        $project = Db::one('SELECT id, title, status, question_html, created_at, updated_at FROM projects WHERE id = ?', [$pid]);
        $root = 'open-questions-' . self::slug($project['title'], 'project') . '-' . gmdate('Ymd');
        $zip = new \ZipArchive();
        if ($zip->open($tmp, \ZipArchive::CREATE | \ZipArchive::EXCL) !== true) throw new HttpError(500, 'Cannot prepare the export.');
        $x = new \stdClass();
        $x->zip = $zip; $x->root = $root; $x->bytes = 0; $x->files = []; $x->missing = [];

        $project['question_text'] = Sanitizer::toText((string)$project['question_html']);
        self::text($x, 'project.json', json_encode($project, self::JSON));
        self::text($x, 'question.md', "# {$project['title']}\n\n{$project['question_text']}\n");
        $members = array_map(fn($m) => array_intersect_key($m, array_flip(['id', 'name', 'orcid', 'affiliation', 'kind', 'ai_model', 'role', 'joined_at'])),
            ProjectController::members($pid));
        foreach ($members as &$m) if ($m['kind'] === 'agent') unset($m['orcid']);
        unset($m);
        self::text($x, 'members.json', json_encode($members, self::JSON));

        $counts = [
            'questions' => self::questions($x, $pid),
            'facts' => self::facts($x, $pid),
            'files' => self::documents($x, $pid),
            'references' => self::bibliography($x, $pid),
            'conversations' => self::conversations($x, $pid, $me),
        ];
        $free = @disk_free_space($dir);
        if ($free !== false && $free < $x->bytes * 1.1 + 10485760) {
            $zip->unchangeAll();
            $zip->close();
            throw new HttpError(507, 'Not enough disk space on the server to prepare this export.');
        }
        self::text($x, 'manifest.json', json_encode([
            'app' => 'open-questions', 'export_format' => 1, 'exported_at' => gmdate('c'),
            'exported_by' => ['id' => $me, 'name' => Auth::user()['name']],
            'project' => ['id' => $pid, 'title' => $project['title']], 'counts' => $counts,
            'files' => $x->files, 'missing_files' => $x->missing,
        ], self::JSON));
        self::text($x, 'README.md', self::readme($project, $counts, $x->missing, (string)Auth::user()['name']));
        if (!$zip->close()) throw new HttpError(500, 'Could not write the export.');

        while (ob_get_level()) ob_end_clean();
        header('Content-Type: application/zip');
        header('Content-Length: ' . filesize($tmp));
        header('Content-Disposition: attachment; filename="' . $root . '.zip"');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
        readfile($tmp);
        exit;
    }

    private static function questions(\stdClass $x, int $pid): int
    {
        $all = [];
        foreach (Db::all('SELECT * FROM open_questions WHERE project_id = ? AND deleted_at IS NULL ORDER BY id', [$pid]) as $row) {
            $q = QuestionController::present($row);
            $q['comments'] = self::comments('oquestion', $q['id']);
            foreach ($q['strategies'] as &$s) $s['comments'] = self::comments('strategy', $s['id']);
            unset($s);
            $all[$q['id']] = $q;
        }
        $children = [];
        foreach ($all as $q) $children[$q['parent_id'] ?? 0][] = $q['id'];
        $md = "# Open questions\n";
        $walk = function (int $parent, int $level) use (&$walk, &$md, $all, $children) {
            foreach ($children[$parent] ?? [] as $id) {
                $q = $all[$id];
                $md .= "\n" . str_repeat('#', min(6, $level)) . " {$q['title']} [{$q['status']}]\n\n" . ($q['statement_text'] !== '' ? $q['statement_text'] . "\n" : '');
                if ($q['ai_model']) $md .= "\n_Written by AI: {$q['ai_model']}_\n";
                foreach ($q['answers'] as $a) {
                    $md .= "\n**" . ucfirst($a['state']) . " {$a['answer']} answer**, fact `" . ($a['fact']['label'] ?? 'deleted') . "`, proposed by {$a['proposer']}" . ($a['ai_model'] ? " (AI: {$a['ai_model']})" : '')
                        . ($a['ratified_by_name'] ? ", ratified by {$a['ratified_by_name']}" : '') . ($a['closed_note'] ? ". Note: {$a['closed_note']}" : '') . "\n";
                    if ($a['rationale_text'] !== '') $md .= "\n{$a['rationale_text']}\n";
                }
                foreach ($q['strategies'] as $s) {
                    $md .= "\n**Strategy: {$s['title']}** [{$s['status']}], revision {$s['current_revision']}\n\n" . ($s['body_text'] !== '' ? $s['body_text'] . "\n" : '');
                    foreach ($s['revisions'] as $v) {
                        $md .= "- r{$v['revision_no']} {$v['created_at']} UTC, {$v['author_name']}" . ($v['ai_model'] ? " (AI: {$v['ai_model']})" : '') . ": " . str_replace("\n", ' ', $v['change_note']) . "\n";
                    }
                }
                $md .= self::commentsMarkdown($q['comments']);
                $walk($id, $level + 1);
            }
        };
        $walk(0, 2);
        self::text($x, 'questions/questions.md', $md);
        self::text($x, 'questions/questions.json', json_encode(array_values($all), self::JSON));
        return count($all);
    }

    private static function facts(\stdClass $x, int $pid): int
    {
        $byId = array_column(FactController::graph($pid)['facts'], null, 'id');
        $all = [];
        foreach (array_keys($byId) as $id) {
            $row = Db::one('SELECT * FROM facts WHERE id = ?', [$id]);
            $f = FactController::present($row, $byId);
            foreach ($f['revisions'] as &$rev) {
                $rev['sources'] = FactController::presentSources($id, (int)$rev['revision_no']);
            }
            unset($rev);
            $f['comments'] = self::comments('fact', $id);
            $all[] = $f;
            self::text($x, 'facts/' . self::fileSlug($f['label']) . '.md', self::factMarkdown($f));
            foreach ($f['lean_proofs'] as $l) {
                self::text($x, 'facts/lean/' . self::fileSlug($f['label']) . "-{$l['id']}.lean", (string)$l['code']);
            }
        }
        self::text($x, 'facts/facts.json', json_encode($all, self::JSON));
        return count($all);
    }

    private static function factMarkdown(array $f): string
    {
        $front = [
            'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'], 'labels' => $f['labels'], 'status' => $f['status'],
            'revision' => $f['current_revision'], 'method' => $f['method'], 'tool' => $f['tool'], 'statement_origin' => $f['origin'], 'proof_origin' => $f['proof_origin'],
            'ai_model' => $f['ai_model'], 'ai_user' => $f['ai_user_name'], 'generation_ms' => $f['ai_generation_ms'], 'lean' => $f['lean'],
            'depends_on' => array_column($f['deps'], 'label'), 'endorsed_by' => array_column($f['endorsed_by'], 'name'),
        ];
        $out = "---\n";
        foreach ($front as $k => $v) $out .= "$k: " . json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"; // JSON values are valid YAML
        $out .= "---\n\n# {$f['title']}\n\n## statement\n\n{$f['statement_text']}\n";
        if ($f['proof_text'] !== '') $out .= "\n## proof\n\n{$f['proof_text']}\n";
        if ($f['intuition_text'] !== '') $out .= "\n## intuition\n\n{$f['intuition_text']}\n";
        if ($f['sources']) {
            $out .= "\n## sources\n\n";
            foreach ($f['sources'] as $s) {
                $who = $s['author']['name'] ?? '';
                $out .= '- ' . ($s['label'] ?? $s['type']) . ($s['page'] ? ", p. {$s['page']}" : '') . " ({$s['covers']})" . ($who !== '' ? ", $who" : '') . "\n";
                if ($s['quote']) $out .= '  > ' . str_replace("\n", ' ', $s['quote']) . "\n";
            }
        }
        $current = array_filter($f['reviews'], fn($v) => (int)$v['revision_no'] === (int)$f['current_revision']);
        if ($current) {
            $out .= "\n## reviews\n\n";
            foreach ($current as $v) {
                $result = $v['verdict'] !== 'correct' && $v['statement_verdict'] ? " (result: {$v['statement_verdict']})" : '';
                $out .= "- **{$v['verdict']}**$result by {$v['reviewer_name']}" . ($v['ai_model'] ? " (AI: {$v['ai_model']})" : '') . ($v['body_text'] !== '' ? ": {$v['body_text']}" : '') . "\n";
            }
        }
        $proofs = array_filter($f['proofs'] ?? [], fn($p) => (int)$p['revision_no'] === (int)$f['current_revision']);
        foreach (array_values($proofs) as $i => $p) {
            $out .= "\n## other proof " . ($i + 1) . " ({$p['state']}), by {$p['author_name']}" . ($p['author_kind'] === 'agent' ? " (AI: {$p['ai_model']})" : '') . "\n\n{$p['body_text']}\n";
            foreach ($p['reviews'] as $v) $out .= "\n- **{$v['verdict']}** by {$v['reviewer_name']}" . ($v['body_text'] !== '' ? ": {$v['body_text']}" : '');
            if ($p['reviews']) $out .= "\n";
        }
        return $out . self::commentsMarkdown($f['comments']);
    }

    private static function documents(\stdClass $x, int $pid): int
    {
        $ids = array_column(Db::all('SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY id', [$pid]), 'id');
        foreach ($ids as $id) {
            $d = DocumentController::present((int)$id);
            $folder = 'files/' . $id . '-' . self::slug($d['title'], 'file');
            foreach ($d['versions'] as &$v) {
                $used = [];
                foreach ($v['files'] as &$f) {
                    $name = self::uniqueName((string)$f['filename'], $used);
                    $f['path'] = "v{$v['version_no']}/$name";
                    self::blob($x, $f['sha256'], "$folder/v{$v['version_no']}/$name");
                }
                unset($f);
            }
            unset($v);
            $d['comments'] = self::comments('document', (int)$id);
            self::text($x, "$folder/file.json", json_encode($d, self::JSON));
        }
        return count($ids);
    }

    private static function bibliography(\stdClass $x, int $pid): int
    {
        $rows = Db::all('SELECT * FROM bib_entries WHERE project_id = ? ORDER BY cite_key', [$pid]);
        $bibtex = '';
        $all = [];
        $used = [];
        foreach ($rows as $row) {
            $b = BibController::present($row);
            $bibtex .= $b['bibtex'] . "\n\n";
            if ($b['has_pdf']) {
                $blob = Storage::blob((int)$b['pdf_blob_id']);
                $name = self::uniqueName(self::fileSlug($b['cite_key']) . '.pdf', $used);
                $b['pdf']['path'] = "pdfs/$name";
                self::blob($x, $blob['sha256'], "bibliography/pdfs/$name");
            }
            $b['comments'] = self::comments('bib', (int)$b['id']);
            $all[] = $b;
        }
        self::text($x, 'bibliography/references.bib', $bibtex);
        self::text($x, 'bibliography/references.json', json_encode($all, self::JSON));
        return count($all);
    }

    /** Only the conversations this member takes part in. */
    private static function conversations(\stdClass $x, int $pid, int $me): int
    {
        $rows = Db::all('SELECT c.id, c.subject, c.visibility, c.created_at, c.last_message_at FROM conversations c
                         JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ?
                         WHERE c.project_id = ? ORDER BY c.id', [$me, $pid]);
        $all = [];
        foreach ($rows as $c) {
            $c['participants'] = Db::all('SELECT u.id, u.name, u.kind FROM conversation_participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ? ORDER BY u.name', [$c['id']]);
            $c['messages'] = Db::all(
                'SELECT m.id, m.author_id, u.name AS author_name, u.kind AS author_kind, m.ai_model, m.ai_user_id, au.name AS ai_user_name, m.ai_generation_ms,
                        m.body_html, m.created_at, m.edited_at
                 FROM messages m JOIN users u ON u.id = m.author_id LEFT JOIN users au ON au.id = m.ai_user_id
                 WHERE m.conversation_id = ? ORDER BY m.created_at, m.id', [$c['id']]);
            $md = "# {$c['subject']}\n\n" . ($c['visibility'] === 'project' ? 'Open to the whole project, including future members. ' : '')
                . 'Participants: ' . implode(', ', array_column($c['participants'], 'name')) . "\n";
            foreach ($c['messages'] as &$m) {
                $m['body_text'] = Sanitizer::toText($m['body_html']);
                $md .= "\n---\n\n**{$m['author_name']}**" . ($m['ai_model'] ? " (AI: {$m['ai_model']})" : '') . ", {$m['created_at']} UTC\n\n{$m['body_text']}\n";
            }
            unset($m);
            $c['comments'] = self::comments('conversation', (int)$c['id']);
            $md .= self::commentsMarkdown($c['comments']);
            self::text($x, 'conversations/' . $c['id'] . '-' . self::slug($c['subject'], 'conversation') . '.md', $md);
            $all[] = $c;
        }
        self::text($x, 'conversations/conversations.json', json_encode($all, self::JSON));
        return count($all);
    }

    private static function comments(string $type, int $id): array
    {
        $rows = Db::all(
            'SELECT c.id, c.parent_id, c.author_id, u.name AS author_name, u.kind AS author_kind, c.ai_model, c.ai_user_id, au.name AS ai_user_name, c.ai_generation_ms,
                    c.body_html, c.anchor_json, c.resolved, c.created_at, c.edited_at
             FROM comments c JOIN users u ON u.id = c.author_id LEFT JOIN users au ON au.id = c.ai_user_id
             WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at, c.id', [$type, $id]);
        foreach ($rows as &$c) {
            $c['anchor'] = $c['anchor_json'] ? json_decode($c['anchor_json'], true) : null;
            unset($c['anchor_json']);
            $c['resolved'] = (bool)$c['resolved'];
            $c['body_text'] = Sanitizer::toText($c['body_html']);
        }
        return $rows;
    }

    private static function commentsMarkdown(array $comments): string
    {
        if (!$comments) return '';
        $out = "\n## comments\n\n";
        foreach ($comments as $c) {
            $indent = $c['parent_id'] ? '  ' : '';
            $quote = $c['anchor']['quote'] ?? '';
            if ($quote !== '') $out .= "$indent> " . str_replace("\n", ' ', $quote) . "\n";
            $out .= "$indent- **{$c['author_name']}**" . ($c['ai_model'] ? " (AI: {$c['ai_model']})" : '') . ", {$c['created_at']} UTC: " . str_replace("\n", ' ', $c['body_text']) . "\n";
        }
        return $out;
    }

    private static function readme(array $p, array $counts, array $missing, string $by): string
    {
        $out = "# {$p['title']}\n\nCopy of this Open Questions project, exported on " . gmdate('Y-m-d H:i') . " UTC by $by.\n\n"
            . "| Content | Where |\n|---|---|\n"
            . "| The open question | `question.md` |\n"
            . "| Members | `members.json` |\n"
            . "| {$counts['questions']} open questions and sub-questions, with proof strategies and their history | `questions/` |\n"
            . "| {$counts['facts']} facts, with reviews, Lean proofs and traceability | `facts/` |\n"
            . "| {$counts['files']} files, with every version and its LaTeX sources | `files/` |\n"
            . "| {$counts['references']} references, with BibTeX and PDFs | `bibliography/` |\n"
            . "| {$counts['conversations']} conversations you take part in | `conversations/` |\n"
            . "| List of files with their SHA-256 | `manifest.json` |\n\n"
            . "Each section has readable Markdown or original files, and JSON with the full details, including the AI model, user and generation time of AI content.\n\n"
            . "This copy contains what $by could see. It does not include private conversations they do not take part in, email addresses, API credentials or read state.\n";
        if ($missing) $out .= "\n**Warning:** " . count($missing) . " file(s) could not be read on the server and are missing from this copy. See `missing_files` in `manifest.json`.\n";
        return $out;
    }

    private static function text(\stdClass $x, string $path, string $content): void
    {
        $x->zip->addFromString("{$x->root}/$path", $content);
    }

    private static function blob(\stdClass $x, string $sha, string $path): void
    {
        $file = Storage::pathFor($sha);
        if (!is_file($file)) { $x->missing[] = ['path' => $path, 'sha256' => $sha]; return; }
        $entry = "{$x->root}/$path";
        $x->zip->addFile($file, $entry);
        $x->zip->setCompressionName($entry, \ZipArchive::CM_STORE); // PDFs barely compress
        $size = (int)filesize($file);
        $x->bytes += $size;
        $x->files[] = ['path' => $path, 'size' => $size, 'sha256' => $sha];
    }

    private static function slug(string $s, string $fallback): string
    {
        $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) ?: '';
        $ascii = str_replace(["'", '"', '`', '^', '~'], '', $ascii); // some iconv versions write accents as separate marks
        return substr(trim((string)preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-'), 0, 60) ?: $fallback;
    }

    private static function fileSlug(string $label): string
    {
        return trim((string)preg_replace('/[^A-Za-z0-9_.-]+/', '-', $label), '-.') ?: 'item';
    }

    /** A safe name inside the archive: no folders, no leading dots, no duplicates. */
    private static function uniqueName(string $name, array &$used): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = trim((string)preg_replace('/[^\p{L}\p{N}_. -]+/u', '_', $name), '. ');
        $name = mb_substr($name, 0, 150) ?: 'file';
        $candidate = $name;
        for ($i = 2; isset($used[mb_strtolower($candidate)]); $i++) {
            $ext = pathinfo($name, PATHINFO_EXTENSION);
            $candidate = pathinfo($name, PATHINFO_FILENAME) . "-$i" . ($ext !== '' ? ".$ext" : '');
        }
        $used[mb_strtolower($candidate)] = true;
        return $candidate;
    }
}
