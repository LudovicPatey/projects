<?php
declare(strict_types=1);

namespace App;

use App\Controllers\AiTaskController;
use App\Controllers\FactController;
use App\Controllers\NotationController;
use App\Controllers\QuestionController;

/**
 * Instructions to the AI in a comment: a member writes "@AI ..." on a fact, a question, a strategy, a file, a reference, a notation
 * entry or a conversation. The AI that takes the task replies in the thread, and turns the instruction into actions of a fixed list for
 * that kind of object, each run through the path that already exists for it, with its checks: nothing it does changes a result without
 * another company's check and a member's decision, and work it queues counts as the member's request. An instruction it cannot map,
 * or does not understand, gets a reply and no action; a question gets an answer.
 */
final class Instructions
{
    /** What an instruction may become on each kind of object, as the AI reads it in task.json ("actions_allowed"). */
    public const ACTIONS = [
        'fact' => [
            'variant' => 'Add a variant of the fact beside it (another base system, an extra hypothesis, a special case, a generalization): give each in "items", with a title, statement and complete proof. An AI of another company checks it, and a member confirms before it becomes a new fact. The fact itself stays.',
            'correct' => 'Correct the fact\'s statement, which the member says is wrong: put the member\'s request, in your words, in "text". Another AI proposes corrected statements, another company checks them, a member chooses which supersede the fact.',
            'repair' => 'Repair the fact\'s proof, which the member says has a gap or an error: put the objection in "text". An AI repairs it, or answers that the objection is wrong, and an AI of another company checks that answer.',
            'review' => 'An independent review of the fact\'s proof by a model independent of its author.',
            'lean' => 'A Lean proof of the fact, kept only if it compiles.',
            'source_check' => 'A check of a cited result against its source.',
            'notation' => 'Write the fact again in the project\'s agreed notation.',
        ],
        'oquestion' => [
            'derive' => 'Search for new facts toward the question: put what to try, in the member\'s words, in "text". The facts found are marked unchecked.',
            'references' => 'Search for works on the question: put what to look for in "text". References confirmed by their DOI or arXiv record are added; members accept the others.',
            'strategy' => 'Add a strategy to the question, as an idea: give it in "items", with a "title" and its description in "statement". Members develop it, or drop it.',
            'subquestion' => 'Add sub-questions to the question: give each in "items", with a "title" and its precise statement in "statement". Members can delete them.',
            'check_answers' => 'Check the answers proposed to the question: a review of each fact they rest on, or a check of its source for a cited result.',
        ],
        'strategy' => [
            'derive' => 'Search for new facts that develop the strategy: put what to try in "text". The facts found are marked unchecked.',
            'references' => 'Search for works the strategy could use: put what to look for in "text".',
        ],
        'document' => [
            'extract' => 'Extract facts from the file again, following the member\'s instruction ("only section 3", "you missed Lemma 4.2"): put it in "text".',
        ],
        'bib' => [
            'extract' => 'Extract facts from the reference\'s PDF, following the member\'s instruction: put it in "text".',
            'references' => 'Search for works related to the reference: put what to look for in "text".',
        ],
        'notation' => [
            'change' => 'Propose a change of the entry: give the new entry in "items", with the symbol in "title" (LaTeX without dollars), its precise meaning in "statement" and why in "why". It is added as a proposed entry beside this one; members decide.',
            'rewrite' => 'Write again, in the agreed notation, the facts not written in it yet.',
            'settle' => 'Settle what the notation still leaves open: the symbols several facts define with no entry, and the entries still proposed.',
        ],
        'conversation' => [
            'extract' => 'Extract facts from the conversation, following the member\'s instruction: put it in "text". Only for a conversation every member can read.',
        ],
    ];

    /** Every action name, for the answer's schema. */
    public const NAMES = ['variant', 'correct', 'repair', 'review', 'lean', 'source_check', 'notation', 'derive', 'references', 'strategy', 'subquestion', 'check_answers', 'extract', 'change', 'rewrite', 'settle'];

    /** The subject of the queue for a comment's target. */
    private const SUBJECT = ['fact' => 'fact', 'oquestion' => 'question', 'strategy' => 'strategy', 'document' => 'document', 'bib' => 'bib', 'conversation' => 'conversation', 'notation' => 'notation'];

    public static function handles(string $targetType): bool
    {
        return isset(self::ACTIONS[$targetType]);
    }

    /** For a task: the object the comment is on, what surrounds it, and the actions allowed there. */
    public static function context(int $pid, int $commentId): array
    {
        $c = Db::one('SELECT target_type, target_id FROM comments WHERE id = ?', [$commentId]);
        if (!$c || !self::handles($c['target_type'])) return [];
        $id = (int)$c['target_id'];
        $text = fn($h) => Sanitizer::toText((string)$h);
        $ctx = match ($c['target_type']) {
            'fact' => self::factContext($pid, $id),
            'oquestion' => self::questionContext($pid, $id),
            'strategy' => self::strategyContext($pid, $id),
            'document' => ['file' => Db::one('SELECT id, title FROM documents WHERE id = ?', [$id])],
            'bib' => ['reference' => ($b = Db::one('SELECT id, title, authors, year, pdf_blob_id FROM bib_entries WHERE id = ?', [$id])) ? ['id' => (int)$b['id'], 'title' => $b['title'], 'authors' => $b['authors'], 'year' => $b['year'], 'has_pdf' => (bool)$b['pdf_blob_id']] : null],
            'notation' => ['entry' => ($n = Db::one('SELECT id, symbol, meaning_html, note_html, status FROM notations WHERE id = ?', [$id])) ? ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning' => $text($n['meaning_html']), 'note' => $text($n['note_html']), 'status' => $n['status']] : null],
            'conversation' => ['conversation' => ['id' => $id, 'subject' => Db::value('SELECT subject FROM conversations WHERE id = ?', [$id]), 'every_member_reads_it' => AiTaskController::outsideMembers($pid, $id) === 0]],
        };
        return $ctx + ['commented_on' => ['type' => $c['target_type'], 'id' => $id], 'actions_allowed' => self::ACTIONS[$c['target_type']]];
    }

    private static function factContext(int $pid, int $fid): array
    {
        $f = Db::one('SELECT f.id, f.label, f.title, f.kind, f.current_revision, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id = ? AND f.project_id = ?', [$fid, $pid]);
        if (!$f) return [];
        $text = fn($h) => Sanitizer::toText((string)$h);
        $list = fn(string $sql) => array_map(fn($d) => ['label' => $d['label'], 'title' => $d['title'], 'statement' => $text($d['statement_html'])], Db::all($sql, [$fid]));
        $doc = AiTaskController::factSourceDocument($fid);
        return ['fact' => ['fact_id' => $fid, 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'], 'statement' => $text($f['statement_html']), 'proof' => $text($f['proof_html']),
                'definitions' => FactController::definitions($pid, $fid, (int)$f['current_revision']),
                'sources' => array_values(array_map(fn($s) => ['label' => $s['label'] ?? $s['type'], 'page' => $s['page'] ?? null, 'quote' => $s['quote']], array_filter(FactController::presentSources($fid, (int)$f['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context')))],
            'dependencies' => $list('SELECT f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.depends_on_id JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.fact_id = ? LIMIT 50'),
            'used_by' => $list('SELECT f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.fact_id AND f.deleted_at IS NULL JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.depends_on_id = ? LIMIT 30')]
            + ($doc ? ['document' => $doc] : []);
    }

    /** The facts of the project in short, for an instruction about a question or a strategy. */
    private static function facts(int $pid): array
    {
        return array_map(fn($f) => ['id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'statement' => mb_substr(Sanitizer::toText((string)$f['statement_html']), 0, 500)],
            Db::all('SELECT f.id, f.label, f.title, r.statement_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                     WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL ORDER BY f.id DESC LIMIT 300', [$pid]));
    }

    private static function questionContext(int $pid, int $qid): array
    {
        $q = Db::one('SELECT id, parent_id, title, statement_html, status FROM open_questions WHERE id = ? AND project_id = ?', [$qid, $pid]);
        if (!$q) return [];
        return ['question' => ['id' => $qid, 'title' => $q['title'], 'statement' => Sanitizer::toText((string)$q['statement_html']), 'status' => $q['status'],
                'parent' => $q['parent_id'] ? Db::value('SELECT title FROM open_questions WHERE id = ?', [$q['parent_id']]) : null],
            'sub_questions' => array_column(Db::all('SELECT title FROM open_questions WHERE parent_id = ? AND deleted_at IS NULL', [$qid]), 'title'),
            'strategies' => Db::all('SELECT title, status FROM proof_strategies WHERE question_id = ? AND deleted_at IS NULL', [$qid]),
            'answers' => array_map(fn($a) => ['answer' => $a['answer'], 'state' => $a['state'], 'fact' => $a['label'] . ': ' . $a['title']],
                Db::all('SELECT a.answer, a.state, f.label, f.title FROM question_answers a JOIN facts f ON f.id = a.fact_id WHERE a.question_id = ?', [$qid])),
            'facts' => self::facts($pid)];
    }

    private static function strategyContext(int $pid, int $sid): array
    {
        $s = Db::one('SELECT id, question_id, title, status FROM proof_strategies WHERE id = ? AND project_id = ?', [$sid, $pid]);
        if (!$s) return [];
        return ['strategy' => ['id' => $sid, 'title' => $s['title'], 'status' => $s['status'],
                'body' => Sanitizer::toText((string)Db::value('SELECT body_html FROM strategy_revisions WHERE strategy_id = ? ORDER BY revision_no DESC LIMIT 1', [$sid])),
                'question' => Db::value('SELECT title FROM open_questions WHERE id = ?', [$s['question_id']])],
            'facts' => self::facts($pid)];
    }

    /**
     * Applies an answer: the reply goes to the thread, with a line for each action and what became of it. @return array{summary: string,
     * reply_text: string, fact_ids: list<int>}
     */
    public static function apply(array $t, array $answer, ?string $model, mixed $seconds): array
    {
        $c = Db::one('SELECT * FROM comments WHERE id = ?', [(int)$t['source_id']]);
        if (!$c || !self::handles($c['target_type'])) throw new HttpError(409, 'The comment was deleted.');
        $type = $c['target_type']; $id = (int)$c['target_id']; $pid = (int)$t['project_id']; $by = (int)$c['author_id'];
        $request = trim(Sanitizer::toText((string)$c['body_html']));
        $done = [];
        foreach (array_slice((array)($answer['actions'] ?? []), 0, 4) as $a) {
            $kind = (string)($a['action'] ?? ''); $text = trim((string)($a['text'] ?? '')); $items = (array)($a['items'] ?? []);
            try {
                if (!isset(self::ACTIONS[$type][$kind])) throw new HttpError(422, "\"$kind\" is not an action here.");
                $done[] = self::act($type, $kind, $pid, $id, $by, $text, $request, $items, $model, $seconds);
            } catch (HttpError $e) {
                $done[] = 'Not started: ' . $e->getMessage();
            }
        }
        $done = array_values(array_filter($done));
        $reply = trim((string)$answer['reply']) . ($done ? "\n\n" . implode("\n", array_map(fn($x) => "- $x", $done)) : '');
        if (trim($reply) === '') throw new HttpError(422, 'The answer has no reply.');
        $started = count(array_filter($done, fn($x) => !str_starts_with($x, 'Not started')));
        return ['summary' => trim("$started action" . ($started === 1 ? '' : 's') . ' started. ' . trim((string)($answer['summary'] ?? ''))), 'reply_text' => $reply, 'fact_ids' => $type === 'fact' ? [$id] : []];
    }

    /** One action. $text: what the AI wrote for it, perhaps "". @return string what became of it, for the reply */
    private static function act(string $type, string $kind, int $pid, int $id, int $by, string $text, string $request, array $items, ?string $model, mixed $seconds): string
    {
        switch ("$type:$kind") {
            case 'fact:variant':
                $n = count(array_filter($items, fn($v) => trim((string)($v['statement'] ?? '')) !== '' && trim((string)($v['proof'] ?? '')) !== ''));
                StatementFix::startVariant($id, $by, $request, $items, $model, $seconds);
                return "$n variant" . ($n === 1 ? '' : 's') . ' proposed: an AI of another company checks ' . ($n === 1 ? 'it' : 'them') . ', then a member confirms before ' . ($n === 1 ? 'it becomes a new fact' : 'they become new facts') . '.';
            case 'fact:correct':
                StatementFix::ask($id, $by, $text !== '' ? $text : $request);
                return 'Correction of the statement started: an AI proposes corrected statements, another company checks them, and a member chooses.';
            case 'fact:repair':
                ProofRepair::fromObjection($id, $by, $text !== '' ? $text : $request);
                return 'Repair of the proof started: an AI repairs it or answers the objection, and an AI of another company checks that answer. The proof under discussion stays as it is.';
            case 'oquestion:strategy':
                return self::strategies($pid, $id, $items, $model, $seconds);
            case 'oquestion:subquestion':
                return self::subQuestions($pid, $id, $items, $model, $seconds);
            case 'oquestion:check_answers':
                $out = [];
                foreach (Db::all("SELECT DISTINCT fact_id FROM question_answers WHERE question_id = ? AND state IN ('proposed', 'ratified')", [$id]) as $a) {
                    $basis = FactController::graphFact($pid, (int)$a['fact_id'])['basis'] ?? null;
                    try { $out[] = AiTaskController::queueFor($pid, $basis === 'cited' ? 'source_check' : 'review', 'fact', (int)$a['fact_id'], $by, ''); }
                    catch (HttpError $e) { $out[] = 'not ' . lcfirst($e->getMessage()); }
                }
                if (!$out) throw new HttpError(422, 'no answer is proposed to this question yet.');
                return 'Answers checked: ' . implode('; ', $out) . '.';
            case 'notation:change':
                $x = $items[0] ?? null;
                if (!$x) throw new HttpError(422, 'a change needs the new entry.');
                NotationController::proposeChange($pid, $id, (string)($x['title'] ?? ''), (string)($x['statement'] ?? ''), (string)($x['why'] ?? ''), $model, $seconds);
                return 'A new entry is proposed beside this one: members agree on it or reject it. Agreeing on it needs this entry changed or rejected first.';
            case 'notation:rewrite':
                if (NotationController::hash($pid) === sha1('')) throw new HttpError(422, 'the project has no agreed notation yet.');
                if (!Sweeps::rewriteCandidates($pid)) return 'Every fact already follows the agreed notation: nothing to rewrite.';
                AiTaskController::queueSweep($pid, 'rewrite', true);
                return 'Rewrite in the agreed notation queued, for the facts not written in it yet. A second AI checks each rewrite, and the original text stays.';
            case 'notation:settle':
                AiTaskController::queueSweep($pid, 'symbols', true);
                return 'Settling of the notation queued: an AI decides the symbols several facts define and the entries still proposed. Members can undo each decision.';
            default:
                return AiTaskController::queueFor($pid, $kind === 'references' ? 'bib' : $kind, self::SUBJECT[$type], $id, $by, $text) . '.';
        }
    }

    private static function strategies(int $pid, int $qid, array $items, ?string $model, mixed $seconds): string
    {
        $made = 0;
        foreach (array_slice($items, 0, 3) as $x) {
            $title = mb_substr(trim((string)($x['title'] ?? '')), 0, 240); $body = trim((string)($x['statement'] ?? ''));
            if ($title === '' || $body === '') continue;
            $now = Db::now();
            $sid = Db::insert('proof_strategies', ['project_id' => $pid, 'question_id' => $qid, 'title' => $title, 'status' => 'idea', 'current_revision' => 1, 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
            QuestionController::revision($sid, 1, $title, 'idea', Sanitizer::clean(Sanitizer::textToHtml(mb_substr($body, 0, 20000), $pid))['html'], 'Proposed from a member\'s instruction', $model, Provenance::stamp($model, $seconds));
            Activity::touch($pid, 'strategy', $sid, 'created');
            $made++;
        }
        if (!$made) throw new HttpError(422, 'a strategy needs a title and a description.');
        return ($made === 1 ? '1 strategy added as an idea' : "$made strategies added as ideas") . ', marked as written by the AI. Members develop ' . ($made === 1 ? 'it' : 'them') . ', or drop ' . ($made === 1 ? 'it' : 'them') . '.';
    }

    private static function subQuestions(int $pid, int $qid, array $items, ?string $model, mixed $seconds): string
    {
        $made = 0;
        foreach (array_slice($items, 0, 5) as $x) {
            $title = mb_substr(trim((string)($x['title'] ?? '')), 0, 240);
            if ($title === '') continue;
            $now = Db::now();
            $id = Db::insert('open_questions', Provenance::stamp($model, $seconds) + ['project_id' => $pid, 'parent_id' => $qid, 'title' => $title,
                'statement_html' => Sanitizer::clean(Sanitizer::textToHtml(mb_substr(trim((string)($x['statement'] ?? '')), 0, 20000), $pid))['html'], 'status' => 'open', 'priority' => 'normal',
                'ai_model' => $model, 'created_by' => Auth::id(), 'updated_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
            Activity::touch($pid, 'oquestion', $id, 'created');
            $made++;
        }
        if (!$made) throw new HttpError(422, 'a sub-question needs a title.');
        return "$made sub-question" . ($made === 1 ? '' : 's') . ' added, marked as written by the AI. Members can delete ' . ($made === 1 ? 'it' : 'them') . '.';
    }
}
