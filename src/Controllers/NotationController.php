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
    /** local: too specific to be a project symbol. A rewrite unfolds it, or defines it within the fact. */
    private const STATUSES = ['proposed', 'agreed', 'local', 'rejected'];
    private const RELATIONS = ['instance', 'clash'];
    private const MAX_VARIANTS = 20;

    public static function list(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        Response::json(['entries' => self::entries($pid), 'definitions' => self::definitions($pid), 'shared' => self::shared($pid), 'progress' => self::progress($pid), 'hash' => self::hash($pid)]);
    }

    /** People and AI clients propose an entry. Only a person agrees on it. */
    public static function create(Request $r): never
    {
        [$out, $status] = self::propose($r);
        Response::json($out, $status);
    }

    /** @return array{0: array, 1: int} the entry and the HTTP status */
    public static function propose(Request $r): array
    {
        $pid = $r->int('id');
        Access::member($pid);
        $data = self::fields($r, $pid, null);
        $model = Provenance::agentModel($r);
        $same = null;
        foreach (Db::all("SELECT * FROM notations WHERE project_id = ? AND status <> 'rejected' ORDER BY status = 'agreed' DESC, id", [$pid]) as $n) {
            if (self::notionKey($n['symbol']) === self::notionKey($data['symbol'])) { $same = $n; break; } // the same notion, perhaps spelled otherwise
        }
        if ($same && Auth::isAi()) {
            // An AI met a symbol the project already has: if a source gives it another meaning, that is a clash to record, not a new entry.
            $meaning = Sanitizer::toText((string)$data['meaning_html']);
            if (self::sameText($meaning, Sanitizer::toText((string)$same['meaning_html']))) {
                // The same entry again, with the types of its parameters that nobody gave: they say what it applies to, and change nothing else.
                if (!empty($data['params_json']) && !self::typed((string)$same['params_json'])) {
                    Db::update('notations', ['params_json' => $data['params_json'], 'updated_at' => Db::now()], 'id = :id', ['id' => $same['id']]);
                    return [self::one((int)$same['id']) + ['merged' => true, 'params_added' => true], 200];
                }
                throw new HttpError(409, 'This symbol already has this meaning.');
            }
            $variants = json_decode((string)$same['variants_json'], true) ?: [];
            foreach ($variants as $v) if (self::sameText((string)$v['meaning'], $meaning)) throw new HttpError(409, 'This meaning is already recorded for this symbol.');
            if (count($variants) >= self::MAX_VARIANTS) throw new HttpError(409, 'This symbol already lists many meanings.');
            $variants[] = ['symbol' => $data['symbol'], 'meaning' => mb_substr($meaning, 0, 1000), 'where' => mb_substr(trim($r->str('where')) ?: 'found by ' . ($model ?: 'an AI client'), 0, 300),
                'relation' => in_array($r->str('relation'), self::RELATIONS, true) ? $r->str('relation') : 'clash'];
            Db::update('notations', ['variants_json' => json_encode($variants, JSON_UNESCAPED_UNICODE), 'updated_at' => Db::now()], 'id = :id', ['id' => $same['id']]);
            return [self::one((int)$same['id']) + ['merged' => true], 200];
        }
        $now = Db::now();
        $id = Db::insert('notations', $data + Provenance::stamp($model, $r->input('generation_seconds')) + [
            'project_id' => $pid, 'status' => 'proposed', 'author_id' => Auth::id(), 'author_kind' => Auth::isAi() ? 'agent' : 'human',
            'ai_model' => $model, 'created_at' => $now, 'updated_at' => $now,
        ]);
        return [self::one($id), 201];
    }

    /** A member edits an entry. Changing an agreed entry makes it proposed again. */
    public static function update(Request $r): never
    {
        self::humanOnly();
        $n = self::row($r->int('nid'));
        $data = self::fields($r, (int)$n['project_id'], $n);
        // What the entry applies to changes with its symbol, its meaning or the types of its parameters.
        $reset = $n['status'] === 'agreed' && ($data['symbol_key'] !== $n['symbol_key'] || (isset($data['meaning_html']) && $data['meaning_html'] !== $n['meaning_html']) || (isset($data['params_json']) && $data['params_json'] !== (string)$n['params_json']));
        Db::update('notations', $data + ['updated_at' => Db::now()] + ($reset ? ['status' => 'proposed', 'decided_by' => null, 'decided_at' => null, 'auto_suggestion_id' => null] : []), 'id = :id', ['id' => $n['id']]);
        Response::json(self::one((int)$n['id']));
    }

    /** A person agrees on an entry, or rejects it. One agreed meaning per symbol. */
    public static function decide(Request $r): never
    {
        self::humanOnly();
        $n = self::row($r->int('nid'));
        $status = $r->str('status');
        if (!in_array($status, self::STATUSES, true)) throw new HttpError(422, 'The status must be proposed, agreed, local or rejected.');
        if ($status === 'agreed' && Db::value("SELECT 1 FROM notations WHERE project_id = ? AND symbol_key = ? AND status = 'agreed' AND id <> ?", [$n['project_id'], $n['symbol_key'], $n['id']])) {
            throw new HttpError(409, 'This symbol already has an agreed meaning. Change or reject that entry first.');
        }
        // A person's decision: the consolidation no longer changes it.
        Db::update('notations', ['status' => $status, 'decided_by' => $status === 'proposed' ? null : Auth::id(), 'decided_at' => $status === 'proposed' ? null : Db::now(), 'auto_suggestion_id' => null, 'updated_at' => Db::now()], 'id = :id', ['id' => $n['id']]);
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
        Db::run("DELETE FROM comments WHERE target_type = 'notation' AND target_id = ?", [$n['id']]);
        Db::run('DELETE FROM notations WHERE id = ?', [$n['id']]);
        Response::json(['ok' => true]);
    }

    /** An AI client writes a fact again in the agreed notation. */
    public static function rephrase(Request $r): never
    {
        $fid = self::rephraseFact($r);
        Response::json(FactController::present(Access::fact($fid)), 201);
    }

    /** Records the rewrite of a fact. Returns the fact's id. */
    public static function rephraseFact(Request $r): int
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
        $local = self::localNotation($r->input('local_notation', []));
        $model = Provenance::agentModel($r);
        $id = Db::insert('fact_rephrasings', Provenance::stamp($model, $r->input('generation_seconds')) + [
            'fact_id' => $f['id'], 'revision_no' => $f['current_revision'], 'notation_hash' => self::hash($pid), 'unchanged' => $unchanged ? 1 : 0,
            'statement_html' => $statement['html'], 'proof_html' => $proof, 'uses_json' => $uses ? json_encode($uses, JSON_UNESCAPED_UNICODE) : null, 'local_json' => $local ? json_encode($local, JSON_UNESCAPED_UNICODE) : null,
            'author_id' => Auth::id(), 'ai_model' => $model, 'created_at' => Db::now(),
        ]);
        Activity::touch($pid, 'fact', (int)$f['id'], 'rephrased', $id);
        return (int)$f['id'];
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
        // A person's verdict replaces an AI's.
        Db::update('fact_rephrasings', ['check_verdict' => $verdict ?: null, 'check_note' => $note ?: null, 'checked_by' => $verdict ? Auth::id() : null, 'checked_at' => $verdict ? Db::now() : null,
            'check_ai_model' => null, 'check_ai_user_id' => null, 'check_ai_generation_ms' => null], 'id = :id', ['id' => $x['id']]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'rephrasing_check', (int)$x['id']);
        Response::json(FactController::present($f));
    }

    /**
     * An AI's verdict on a rewrite, from the rewrite_check sweep. Only on a rewrite nobody checked yet: it never replaces a person's.
     * An unfaithful rewrite is no longer shown, and the next rewrite sweep may write the fact again. @return bool recorded
     */
    public static function aiCheck(int $rid, string $verdict, string $note, ?string $model, mixed $seconds): bool
    {
        if (!in_array($verdict, ['faithful', 'unfaithful'], true)) return false;
        $note = mb_substr(trim($note), 0, 2000);
        if ($verdict === 'unfaithful' && $note === '') $note = 'The rewrite does not state exactly what the original states.';
        $stamp = Provenance::stamp($model, $seconds);
        $n = Db::run('UPDATE fact_rephrasings SET check_verdict = ?, check_note = ?, checked_by = NULL, checked_at = ?, check_ai_model = ?, check_ai_user_id = ?, check_ai_generation_ms = ?
                      WHERE id = ? AND check_verdict IS NULL', [$verdict, $note ?: null, Db::now(), $model, $stamp['ai_user_id'], $stamp['ai_generation_ms'], $rid])->rowCount();
        if (!$n) return false;
        $x = Db::one('SELECT x.id, x.fact_id, f.project_id FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id WHERE x.id = ?', [$rid]);
        Activity::touch((int)$x['project_id'], 'fact', (int)$x['fact_id'], 'rephrasing_check', $rid);
        return true;
    }

    /** Queues a rephrasing for every fact not yet written in the current agreed notation. */
    public static function rephraseAll(Request $r): never
    {
        self::humanOnly();
        $pid = $r->int('id');
        Access::member($pid);
        if (self::hash($pid) === self::EMPTY) throw new HttpError(422, 'Agree on at least one notation entry, or mark one as local, first.');
        // One sweep rewrites them, a batch at a time, starting now rather than when the project is quiet.
        $queued = count(\App\Sweeps::rewriteCandidates($pid));
        if ($queued) AiTaskController::queueSweep($pid, 'rewrite', true);
        Response::json(['queued' => $queued, 'progress' => self::progress($pid)], 201);
    }

    // ----- shared with facts and the AI queue -----

    private const EMPTY = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';

    /** Changes whenever the agreed notation changes: a rephrasing that followed another one is out of date. */
    public static function hash(int $pid): string
    {
        // Local entries count too: a rewrite unfolds them.
        $rows = Db::all("SELECT id, symbol_key, meaning_html, status FROM notations WHERE project_id = ? AND status IN ('agreed', 'local') ORDER BY id", [$pid]);
        return $rows ? sha1(json_encode(array_map(fn($n) => [(int)$n['id'], $n['symbol_key'], $n['meaning_html'], $n['status'] === 'local' ? 'local' : ''], $rows))) : self::EMPTY;
    }

    /** The entries for an AI client: agreed ones are binding, proposed ones are suggestions. */
    public static function forTask(int $pid, bool $agreedOnly, bool $withLocal = true): array
    {
        // The members' discussion of each entry, so that an AI proposing or rewriting takes it into account.
        $talk = [];
        foreach (Db::all("SELECT c.target_id, c.body_html, c.resolved, u.name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.project_id = ? AND c.target_type = 'notation' ORDER BY c.id", [$pid]) as $c) {
            $talk[(int)$c['target_id']][] = ['author' => $c['name'], 'resolved' => (bool)$c['resolved'], 'text' => mb_substr(Sanitizer::toText((string)$c['body_html']), 0, 2000)];
        }
        return array_map(fn($n) => ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning' => Sanitizer::toText((string)$n['meaning_html']), 'status' => $n['status'],
            'decided_by' => self::decidedBy($n), 'params' => self::paramsOf($n),
            'note' => $n['note_html'] ? Sanitizer::toText((string)$n['note_html']) : null, 'variants' => json_decode((string)$n['variants_json'], true) ?: [],
            'comments' => array_slice($talk[(int)$n['id']] ?? [], -20)],
            Db::all("SELECT * FROM notations WHERE project_id = ? AND status " . ($agreedOnly ? ($withLocal ? "IN ('agreed', 'local')" : "= 'agreed'") : "<> 'rejected'") . ' ORDER BY symbol_key LIMIT 300', [$pid]));
    }

    /**
     * Whether a symbol is only an expression in the project's agreed symbols and ordinary mathematics, such as
     * \\mathrm{FIN}\\cup\\{\\emptyset\\} once \\mathrm{FIN} is agreed: it needs no entry of its own, and is written that way.
     * @param list<string> $agreed the agreed symbols
     */
    public static function derived(string $symbol, array $agreed): bool
    {
        $s = self::bare($symbol);
        $used = false;
        foreach ($agreed as $a) {
            $head = trim(preg_replace('/\s*\(.*$/s', '', self::bare($a)) ?? '');
            if ($head === '' || $head === $s) continue;
            $name = preg_match('/^\\\\(?:mathrm|mathsf|mathbf|mathit|mathcal|operatorname|textrm|text)\s*\{([^{}]+)\}$/', $head, $m) ? $m[1] : $head;
            if (mb_strlen($name) < 2) continue; // a one-letter symbol is too common to recognize
            // In its font or bare (FIN), but never with an index or exponent of its own: FIN_k and FIN^{[n]} are other notions.
            $bare = preg_match('/^[A-Za-z]{2,}$/', $name) ? '|(?<![\\\\A-Za-z])' . preg_quote($name, '/') : '';
            $pattern = '/(?:\\\\(?:mathrm|mathsf|mathbf|mathit|mathcal|operatorname|textrm|text)\s*\{\s*' . preg_quote($name, '/') . '\s*\}|' . preg_quote($head, '/') . $bare . ')(?![A-Za-z])(?!\s*[_^])/u';
            $s2 = preg_replace($pattern, ' ', $s) ?? $s;
            if ($s2 !== $s) { $used = true; $s = $s2; }
        }
        if (!$used) return false;
        // What is left is ordinary mathematics: operators, brackets, the empty set, numbers, single letters, and no index.
        if (preg_match('/[_^]/', $s)) return false;
        $rest = preg_replace('/\\\\(?:cup|cap|setminus|emptyset|varnothing|times|cdot|circ|le|leq|ge|geq|lt|gt|in|notin|subseteq|subset|supseteq|supset|bigcup|bigcap|infty|omega|mathbb\s*\{\s*[A-Z]\s*\}|left|right|[{},;!]|quad|,)/u', ' ', $s) ?? $s;
        $rest = preg_replace('/[\s(){}\[\]+\-=<>|,.;:0-9_^\/*]|(?<![A-Za-z])[A-Za-z](?![A-Za-z])/u', '', $rest) ?? $rest;
        return $rest === '';
    }

    /** Records another spelling of an entry, with the same meaning, as an "instance" variant. @return bool recorded */
    public static function addSpelling(int $pid, int $id, string $symbol, string $meaning, string $why): bool
    {
        $n = Db::one("SELECT id, variants_json FROM notations WHERE id = ? AND project_id = ? AND status <> 'rejected'", [$id, $pid]);
        $symbol = trim(self::bare($symbol));
        if (!$n || $symbol === '') return false;
        $variants = json_decode((string)$n['variants_json'], true) ?: [];
        foreach ($variants as $v) if (self::notionKey((string)($v['symbol'] ?? '')) === self::notionKey($symbol)) return false;
        $variants[] = ['symbol' => $symbol, 'meaning' => mb_substr($meaning ?: $why, 0, 500), 'where' => 'facts of the project', 'relation' => 'instance'];
        Db::update('notations', ['variants_json' => json_encode($variants, JSON_UNESCAPED_UNICODE), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
        return true;
    }

    /**
     * The local entries that apply to a fact: kept out of the project notation, they still say what a symbol means in the facts
     * that use it, those of the paper that defines it. One applies to its defining fact, to the facts it lists, and to the facts
     * found in the same sources as its defining fact. On that fact's page, it goes before an agreed entry of the same symbol:
     * Kreuzer's $(\mu)$ is Feferman's functional there, even though the project's $\mu(n)$ is a binary exponent.
     * @return list<array{id: int, symbol: string, meaning_html: string}>
     */
    public static function localFor(int $pid, int $fid): array
    {
        $out = [];
        $sourcesOf = fn(int $id) => array_map(fn($x) => $x['source_type'] . ':' . $x['source_id'], Db::all("SELECT s.source_type, s.source_id FROM fact_sources s
            JOIN facts f ON f.id = s.fact_id AND s.revision_no = f.current_revision WHERE s.fact_id = ? AND s.covers <> 'context' AND s.source_type IN ('bib', 'document')", [$id]));
        $mine = null;
        foreach (Db::all("SELECT id, symbol, meaning_html, facts_json, definition_fact_id, params_json FROM notations WHERE project_id = ? AND status = 'local' ORDER BY id", [$pid]) as $n) {
            $def = (int)$n['definition_fact_id'];
            $applies = $def === $fid || in_array($fid, array_map('intval', json_decode((string)$n['facts_json'], true) ?: []), true);
            if (!$applies && $def) {
                $mine ??= $sourcesOf($fid);
                $applies = $mine && array_intersect($mine, $sourcesOf($def));
            }
            if ($applies) $out[] = ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning_html' => $n['meaning_html'], 'params' => self::paramsOf($n)];
        }
        return $out;
    }

    /** Who decided an entry: nobody yet, the consolidation on its own, or a person (also when a person accepted the consolidation's proposal). */
    public static function decidedBy(array $n): ?string
    {
        if ($n['status'] === 'proposed') return null;
        $auto = $n['auto_suggestion_id'] && Db::value('SELECT auto_applied FROM fact_suggestions WHERE id = ?', [$n['auto_suggestion_id']]);
        return $auto ? 'consolidation' : 'person';
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
            // A rewrite in the current notation wins over a later one in a notation since undone.
            if ($x['notation_hash'] !== $hash && in_array($out[(int)$x['fact_id']]['state'], ['current', 'unchanged', 'unfaithful'], true)) continue;
            $out[(int)$x['fact_id']]['state'] = $x['notation_hash'] !== $hash ? 'stale' : ($x['check_verdict'] === 'unfaithful' ? 'unfaithful' : ($x['unchanged'] ? 'unchanged' : 'current'));
        }
        foreach (Db::all("SELECT source_id FROM ai_tasks WHERE project_id = ? AND kind = 'notation' AND source_type = 'fact' AND status IN ('pending', 'running')", [$pid]) as $t) {
            if (isset($out[(int)$t['source_id']])) $out[(int)$t['source_id']]['queued'] = true;
        }
        // A rewrite sweep waiting or running takes every fact not yet in the notation.
        if (\App\Sweeps::open($pid, 'rewrite')) foreach ($out as &$s) if (in_array($s['state'], ['none', 'stale', 'unfaithful'], true)) $s['queued'] = true;
        unset($s);
        return $out;
    }

    public static function progress(int $pid): array
    {
        $p = ['facts' => 0, 'current' => 0, 'unchanged' => 0, 'stale' => 0, 'unfaithful' => 0, 'none' => 0, 'queued' => 0, 'agreed' => 0, 'proposed' => 0, 'local' => 0];
        foreach (self::states($pid) as $s) { $p['facts']++; $p[$s['state']]++; if ($s['queued']) $p['queued']++; }
        foreach (Db::all('SELECT status, COUNT(*) AS n FROM notations WHERE project_id = ? GROUP BY status', [$pid]) as $c) if (isset($p[$c['status']])) $p[$c['status']] = (int)$c['n'];
        return $p;
    }

    /** The rephrasings of a fact, newest first, with their state. */
    public static function forFact(int $factId, int $pid, int $revision): array
    {
        $hash = self::hash($pid);
        return array_map(function ($x) use ($hash, $revision) {
            foreach (['id', 'fact_id', 'revision_no', 'author_id', 'checked_by', 'ai_generation_ms', 'check_ai_user_id', 'check_ai_generation_ms'] as $k) $x[$k] = $x[$k] === null ? null : (int)$x[$k];
            $x['unchanged'] = (bool)$x['unchanged'];
            $x['uses'] = json_decode((string)$x['uses_json'], true) ?: [];
            $x['local'] = json_decode((string)$x['local_json'], true) ?: (object)[];
            unset($x['uses_json'], $x['local_json']);
            $x['current'] = $x['revision_no'] === $revision && $x['notation_hash'] === $hash;
            return $x;
        }, Db::all('SELECT x.*, u.name AS checked_by_name, au.name AS ai_user_name, cu.name AS check_ai_user_name FROM fact_rephrasings x LEFT JOIN users u ON u.id = x.checked_by LEFT JOIN users au ON au.id = x.ai_user_id LEFT JOIN users cu ON cu.id = x.check_ai_user_id
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
        $params = $r->has('params') ? self::params($r->input('params')) : null;
        $facts = null;
        if ($r->has('facts')) {
            $want = array_values(array_unique(array_filter(array_map('intval', array_filter((array)$r->input('facts'), 'is_numeric')))));
            $facts = [];
            if ($want) { [$in, $p] = Db::in(array_slice($want, 0, 200)); $facts = array_map('intval', array_column(Db::all("SELECT id FROM facts WHERE project_id = ? AND deleted_at IS NULL AND id IN $in", array_merge([$pid], $p)), 'id')); }
        }
        return array_filter([
            'symbol' => $symbol, 'symbol_key' => self::key($symbol),
            'meaning_html' => $meaning !== null ? Sanitizer::clean(Sanitizer::textToHtml($meaning, $pid))['html'] : null,
            'note_html' => $note !== null ? ($note === '' ? '' : Sanitizer::clean(Sanitizer::textToHtml($note, $pid))['html']) : null,
            'variants_json' => $variants !== null ? ($variants ? json_encode($variants, JSON_UNESCAPED_UNICODE) : '') : null,
            'facts_json' => $facts !== null ? ($facts ? json_encode($facts) : '') : null,
            'params_json' => $params !== null ? ($params ? json_encode($params, JSON_UNESCAPED_UNICODE) : '') : null,
            'definition_fact_id' => $fact,
        ], fn($v) => $v !== null) + ($r->has('definition_fact_id') ? ['definition_fact_id' => $fact] : []);
    }

    /** {symbol: meaning}, from a list [{symbol, meaning}] or an object. */
    private static function localNotation(mixed $in): array
    {
        $out = [];
        if (!is_array($in)) return $out;
        foreach ($in as $k => $v) {
            [$symbol, $meaning] = is_array($v) ? [$v['symbol'] ?? '', $v['meaning'] ?? ''] : [$k, $v];
            $symbol = mb_substr(trim(is_scalar($symbol) ? (string)$symbol : ''), 0, 160);
            $meaning = mb_substr(trim(is_scalar($meaning) ? (string)$meaning : ''), 0, 1000);
            if ($symbol !== '' && $meaning !== '' && count($out) < 40) $out[$symbol] = $meaning;
        }
        return $out;
    }

    /**
     * The notation each fact defines for itself, as the project shows it: its rewrite in project notation when there is one,
     * otherwise its own glossary. Symbols that several facts define are the candidates to make global.
     * @return list<array{symbol: string, facts: int, meanings: list<array{meaning: string, facts: list<int>}>, entry: ?array}>
     */
    public static function shared(int $pid, int $min = 2, int $limit = 100): array
    {
        $local = [];
        foreach (Db::all('SELECT f.id, r.glossary_json FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                          WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL', [$pid]) as $f) {
            $local[(int)$f['id']] = self::localNotation(json_decode((string)$f['glossary_json'], true) ?: []);
        }
        $hash = self::hash($pid);
        foreach (Db::all("SELECT x.fact_id, x.local_json FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id AND x.revision_no = f.current_revision
                          WHERE f.project_id = ? AND x.notation_hash = ? AND x.unchanged = 0 AND (x.check_verdict IS NULL OR x.check_verdict <> 'unfaithful') ORDER BY x.id", [$pid, $hash]) as $x) {
            if (isset($local[(int)$x['fact_id']])) $local[(int)$x['fact_id']] = self::localNotation(json_decode((string)$x['local_json'], true) ?: []);
        }
        $entries = [];
        // An entry says, once an AI or a person judged them, how many meanings found in sources really differ ("clash").
        // Its other spellings of the same notion ("instance" variants) are that entry too.
        foreach (Db::all("SELECT id, symbol, status, variants_json FROM notations WHERE project_id = ? AND status <> 'rejected' ORDER BY status = 'agreed' DESC, id", [$pid]) as $n) {
            $variants = json_decode((string)$n['variants_json'], true) ?: [];
            $e = ['id' => (int)$n['id'], 'status' => $n['status'], 'clashes' => count(array_filter($variants, fn($v) => ($v['relation'] ?? '') === 'clash'))];
            $entries[self::notionKey($n['symbol'])] ??= $e;
            foreach ($variants as $v) if (($v['relation'] ?? '') === 'instance' && is_string($v['symbol'] ?? null)) $entries[self::notionKey($v['symbol'])] ??= $e;
        }
        $agreed = array_column(Db::all("SELECT symbol FROM notations WHERE project_id = ? AND status = 'agreed'", [$pid]), 'symbol');
        $by = [];
        foreach ($local as $fid => $defs) {
            foreach (self::splitDefinitions($defs) as [$symbol, $meaning]) {
                $symbol = self::bare((string)$symbol); // $FS(H)$ and FS(H) are one spelling
                if (self::isProofVariable($symbol)) continue; // A_i, f, q: names of one argument, not notation
                $k = self::notionKey($symbol);
                $by[$k] ??= ['symbol' => $symbol, 'spellings' => [], 'facts' => [], 'meanings' => []];
                $by[$k]['spellings'][$symbol] = ($by[$k]['spellings'][$symbol] ?? 0) + 1;
                $by[$k]['facts'][$fid] = true;
                $mk = mb_strtolower(preg_replace('/[\s.]+/u', '', $meaning) ?? '');
                $by[$k]['meanings'][$mk] ??= ['meaning' => $meaning, 'facts' => []];
                $by[$k]['meanings'][$mk]['facts'][] = $fid;
            }
        }
        $out = [];
        foreach ($by as $k => $s) {
            if (count($s['facts']) < $min) continue;
            $meanings = array_values($s['meanings']);
            usort($meanings, fn($a, $b) => count($b['facts']) <=> count($a['facts']));
            arsort($s['spellings']);
            $symbol = (string)array_key_first($s['spellings']);
            // An expression in agreed symbols needs no entry: it counts as settled.
            $entry = $entries[$k] ?? (self::derived($symbol, $agreed) ? ['id' => null, 'status' => 'derived', 'clashes' => 0] : null);
            $out[] = ['symbol' => $symbol, 'spellings' => array_keys($s['spellings']), 'facts' => count($s['facts']), 'meanings' => array_map(fn($m) => ['meaning' => $m['meaning'], 'facts' => array_slice($m['facts'], 0, 50)], array_slice($meanings, 0, 8)), 'entry' => $entry];
        }
        usort($out, fn($a, $b) => [$b['entry'] === null, $b['facts']] <=> [$a['entry'] === null, $a['facts']]);
        return array_slice($out, 0, $limit);
    }

    /**
     * A glossary key that defines several symbols at once, "\\lambda(n),\\mu(n)", is one definition per symbol, each with the
     * shared meaning. Commas inside braces, brackets or parentheses, as in [1,r], are part of a symbol.
     * @return list<array{0: string, 1: string}>
     */
    public static function splitDefinitions(array $defs): array
    {
        $out = [];
        foreach ($defs as $symbol => $meaning) {
            $parts = []; $depth = 0; $cur = '';
            $prev = '';
            foreach (preg_split('//u', self::bare((string)$symbol), -1, PREG_SPLIT_NO_EMPTY) as $c) {
                $escaped = $prev === '\\';
                $prev = $escaped ? '' : $c; // after \\\\ (a line break), a comma separates again
                if ($escaped) { $cur .= $c; continue; } // \, \{ \( are LaTeX, such as the thin space of X\,\tilde\in\,U
                if (in_array($c, ['{', '(', '['], true)) $depth++;
                if (in_array($c, ['}', ')', ']'], true)) $depth = max(0, $depth - 1);
                if ($c === ',' && $depth === 0) { $parts[] = $cur; $cur = ''; continue; }
                $cur .= $c;
            }
            $parts[] = $cur;
            $parts = array_values(array_filter(array_map(fn($x) => trim(self::bare(trim($x, " \t\n$"))), $parts), fn($x) => $x !== ''));
            // Symbols and one-word names are split ("P-branch, P-condition, $\le$"); a phrase is one term: "red, blue or green".
            if (count($parts) > 1 && array_filter($parts, fn($x) => !preg_match('/[\\(_^]/', $x) && preg_match('/\s/u', $x))) $parts = [self::bare((string)$symbol)];
            foreach ($parts as $x) $out[] = [$x, (string)$meaning];
        }
        return $out;
    }

    /**
     * The notion a symbol writes, whatever its arguments are called: FS(X), FS(H) and \mathrm{FS}(S) are one notion.
     * A setting in parentheses, such as full-match (HT), stays part of it.
     */
    public static function notionKey(string $symbol): string
    {
        $symbol = self::bare($symbol);
        // \mathrm{FS} and FS are the same name.
        $s = preg_replace('/\\\\(?:mathrm|mathsf|mathbf|mathit|mathcal|operatorname|textrm|text)\s*\{([^{}]*)\}/u', '$1', trim($symbol)) ?? $symbol;
        $s = preg_replace('/\s+/u', '', $s) ?? $s;
        // An argument that is one letter, possibly indexed, or a sequence such as (x_i)_{i\in N}, is a placeholder.
        $letter = '(?:\\\\[a-zA-Z]+|[A-Za-z])(?:_\{?[A-Za-z0-9]+\}?)?';
        $s = preg_replace('/(?<=.)\((?:' . $letter . '|\(' . $letter . '\)(?:_\{[^{}]*\}|_[A-Za-z0-9])?)\)/u', '(·)', $s) ?? $s; // after a name only: (\mu) is a name
        return mb_strtolower(str_replace(['{', '}'], '', $s));
    }

    /** One letter, Latin or Greek, possibly indexed: a variable of one argument, never a notation of the project. */
    /** A symbol as a fact's notation writes it, $FS(H)$ or FS(H): the same symbol. */
    public static function bare(string $symbol): string
    {
        $s = trim($symbol);
        while (preg_match('/^\$+(.*?)\$+$/su', $s, $m) && $m[1] !== '') $s = trim($m[1]);
        return $s;
    }

    public static function isProofVariable(string $symbol): bool
    {
        $s = self::bare($symbol);
        if (preg_match('/^\\\\(?:mathbb|mathcal|mathrm|mathsf|mathbf|mathfrak)/', $s)) return false; // a named object, such as \mathbb{N}
        return (bool)preg_match('/^(?:[A-Za-z]|\\\\[a-zA-Z]+)(?:[_^](?:\{[A-Za-z0-9,+\-]*\}|[A-Za-z0-9]))*$/u', $s);
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
        return array_values(array_filter(array_map(fn($x) => ['symbol' => $s($x, 'symbol', 160), 'meaning' => $s($x, 'meaning', 1000), 'where' => $s($x, 'where', 300),
            'relation' => in_array($s($x, 'relation', 10), self::RELATIONS, true) ? $s($x, 'relation', 10) : 'clash'], $list), fn($v) => $v['symbol'] !== '' && $v['meaning'] !== ''));
    }

    /** [{name, type}]: the objects an entry is written with, each with the type of object it stands for. */
    public static function params(mixed $list): array
    {
        if (!is_array($list) || !array_is_list($list)) throw new HttpError(422, 'params must be a list of {name, type}.');
        $out = [];
        foreach (array_slice($list, 0, 8) as $p) {
            $name = trim(self::bare(is_array($p) && is_scalar($p['name'] ?? null) ? (string)$p['name'] : ''));
            $type = trim(is_array($p) && is_scalar($p['type'] ?? null) ? (string)$p['type'] : '');
            if ($name === '' || mb_strlen($name) > 40) continue;
            $out[] = ['name' => $name, 'type' => mb_substr($type, 0, 200)];
        }
        return $out;
    }

    /**
     * The parameters of an entry: the letters its symbol is written with, X and Y in "Y \leq X" or X in FS(X), with the types given
     * for them, or an empty type when nobody said. The same reading as paramsOf in notation-params.js.
     * @return list<array{name: string, type: string}>
     */
    public static function paramsOf(array $n): array
    {
        $given = json_decode((string)($n['params_json'] ?? ''), true) ?: [];
        $type = [];
        foreach ($given as $p) if (is_array($p) && isset($p['name'])) $type[self::paramKey((string)$p['name'])] = (string)($p['type'] ?? '');
        $out = [];
        foreach (self::inferParams((string)$n['symbol']) as $name) $out[self::paramKey($name)] = ['name' => $name, 'type' => $type[self::paramKey($name)] ?? ''];
        foreach ($given as $p) if (is_array($p) && isset($p['name'])) $out[self::paramKey((string)$p['name'])] ??= ['name' => (string)$p['name'], 'type' => (string)($p['type'] ?? '')];
        return array_values($out);
    }

    /** The letters a symbol is written with: one Latin letter alone, or one letter in a font such as \mathcal{D}. Names such as FS are not. */
    public static function inferParams(string $symbol): array
    {
        $s = self::bare($symbol);
        preg_match_all('/\\\\(?:mathcal|mathscr|mathfrak|mathbf|boldsymbol)\s*\{\s*[A-Za-z]\s*\}|\\\\(?:mathrm|mathsf|mathit|operatorname|textrm|text|mathbb)\s*\{[^{}]*\}|\\\\[A-Za-z]+|\\\\.|[A-Za-z]+|\s+|./su', $s, $m);
        $toks = $m[0];
        // A term in words, such as P-condition or full-match (HT), has no parameter.
        if (preg_match('/(?<!\\\\)\b[A-Za-z]+-[A-Za-z]/', $s) || array_filter($toks, fn($t) => preg_match('/^[A-Za-z]{4,}$/', $t))) return [];
        $out = [];
        $prev = '';
        foreach ($toks as $t) {
            if (trim($t) === '') continue;
            $letter = preg_match('/^[A-Za-z]$/', $t) || preg_match('/^\\\\(?:mathcal|mathscr|mathfrak|mathbf|boldsymbol)\s*\{/', $t);
            // After a font command written without braces, \mathsf D, the letter is the name.
            $named = preg_match('/^\\\\(?:mathrm|mathsf|mathit|mathbf|mathcal|mathscr|mathfrak|mathbb|boldsymbol|operatorname|textrm|text|rm|sf|bf|it|cal)$/', $prev);
            if ($letter && !$named) $out[self::paramKey($t)] ??= preg_replace('/\s+/', '', $t);
            $prev = $t;
        }
        // A symbol that is one letter only, such as \mathcal{U}, is a name, not a parameter.
        return count(array_filter($toks, fn($t) => trim($t) !== '')) === 1 ? [] : array_values($out);
    }

    private static function paramKey(string $name): string
    {
        return preg_replace('/\s+/', '', self::bare($name)) ?? $name;
    }

    private static function typed(string $json): bool
    {
        foreach (json_decode($json, true) ?: [] as $p) if (trim((string)($p['type'] ?? '')) !== '') return true;
        return false;
    }

    /**
     * Types given by the symbols sweep to entries of its batch that had none. Only the parameters the symbol is written with, and
     * never types someone already gave. @return int the entries typed
     */
    public static function typeEntries(int $pid, array $batch, array $given): int
    {
        $mine = array_flip(array_map('intval', $batch));
        $typed = 0;
        foreach ($given as $g) {
            $id = (int)($g['entry'] ?? 0);
            if (!isset($mine[$id])) continue;
            unset($mine[$id]);
            $n = Db::one('SELECT id, symbol, params_json FROM notations WHERE id = ? AND project_id = ?', [$id, $pid]);
            if (!$n || self::typed((string)$n['params_json'])) continue;
            $names = array_flip(array_map([self::class, 'paramKey'], array_column(self::paramsOf($n), 'name')));
            $params = array_values(array_filter(self::params(is_array($g['params'] ?? null) && array_is_list($g['params']) ? $g['params'] : []),
                fn($p) => isset($names[self::paramKey($p['name'])]) && trim($p['type']) !== ''));
            if (!$params) continue;
            Db::update('notations', ['params_json' => json_encode($params, JSON_UNESCAPED_UNICODE), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            $typed++;
        }
        return $typed;
    }

    /** A piece of a symbol cut at a LaTeX thin space, such as X\ out of X\,\tilde\in\,U, or two symbols kept as one, X[b]$, $X[Y]. */
    public static function brokenSymbol(string $symbol): bool
    {
        $s = self::bare($symbol);
        return (bool)preg_match('/(?<!\\\\)(?:\\\\\\\\)*\\\\$/', $s) || str_contains($s, '$');
    }

    /**
     * Repairs the entries written before glossary keys were cut correctly: a broken spelling goes from the variants, and a broken entry that
     * no person decided goes, or is rejected when members discussed it. The sweep then reads the symbol again, whole.
     */
    public static function repairCut(): void
    {
        foreach (Db::all('SELECT id, symbol, status, variants_json, decided_by, auto_suggestion_id FROM notations') as $n) {
            if (self::brokenSymbol((string)$n['symbol'])) {
                if ($n['decided_by'] && !$n['auto_suggestion_id']) continue; // a person's decision stays
                if (Db::value("SELECT 1 FROM comments WHERE target_type = 'notation' AND target_id = ?", [$n['id']])) {
                    if ($n['status'] !== 'rejected') Db::update('notations', ['status' => 'rejected', 'auto_suggestion_id' => null, 'updated_at' => Db::now()], 'id = :id', ['id' => $n['id']]);
                } else {
                    Db::run('DELETE FROM notations WHERE id = ?', [$n['id']]);
                }
                continue;
            }
            $variants = json_decode((string)$n['variants_json'], true) ?: [];
            $kept = array_values(array_filter($variants, fn($v) => !self::brokenSymbol((string)($v['symbol'] ?? ''))));
            if (count($kept) !== count($variants)) Db::update('notations', ['variants_json' => $kept ? json_encode($kept, JSON_UNESCAPED_UNICODE) : null], 'id = :id', ['id' => $n['id']]);
        }
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
        return 'SELECT n.*, u.name AS author_name, d.name AS decided_by_name, au.name AS ai_user_name, f.label AS definition_label,
                (SELECT COUNT(*) FROM comments c WHERE c.target_type = \'notation\' AND c.target_id = n.id) AS comment_count,
                (SELECT COUNT(*) FROM comments c WHERE c.target_type = \'notation\' AND c.target_id = n.id AND c.parent_id IS NULL AND c.resolved = 0) AS open_threads FROM notations n JOIN users u ON u.id = n.author_id
                LEFT JOIN users d ON d.id = n.decided_by LEFT JOIN users au ON au.id = n.ai_user_id LEFT JOIN facts f ON f.id = n.definition_fact_id AND f.deleted_at IS NULL';
    }

    private static function present(array $n): array
    {
        foreach (['id', 'project_id', 'author_id', 'decided_by', 'definition_fact_id', 'ai_user_id', 'ai_generation_ms', 'comment_count', 'open_threads', 'auto_suggestion_id'] as $k) $n[$k] = $n[$k] === null ? null : (int)$n[$k];
        $n['variants'] = json_decode((string)$n['variants_json'], true) ?: [];
        $n['facts'] = json_decode((string)$n['facts_json'], true) ?: [];
        $n['params'] = self::paramsOf($n);
        $n['meaning_text'] = Sanitizer::toText((string)$n['meaning_html']);
        $n['decided_by_kind'] = self::decidedBy($n); // null, consolidation or person
        $n['note_text'] = $n['note_html'] ? Sanitizer::toText((string)$n['note_html']) : '';
        unset($n['variants_json'], $n['facts_json'], $n['params_json']);
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
