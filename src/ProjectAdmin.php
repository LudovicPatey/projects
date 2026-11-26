<?php
declare(strict_types=1);

namespace App;

use App\Controllers\AiTaskController;

/**
 * Maintenance of one project, for its owners (the Admin page) and for administrators (bin/admin.php).
 * Each action has a preview that says exactly what it changes. Destructive ones make a verified backup first.
 * The bibliography, its PDFs, the files, conversations, questions and members are never touched.
 */
final class ProjectAdmin
{
    /** action => [label, destructive] */
    public const ACTIONS = [
        'cancel_waiting' => ['Cancel the waiting AI tasks', false],
        'retry_failed' => ['Try the failed AI tasks again', false],
        'requeue_extraction' => ['Extract the files and reference PDFs not yet extracted', false],
        'reset_extraction' => ['Reset the extraction status of every file and reference PDF', true],
        'clear_notation' => ['Clear the project notation', true],
        'reset_facts' => ['Empty the facts database', true],
    ];
    private const FACT_TASKS = "(kind IN ('extract', 'derive', 'review', 'lean', 'notation', 'consolidate') OR source_type = 'fact')";

    /** What the project holds, for the Admin page. */
    public static function summary(int $pid): array
    {
        $n = fn(string $sql, array $p = []) => (int)Db::value($sql, array_merge([$pid], $p));
        $facts = 'SELECT id FROM facts WHERE project_id = ?';
        return [
            'facts' => $n('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL'),
            'reviews' => $n("SELECT COUNT(*) FROM fact_reviews WHERE fact_id IN ($facts)"),
            'proofs' => $n("SELECT COUNT(*) FROM fact_proofs WHERE fact_id IN ($facts)"),
            'lean' => $n("SELECT COUNT(*) FROM fact_lean WHERE fact_id IN ($facts)"),
            'rephrasings' => $n("SELECT COUNT(*) FROM fact_rephrasings WHERE fact_id IN ($facts)"),
            'answers' => $n('SELECT COUNT(*) FROM question_answers WHERE project_id = ?'),
            'questions' => $n('SELECT COUNT(*) FROM open_questions WHERE project_id = ? AND deleted_at IS NULL'),
            'files' => $n('SELECT COUNT(*) FROM documents WHERE project_id = ? AND deleted_at IS NULL'),
            'references' => $n('SELECT COUNT(*) FROM bib_entries WHERE project_id = ?'),
            'reference_pdfs' => $n('SELECT COUNT(*) FROM bib_entries WHERE project_id = ? AND pdf_blob_id IS NOT NULL'),
            'conversations' => $n('SELECT COUNT(*) FROM conversations WHERE project_id = ?'),
            'notation' => $n('SELECT COUNT(*) FROM notations WHERE project_id = ?'),
            'members' => $n('SELECT COUNT(*) FROM project_members WHERE project_id = ?'),
            'tasks' => array_merge(['pending' => 0, 'running' => 0, 'done' => 0, 'failed' => 0, 'cancelled' => 0],
                array_map('intval', array_column(Db::all('SELECT status, COUNT(*) AS n FROM ai_tasks WHERE project_id = ? GROUP BY status', [$pid]), 'n', 'status'))),
        ];
    }

    /** Exactly what an action would change, without changing anything. */
    public static function preview(int $pid, string $action, array $opt = []): array
    {
        $n = fn(string $sql, array $p = []) => (int)Db::value($sql, array_merge([$pid], $p));
        $facts = 'SELECT id FROM facts WHERE project_id = ?';
        $out = match ($action) {
            'cancel_waiting' => ['tasks' => $n("SELECT COUNT(*) FROM ai_tasks WHERE project_id = ? AND status = 'pending'")],
            'retry_failed' => ['tasks' => $n("SELECT COUNT(*) FROM ai_tasks WHERE project_id = ? AND status = 'failed'")],
            'requeue_extraction' => self::toExtract($pid) + ['tasks' => 0],
            'reset_extraction' => ['tasks' => $n("SELECT COUNT(*) FROM ai_tasks WHERE project_id = ? AND kind = 'extract'")] + (empty($opt['requeue']) ? [] : ['queued_after' => self::everythingToExtract($pid)]),
            'clear_notation' => ($opt['mode'] ?? 'proposals') === 'all'
                ? ['entries' => $n('SELECT COUNT(*) FROM notations WHERE project_id = ?'), 'rephrasings' => $n("SELECT COUNT(*) FROM fact_rephrasings WHERE fact_id IN ($facts)")]
                : ['entries' => $n("SELECT COUNT(*) FROM notations WHERE project_id = ? AND status <> 'agreed'"), 'rephrasings' => 0],
            'reset_facts' => [
                'facts' => $n('SELECT COUNT(*) FROM facts WHERE project_id = ?'),
                'reviews' => $n("SELECT COUNT(*) FROM fact_reviews WHERE fact_id IN ($facts)"),
                'proofs' => $n("SELECT COUNT(*) FROM fact_proofs WHERE fact_id IN ($facts)"),
                'lean' => $n("SELECT COUNT(*) FROM fact_lean WHERE fact_id IN ($facts)"),
                'comments' => $n("SELECT COUNT(*) FROM comments WHERE project_id = ? AND target_type = 'fact'"),
                'answers' => $n("SELECT COUNT(*) FROM question_answers WHERE fact_id IN ($facts)"),
                'ratified_answers' => $n("SELECT COUNT(*) FROM question_answers WHERE state = 'ratified' AND fact_id IN ($facts)"),
                'question_links' => $n("SELECT COUNT(*) FROM question_links WHERE project_id = ? AND target_type = 'fact'"),
                'tasks' => $n('SELECT COUNT(*) FROM ai_tasks WHERE project_id = ? AND ' . self::FACT_TASKS),
                'notation' => empty($opt['notation']) ? 0 : $n('SELECT COUNT(*) FROM notations WHERE project_id = ?'),
            ] + (empty($opt['requeue']) ? [] : ['queued_after' => self::everythingToExtract($pid)]),
            default => throw new HttpError(404, 'Unknown action.'),
        };
        return ['action' => $action, 'label' => self::ACTIONS[$action][0], 'destructive' => self::ACTIONS[$action][1], 'changes' => $out];
    }

    /**
     * Runs an action. A destructive one makes a verified backup of the whole platform first, and stops if it fails.
     * @return array{changes: array, backup: ?string}
     */
    public static function run(int $pid, string $action, array $opt = [], bool $backup = true): array
    {
        if (!isset(self::ACTIONS[$action])) throw new HttpError(404, 'Unknown action.');
        $file = null;
        if (self::ACTIONS[$action][1] && $backup) {
            $b = Backup::create();
            if ($b['manifest']['problems']) throw new HttpError(500, 'The backup reports missing or damaged files, so nothing was changed.');
            $file = basename($b['file']);
        }
        $now = Db::now();
        $changes = match ($action) {
            'cancel_waiting' => ['tasks' => Db::run("UPDATE ai_tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE project_id = ? AND status = 'pending'", [$now, $now, $pid])->rowCount()],
            'retry_failed' => ['tasks' => Db::run("UPDATE ai_tasks SET status = 'pending', attempts = 0, not_before = NULL, error_text = NULL, finished_at = NULL, updated_at = ? WHERE project_id = ? AND status = 'failed'", [$now, $pid])->rowCount()],
            'requeue_extraction' => ['queued' => self::queueExtraction($pid, false)],
            'reset_extraction' => Db::tx(fn() => ['tasks' => Db::run("DELETE FROM ai_tasks WHERE project_id = ? AND kind = 'extract'", [$pid])->rowCount()]) + (empty($opt['requeue']) ? [] : ['queued' => self::queueExtraction($pid, true)]),
            'clear_notation' => Db::tx(fn() => self::clearNotation($pid, ($opt['mode'] ?? 'proposals') === 'all')),
            'reset_facts' => Db::tx(fn() => self::resetFacts($pid, !empty($opt['notation']))) + (empty($opt['requeue']) ? [] : ['queued' => self::queueExtraction($pid, true)]),
        };
        return ['changes' => $changes, 'backup' => $file];
    }

    private static function resetFacts(int $pid, bool $notation): array
    {
        $ids = array_map('intval', array_column(Db::all('SELECT id FROM facts WHERE project_id = ?', [$pid]), 'id'));
        $out = ['facts' => count($ids), 'comments' => 0, 'tasks' => 0, 'notation' => 0];
        $comments = array_map('intval', array_column(Db::all("SELECT id FROM comments WHERE project_id = ? AND target_type = 'fact'", [$pid]), 'id'));
        if ($comments) {
            [$in, $p] = Db::in($comments);
            Db::run("DELETE FROM mentions WHERE source_type = 'comment' AND source_id IN $in", $p);
            $out['comments'] = Db::run("DELETE FROM comments WHERE id IN $in", $p)->rowCount();
        }
        Db::run("DELETE FROM mentions WHERE project_id = ? AND (mentioned_type IN ('fact', 'review', 'proof', 'lean') OR source_type IN ('fact', 'fact_review', 'fact_proof'))", [$pid]);
        Db::run("DELETE FROM question_links WHERE project_id = ? AND target_type = 'fact'", [$pid]);
        Db::run("DELETE FROM activity WHERE project_id = ? AND item_type = 'fact'", [$pid]);
        $out['tasks'] = Db::run('DELETE FROM ai_tasks WHERE project_id = ? AND ' . self::FACT_TASKS, [$pid])->rowCount();
        Db::run('UPDATE notations SET definition_fact_id = NULL WHERE project_id = ?', [$pid]);
        if ($notation) {
            Db::run("DELETE FROM comments WHERE project_id = ? AND target_type = 'notation'", [$pid]);
            $out['notation'] = Db::run('DELETE FROM notations WHERE project_id = ?', [$pid])->rowCount();
        }
        // Revisions, sources, dependencies, reviews, other proofs, Lean proofs, rewrites and the answers they back go with their fact.
        $out['suggestions'] = Db::run('DELETE FROM fact_suggestions WHERE project_id = ?', [$pid])->rowCount();
        Db::run('DELETE FROM notation_classes WHERE project_id = ?', [$pid]); // the groups of the facts' wordings go with them
        Db::run('DELETE FROM facts WHERE project_id = ?', [$pid]);
        return $out;
    }

    private static function clearNotation(int $pid, bool $all): array
    {
        if (!$all) {
            Db::run("DELETE FROM comments WHERE project_id = ? AND target_type = 'notation' AND target_id IN (SELECT id FROM notations WHERE project_id = ? AND status <> 'agreed')", [$pid, $pid]);
            return ['entries' => Db::run("DELETE FROM notations WHERE project_id = ? AND status <> 'agreed'", [$pid])->rowCount(), 'rephrasings' => 0];
        }
        Db::run("DELETE FROM comments WHERE project_id = ? AND target_type = 'notation'", [$pid]);
        Db::run('DELETE FROM notation_classes WHERE project_id = ?', [$pid]);
        $r = Db::run('DELETE FROM fact_rephrasings WHERE fact_id IN (SELECT id FROM facts WHERE project_id = ?)', [$pid])->rowCount();
        Db::run("DELETE FROM ai_tasks WHERE project_id = ? AND kind = 'notation'", [$pid]);
        return ['entries' => Db::run('DELETE FROM notations WHERE project_id = ?', [$pid])->rowCount(), 'rephrasings' => $r];
    }

    /** Files and reference PDFs whose current content has no extraction waiting or finished. */
    private static function toExtract(int $pid): array
    {
        $files = 0; $pdfs = 0;
        foreach (Db::all('SELECT d.current_version_id FROM documents d WHERE d.project_id = ? AND d.deleted_at IS NULL AND d.current_version_id IS NOT NULL', [$pid]) as $d) {
            if (!Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'document' AND version_id = ? AND status IN ('pending', 'running', 'done')", [$pid, $d['current_version_id']])) $files++;
        }
        foreach (Db::all('SELECT id, pdf_blob_id FROM bib_entries WHERE project_id = ? AND pdf_blob_id IS NOT NULL', [$pid]) as $b) {
            if (!Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'bib' AND source_id = ? AND source_blob_id = ? AND status IN ('pending', 'running', 'done')", [$pid, $b['id'], $b['pdf_blob_id']])) $pdfs++;
        }
        return ['files' => $files, 'reference_pdfs' => $pdfs];
    }

    private static function everythingToExtract(int $pid): int
    {
        return (int)Db::value('SELECT COUNT(*) FROM documents WHERE project_id = ? AND deleted_at IS NULL AND current_version_id IS NOT NULL', [$pid])
            + (int)Db::value('SELECT COUNT(*) FROM bib_entries WHERE project_id = ? AND pdf_blob_id IS NOT NULL', [$pid]);
    }

    /** Queues an extraction for each file and reference PDF that has none waiting or finished. */
    private static function queueExtraction(int $pid, bool $all): int
    {
        $queued = 0;
        foreach (Db::all('SELECT id, current_version_id FROM documents WHERE project_id = ? AND deleted_at IS NULL AND current_version_id IS NOT NULL', [$pid]) as $d) {
            if (!$all && Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'document' AND version_id = ? AND status IN ('pending', 'running', 'done')", [$pid, $d['current_version_id']])) continue;
            if (AiTaskController::queueExtraction($pid, 'document', (int)$d['id'], (int)$d['current_version_id'], null)) $queued++;
        }
        foreach (Db::all('SELECT id, pdf_blob_id FROM bib_entries WHERE project_id = ? AND pdf_blob_id IS NOT NULL', [$pid]) as $b) {
            if (!$all && Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'bib' AND source_id = ? AND source_blob_id = ? AND status IN ('pending', 'running', 'done')", [$pid, $b['id'], $b['pdf_blob_id']])) continue;
            if (AiTaskController::queueExtraction($pid, 'bib', (int)$b['id'], null, (int)$b['pdf_blob_id'])) $queued++;
        }
        return $queued;
    }
}
