<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * The project's notation. Papers use the same symbols for different things, e.g. FS(X) with or without 0.
 * Members agree on one meaning per symbol, and AI clients write each fact again in that notation.
 * The reviewed text of a fact never changes: its rephrasing is shown beside it, and a person can check it.
 */
final class NotationController
{
    private const STATUSES = ['proposed', 'agreed', 'rejected'];
    private const MAX_VARIANTS = 20;

    public static function list(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        Response::json(['entries' => self::entries($pid), 'definitions' => self::definitions($pid), 'progress' => self::progress($pid), 'hash' => self::hash($pid)]);
    }

    /** People and AI clients propose an entry. Only a person agrees on it. */
    public static function create(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $data = self::fields($r, $pid, null);
        $model = Provenance::agentModel($r);
        $same = Db::one("SELECT * FROM notations WHERE project_id = ? AND symbol_key = ? AND status <> 'rejected' ORDER BY status = 'agreed' DESC, id LIMIT 1", [$pid, $data['symbol_key']]);
        if ($same && Auth::isAi()) {
            // An AI met a symbol the project already has: if a source gives it another meaning, that is a clash to record, not a new entry.
            $meaning = Sanitizer::toText((string)$data['meaning_html']);
            if (self::sameText($meaning, Sanitizer::toText((string)$same['meaning_html']))) throw new HttpError(409, 'This symbol already has this meaning.');
            $variants = json_decode((string)$same['variants_json'], true) ?: [];
            foreach ($variants as $v) if (self::sameText((string)$v['meaning'], $meaning)) throw new HttpError(409, 'This meaning is already recorded for this symbol.');
            if (count($variants) >= self::MAX_VARIANTS) throw new HttpError(409, 'This symbol already lists many meanings.');
            $variants[] = ['symbol' => $data['symbol'], 'meaning' => mb_substr($meaning, 0, 1000), 'where' => mb_substr(trim($r->str('where')) ?: 'found by ' . ($model ?: 'an AI client'), 0, 300)];
            Db::update('notations', ['variants_json' => json_encode($variants, JSON_UNESCAPED_UNICODE), 'updated_at' => Db::now()], 'id = :id', ['id' => $same['id']]);
            Response::json(self::one((int)$same['id']) + ['merged' => true]);
        }
        $now = Db::now();
        $id = Db::insert('notations', $data + Provenance::stamp($model, $r->input('generation_seconds')) + [
            'project_id' => $pid, 'status' => 'proposed', 'author_id' => Auth::id(), 'author_kind' => Auth::isAi() ? 'agent' : 'human',
            'ai_model' => $model, 'created_at' => $now, 'updated_at' => $now,
        ]);
        Response::json(self::one($id), 201);
    }

    /** A member edits an entry. Changing an agreed entry makes it proposed again. */
    public static function update(Request $r): never
    {
        self::humanOnly();
        $n = self::row($r->int('nid'));
        $data = self::fields($r, (int)$n['project_id'], $n);
        $reset = $n['status'] === 'agreed' && ($data['symbol_key'] !== $n['symbol_key'] || $data['meaning_html'] !== $n['meaning_html']);
        Db::update('notations', $data + ['updated_at' => Db::now()] + ($reset ? ['status' => 'proposed', 'decided_by' => null, 'decided_at' => null] : []), 'id = :id', ['id' => $n['id']]);
        Response::json(self::one((int)$n['id']));
    }

    /** A person agrees on an entry, or rejects it. One agreed meaning per symbol. */
    public static function decide(Request $r): never
    {
        self::humanOnly();
        $n = self::row($r->int('nid'));
        $status = $r->str('status');
        if (!in_array($status, self::STATUSES, true)) throw new HttpError(422, 'The status must be proposed, agreed or rejected.');
        if ($status === 'agreed' && Db::value("SELECT 1 FROM notations WHERE project_id = ? AND symbol_key = ? AND status = 'agreed' AND id <> ?", [$n['project_id'], $n['symbol_key'], $n['id']])) {
            throw new HttpError(409, 'This symbol already has an agreed meaning. Change or reject that entry first.');
        }
        Db::update('notations', ['status' => $status, 'decided_by' => $status === 'proposed' ? null : Auth::id(), 'decided_at' => $status === 'proposed' ? null : Db::now(), 'updated_at' => Db::now()], 'id = :id', ['id' => $n['id']]);
        if ($n['author_kind'] === 'human' && (int)$n['author_id'] !== Auth::id() && Access::isMember((int)$n['project_id'], (int)$n['author_id'])) {
            Notify::send((int)$n['author_id'], (int)$n['project_id'], 'notation', ['link' => ['view' => 'facts', 'query' => ['mode' => 'notation', 'notation' => (int)$n['id']]], 'excerpt' => $n['symbol'] . ': ' . $status]);
        }
        Response::json(self::one((int)$n['id']));
    }

    public static function delete(Request $r): never
    {
        self::humanOnly();
        $n = self::row($r->int('nid'));
        if ((int)$n['author_id'] !== Auth::id()) Access::owner((int)$n['project_id']);
        if ($n['status'] === 'agreed') throw new HttpError(409, 'An agreed entry cannot be deleted. Reject it first.');
        Db::run('DELETE FROM notations WHERE id = ?', [$n['id']]);
        Response::json(['ok' => true]);
    }

    /** An AI client writes a fact again in the agreed notation. */
    public static function rephrase(Request $r): never
    {
        if (!Auth::isAi()) throw new HttpError(403, 'This is for AI clients.');
        $f = Access::fact($r->int('id'));
        $pid = (int)$f['project_id'];
        $unchanged = (bool)$r->input('unchanged');
        $rev = Db::one('SELECT statement_html, proof_html FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f['id'], $f['current_revision']]);
        $statement = $unchanged ? ['html' => (string)$rev['statement_html']] : Sanitizer::clean(Sanitizer::textToHtml((string)$r->input('statement_text', ''), $pid));
        if (trim(strip_tags($statement['html'])) === '') throw new HttpError(422, 'statement_text is required, or unchanged: true.');
        $proofText = trim((string)$r->input('proof_text', ''));
        $proof = $unchanged ? ($rev['proof_html'] ?: null) : ($proofText !== '' ? Sanitizer::clean(Sanitizer::textToHtml($proofText, $pid))['html'] : null);
        if (!$unchanged && $rev['proof_html'] && $proof === null) throw new HttpError(422, 'The fact has a proof: send proof_text too.');
        $uses = self::uses($r->input('uses', []));
        $model = Provenance::agentModel($r);
        $id = Db::insert('fact_rephrasings', Provenance::stamp($model, $r->input('generation_seconds')) + [
            'fact_id' => $f['id'], 'revision_no' => $f['current_revision'], 'notation_hash' => self::hash($pid), 'unchanged' => $unchanged ? 1 : 0,
            'statement_html' => $statement['html'], 'proof_html' => $proof, 'uses_json' => $uses ? json_encode($uses, JSON_UNESCAPED_UNICODE) : null,
            'author_id' => Auth::id(), 'ai_model' => $model, 'created_at' => Db::now(),
        ]);
        Activity::touch($pid, 'fact', (int)$f['id'], 'rephrased', $id);
        Response::json(FactController::present(Access::fact((int)$f['id'])), 201);
    }

    /** A person says whether a rephrasing says exactly what the original says. */
    public static function check(Request $r): never
    {
        self::humanOnly();
        $x = Db::one('SELECT * FROM fact_rephrasings WHERE id = ?', [$r->int('rid')]);
        if (!$x) throw new HttpError(404, 'Rephrasing not found');
        $f = Access::fact((int)$x['fact_id']);
        $verdict = $r->str('verdict');
        if (!in_array($verdict, ['faithful', 'unfaithful', ''], true)) throw new HttpError(422, 'The verdict must be faithful or unfaithful.');
        $note = mb_substr(trim($r->str('note')), 0, 2000);
        if ($verdict === 'unfaithful' && $note === '') throw new HttpError(422, 'Say what changed in the meaning.');
        Db::update('fact_rephrasings', ['check_verdict' => $verdict ?: null, 'check_note' => $note ?: null, 'checked_by' => $verdict ? Auth::id() : null, 'checked_at' => $verdict ? Db::now() : null], 'id = :id', ['id' => $x['id']]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'rephrasing_check', (int)$x['id']);
        Response::json(FactController::present($f));
    }

    /** Queues a rephrasing for every fact not yet written in the current agreed notation. */
    public static function rephraseAll(Request $r): never
    {
        self::humanOnly();
        $pid = $r->int('id');
        Access::member($pid);
        $hash = self::hash($pid);
        if ($hash === self::EMPTY) throw new HttpError(422, 'Agree on at least one notation entry first.');
        $queued = 0;
        foreach (self::states($pid) as $fid => $s) {
            if (!in_array($s['state'], ['none', 'stale', 'unfaithful'], true) || $s['queued']) continue;
            AiTaskController::queueNotation($pid, (int)$fid, (int)$s['revision'], $hash);
            $queued++;
        }
        Response::json(['queued' => $queued, 'progress' => self::progress($pid)], 201);
    }

    // ----- shared with facts and the AI queue -----

    private const EMPTY = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

    /** Changes whenever the agreed notation changes: a rephrasing that followed another one is out of date. */
    public static function hash(int $pid): string
    {
        $rows = Db::all("SELECT id, symbol_key, meaning_html FROM notations WHERE project_id = ? AND status = 'agreed' ORDER BY id", [$pid]);
        return $rows ? sha1(json_encode(array_map(fn($n) => [(int)$n['id'], $n['symbol_key'], $n['meaning_html']], $rows))) : self::EMPTY;
    }

    /** The entries for an AI client: agreed ones are binding, proposed ones are suggestions. */
    public static function forTask(int $pid, bool $agreedOnly): array
    {
        return array_map(fn($n) => ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning' => Sanitizer::toText((string)$n['meaning_html']), 'status' => $n['status'],
            'note' => $n['note_html'] ? Sanitizer::toText((string)$n['note_html']) : null, 'variants' => json_decode((string)$n['variants_json'], true) ?: []],
            Db::all("SELECT * FROM notations WHERE project_id = ? AND status " . ($agreedOnly ? "= 'agreed'" : "<> 'rejected'") . ' ORDER BY symbol_key LIMIT 300', [$pid]));
    }

    /** Where each fact's current revision stands. */
    public static function states(int $pid): array
    {
        $hash = self::hash($pid);
        $out = [];
        foreach (Db::all('SELECT id, current_revision FROM facts WHERE project_id = ? AND deleted_at IS NULL AND retracted_at IS NULL', [$pid]) as $f) {
            $out[(int)$f['id']] = ['revision' => (int)$f['current_revision'], 'state' => 'none', 'queued' => false];
        }
        foreach (Db::all('SELECT x.fact_id, x.notation_hash, x.check_verdict, x.unchanged FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id AND x.revision_no = f.current_revision
                          WHERE f.project_id = ? ORDER BY x.id', [$pid]) as $x) {
            if (!isset($out[(int)$x['fact_id']])) continue;
            $out[(int)$x['fact_id']]['state'] = $x['notation_hash'] !== $hash ? 'stale' : ($x['check_verdict'] === 'unfaithful' ? 'unfaithful' : ($x['unchanged'] ? 'unchanged' : 'current'));
        }
        foreach (Db::all("SELECT source_id FROM ai_tasks WHERE project_id = ? AND kind = 'notation' AND source_type = 'fact' AND status IN ('pending', 'running')", [$pid]) as $t) {
            if (isset($out[(int)$t['source_id']])) $out[(int)$t['source_id']]['queued'] = true;
        }
        return $out;
    }

    public static function progress(int $pid): array
    {
        $p = ['facts' => 0, 'current' => 0, 'unchanged' => 0, 'stale' => 0, 'unfaithful' => 0, 'none' => 0, 'queued' => 0, 'agreed' => 0, 'proposed' => 0];
        foreach (self::states($pid) as $s) { $p['facts']++; $p[$s['state']]++; if ($s['queued']) $p['queued']++; }
        foreach (Db::all('SELECT status, COUNT(*) AS n FROM notations WHERE project_id = ? GROUP BY status', [$pid]) as $c) if (isset($p[$c['status']])) $p[$c['status']] = (int)$c['n'];
        return $p;
    }

    /** The rephrasings of a fact, newest first, with their state. */
    public static function forFact(int $factId, int $pid, int $revision): array
    {
        $hash = self::hash($pid);
        return array_map(function ($x) use ($hash, $revision) {
            foreach (['id', 'fact_id', 'revision_no', 'author_id', 'checked_by', 'ai_generation_ms'] as $k) $x[$k] = $x[$k] === null ? null : (int)$x[$k];
            $x['unchanged'] = (bool)$x['unchanged'];
            $x['uses'] = json_decode((string)$x['uses_json'], true) ?: [];
            unset($x['uses_json']);
            $x['current'] = $x['revision_no'] === $revision && $x['notation_hash'] === $hash;
            return $x;
        }, Db::all('SELECT x.*, u.name AS checked_by_name, au.name AS ai_user_name FROM fact_rephrasings x LEFT JOIN users u ON u.id = x.checked_by LEFT JOIN users au ON au.id = x.ai_user_id
                    WHERE x.fact_id = ? ORDER BY x.id DESC LIMIT 20', [$factId]));
    }

    // ----- helpers -----

    private static function fields(Request $r, int $pid, ?array $old): array
    {
        $symbol = trim(preg_replace('/^\$+|\$+$/', '', $r->has('symbol') ? $r->str('symbol') : (string)($old['symbol'] ?? '')) ?? '');
        if ($symbol === '' || mb_strlen($symbol) > 160) throw new HttpError(422, 'Give the symbol, at most 160 characters, for example \\mathrm{FS}(X).');
        $meaning = $r->has('meaning_text') ? trim((string)$r->input('meaning_text')) : null;
        if ($meaning === null && !$old) throw new HttpError(422, 'Say what the symbol means.');
        if ($meaning !== null && ($meaning === '' || mb_strlen($meaning) > 4000)) throw new HttpError(422, 'Say what the symbol means, in at most 4000 characters.');
        $note = $r->has('note_text') ? trim((string)$r->input('note_text')) : null;
        $fact = $r->has('definition_fact_id') ? ((int)$r->input('definition_fact_id') ?: null) : ($old['definition_fact_id'] ?? null);
        if ($fact && (int)Db::value('SELECT project_id FROM facts WHERE id = ? AND deleted_at IS NULL', [$fact]) !== $pid) throw new HttpError(422, 'The definition must be a fact of this project.');
        $variants = $r->has('variants') ? self::variants($r->input('variants')) : null;
        return array_filter([
            'symbol' => $symbol, 'symbol_key' => self::key($symbol),
            'meaning_html' => $meaning !== null ? Sanitizer::clean(Sanitizer::textToHtml($meaning, $pid))['html'] : null,
            'note_html' => $note !== null ? ($note === '' ? '' : Sanitizer::clean(Sanitizer::textToHtml($note, $pid))['html']) : null,
            'variants_json' => $variants !== null ? ($variants ? json_encode($variants, JSON_UNESCAPED_UNICODE) : '') : null,
            'definition_fact_id' => $fact,
        ], fn($v) => $v !== null) + ($r->has('definition_fact_id') ? ['definition_fact_id' => $fact] : []);
    }

    private static function sameText(string $a, string $b): bool
    {
        $n = fn($t) => mb_strtolower(preg_replace('/[\s.]+/u', '', $t) ?? '');
        return $n($a) === $n($b);
    }

    /** The definitions of the facts database: conventions, shown with the notation rather than among the results. */
    private static function definitions(int $pid): array
    {
        $linked = [];
        foreach (Db::all("SELECT id, symbol, status, definition_fact_id FROM notations WHERE project_id = ? AND definition_fact_id IS NOT NULL AND status <> 'rejected'", [$pid]) as $n) {
            $linked[(int)$n['definition_fact_id']] = ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'status' => $n['status']];
        }
        $out = [];
        foreach (FactController::graph($pid)['facts'] as $f) {
            if ($f['status'] !== 'definition') continue;
            $out[] = ['id' => $f['id'], 'label' => $f['label'], 'title' => $f['title'], 'statement_text' => mb_substr((string)$f['statement_text'], 0, 2000), 'used_by' => count($f['dependents']), 'entry' => $linked[$f['id']] ?? null];
        }
        return $out;
    }

    public static function key(string $symbol): string
    {
        return mb_strtolower(preg_replace('/\s+/u', '', $symbol) ?? '');
    }

    private static function variants(mixed $list): array
    {
        if (!is_array($list) || !array_is_list($list) || count($list) > self::MAX_VARIANTS) throw new HttpError(422, 'variants must be a list of at most ' . self::MAX_VARIANTS . ' items.');
        $s = fn($x, $k, $max) => mb_substr(trim(is_array($x) && is_scalar($x[$k] ?? null) ? (string)$x[$k] : ''), 0, $max);
        return array_values(array_filter(array_map(fn($x) => ['symbol' => $s($x, 'symbol', 160), 'meaning' => $s($x, 'meaning', 1000), 'where' => $s($x, 'where', 300)], $list), fn($v) => $v['symbol'] !== '' && $v['meaning'] !== ''));
    }

    private static function uses(mixed $list): array
    {
        if (!is_array($list) || !array_is_list($list)) return [];
        $s = fn($x, $k, $max) => mb_substr(trim(is_array($x) && is_scalar($x[$k] ?? null) ? (string)$x[$k] : ''), 0, $max);
        return array_slice(array_values(array_filter(array_map(fn($x) => ['symbol' => $s($x, 'symbol', 160), 'meaning_here' => $s($x, 'meaning_here', 1000), 'project_symbol' => $s($x, 'project_symbol', 160)], $list), fn($v) => $v['symbol'] !== '')), 0, 40);
    }

    private static function entries(int $pid): array
    {
        return array_map([self::class, 'present'], Db::all(self::sql() . ' WHERE n.project_id = ? ORDER BY CASE n.status WHEN \'agreed\' THEN 0 WHEN \'proposed\' THEN 1 ELSE 2 END, n.symbol_key', [$pid]));
    }

    private static function one(int $id): array
    {
        return self::present(Db::one(self::sql() . ' WHERE n.id = ?', [$id]));
    }

    private static function sql(): string
    {
        return 'SELECT n.*, u.name AS author_name, d.name AS decided_by_name, au.name AS ai_user_name, f.label AS definition_label FROM notations n JOIN users u ON u.id = n.author_id
                LEFT JOIN users d ON d.id = n.decided_by LEFT JOIN users au ON au.id = n.ai_user_id LEFT JOIN facts f ON f.id = n.definition_fact_id AND f.deleted_at IS NULL';
    }

    private static function present(array $n): array
    {
        foreach (['id', 'project_id', 'author_id', 'decided_by', 'definition_fact_id', 'ai_user_id', 'ai_generation_ms'] as $k) $n[$k] = $n[$k] === null ? null : (int)$n[$k];
        $n['variants'] = json_decode((string)$n['variants_json'], true) ?: [];
        $n['meaning_text'] = Sanitizer::toText((string)$n['meaning_html']);
        $n['note_text'] = $n['note_html'] ? Sanitizer::toText((string)$n['note_html']) : '';
        unset($n['variants_json']);
        return $n;
    }

    private static function row(int $id): array
    {
        $n = Db::one('SELECT * FROM notations WHERE id = ?', [$id]);
        if (!$n) throw new HttpError(404, 'Notation entry not found');
        Access::member((int)$n['project_id']);
        return $n;
    }

    private static function humanOnly(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
    }
}
