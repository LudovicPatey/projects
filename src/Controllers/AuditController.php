<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Db, HttpError, Request, Response};

/**
 * Read-only access to one project's facts for an auditor, with an audit key that an owner creates on the Admin page.
 * The key expires, can be revoked, signs nobody in, and works only on the routes below. Private conversations stay
 * hidden as for a member outside them, and no email or ORCID iD is included.
 */
final class AuditController
{
    private const DAYS = [1, 7, 30];
    private const PAGE = 200;

    // ----- for owners -----

    public static function keys(Request $r): never
    {
        $pid = self::owner($r);
        Response::json(['keys' => self::list($pid)]);
    }

    public static function create(Request $r): never
    {
        $pid = self::owner($r);
        $label = mb_substr(trim($r->str('label')), 0, 120) ?: 'Audit';
        $days = (int)$r->input('days', 7);
        if (!in_array($days, self::DAYS, true)) throw new HttpError(422, 'An audit key lasts 1, 7 or 30 days.');
        if ((int)Db::value('SELECT COUNT(*) FROM audit_keys WHERE project_id = ? AND revoked_at IS NULL AND expires_at > ?', [$pid, Db::now()]) >= 5) {
            throw new HttpError(422, 'This project already has 5 active audit keys. Revoke one first.');
        }
        $token = 'oqa_' . bin2hex(random_bytes(24));
        Db::insert('audit_keys', ['project_id' => $pid, 'label' => $label, 'token_hash' => hash('sha256', $token), 'token_prefix' => substr($token, 0, 12),
            'created_by' => Auth::id(), 'created_at' => Db::now(), 'expires_at' => gmdate('Y-m-d H:i:s', time() + $days * 86400)]);
        // The token is shown once: only its hash is kept.
        Response::json(['token' => $token, 'keys' => self::list($pid)], 201);
    }

    public static function revoke(Request $r): never
    {
        $pid = self::owner($r);
        Db::run('UPDATE audit_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL', [Db::now(), $r->int('kid'), $pid]);
        Response::json(['keys' => self::list($pid)]);
    }

    // ----- for auditors, with the key -----

    /** The project, what it holds, and the routes of the audit. */
    public static function project(Request $r): never
    {
        $pid = self::key();
        $p = Db::one('SELECT id, title, question_html, status, created_at, updated_at FROM projects WHERE id = ?', [$pid]);
        Response::json(['project' => ['id' => (int)$p['id'], 'title' => $p['title'], 'question' => \App\Sanitizer::toText((string)$p['question_html']), 'status' => $p['status']],
            'summary' => \App\ProjectAdmin::summary($pid), 'page_size' => self::PAGE,
            'routes' => ['GET /api/audit/project', 'GET /api/audit/graph', 'GET /api/audit/facts?offset=0', 'GET /api/audit/notation']]);
    }

    /** Every fact, briefly, with the dependencies: the shape of the database. */
    public static function graph(Request $r): never
    {
        $pid = self::key();
        $g = FactController::graph($pid);
        $keep = ['id', 'label', 'title', 'kind', 'display_kind', 'status', 'chain', 'origin', 'proof_origin', 'method', 'tool', 'lean', 'labels', 'ai_model', 'stars', 'proof_count', 'retracted_at', 'updated_at'];
        Response::json(['facts' => array_map(fn($f) => array_intersect_key($f, array_flip($keep)), $g['facts']), 'edges' => $g['edges']]);
    }

    /** Full facts, a page at a time: statement, proof, sources, reviews, other proofs, Lean, rewrites. */
    public static function facts(Request $r): never
    {
        $pid = self::key();
        $offset = max(0, (int)($r->query['offset'] ?? 0));
        $ids = array_map('intval', array_column(Db::all('SELECT id FROM facts WHERE project_id = ? AND deleted_at IS NULL ORDER BY id LIMIT ' . self::PAGE . ' OFFSET ' . $offset, [$pid]), 'id'));
        $total = (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$pid]);
        $byId = $ids ? array_column(FactController::graph($pid)['facts'], null, 'id') : [];
        if ($ids) \App\Sweeps::readMany($pid); // read-only: what waits for each AI pass, computed once for the page
        $out = [];
        foreach ($ids as $id) {
            $f = FactController::present(Db::one('SELECT * FROM facts WHERE id = ?', [$id]), $byId);
            unset($f['last_activity_id'], $f['starred']);
            $out[] = $f;
        }
        Response::json(['facts' => $out, 'offset' => $offset, 'total' => $total, 'next' => $offset + count($ids) < $total ? $offset + count($ids) : null]);
    }

    public static function notation(Request $r): never
    {
        $pid = self::key();
        $entries = Db::all("SELECT id, symbol, status, meaning_html, note_html, variants_json, params_json, definition_fact_id, auto_suggestion_id, decided_at FROM notations WHERE project_id = ? ORDER BY symbol_key", [$pid]);
        Response::json(['entries' => array_map(fn($n) => ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'status' => $n['status'], 'meaning' => \App\Sanitizer::toText((string)$n['meaning_html']),
            // Its parameters with their types, as the page draws them, and the letters typed "not a parameter".
            'params' => NotationController::paramsOf($n), 'fixed' => NotationController::fixedOf($n),
            'note' => $n['note_html'] ? \App\Sanitizer::toText((string)$n['note_html']) : null, 'variants' => json_decode((string)$n['variants_json'], true) ?: [],
            'definition_fact_id' => $n['definition_fact_id'] ? (int)$n['definition_fact_id'] : null,
            // Who settled it: nobody yet, the consolidation on its own, or a person.
            'decided_by' => NotationController::decidedBy($n), 'decided_at' => $n['decided_at']], $entries),
            'shared' => NotationController::shared($pid), 'progress' => NotationController::progress($pid)]);
    }

    // ----- helpers -----

    /** The project of a valid audit key, counted as used. */
    private static function key(): int
    {
        $k = Auth::audit();
        if (!$k) throw new HttpError(401, 'A valid audit key is required: Authorization: Bearer oqa_…');
        Db::run('UPDATE audit_keys SET last_used_at = ?, uses = uses + 1 WHERE id = ?', [Db::now(), $k['id']]);
        return (int)$k['project_id'];
    }

    private static function list(int $pid): array
    {
        $now = Db::now();
        return array_map(fn($k) => ['id' => (int)$k['id'], 'label' => $k['label'], 'prefix' => $k['token_prefix'], 'created_by' => $k['created_by_name'], 'created_at' => $k['created_at'],
            'expires_at' => $k['expires_at'], 'revoked_at' => $k['revoked_at'], 'last_used_at' => $k['last_used_at'], 'uses' => (int)$k['uses'],
            'active' => !$k['revoked_at'] && $k['expires_at'] > $now],
            Db::all('SELECT k.*, u.name AS created_by_name FROM audit_keys k JOIN users u ON u.id = k.created_by WHERE k.project_id = ? ORDER BY k.id DESC LIMIT 30', [$pid]));
    }

    private static function owner(Request $r): int
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
        $pid = $r->int('id');
        Access::owner($pid);
        return $pid;
    }
}
