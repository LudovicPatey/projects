<?php
declare(strict_types=1);

namespace App;

use App\Controllers\ConsolidationController;
use App\Controllers\NotationController;

/**
 * AI procedures defined by the platform. A procedure is only reasoning: instructions, the JSON schema of the answer,
 * and how the platform applies that answer. An AI client that sends the "procedures" feature receives the recipe with
 * each task, runs it with the model its user chose, and returns the answer to POST /api/ai/tasks/{id}/answer.
 * Adding a procedure here needs no new client, unless it needs a capability that clients do not have yet.
 */
final class Procedures
{
    /** What a client may be asked to do besides reasoning. A client refuses any other. */
    public const CAPABILITIES = ['web_search', 'document'];

    /** @return array<string, array{label: string, description: string, tier: string, capabilities: list<string>}> */
    private static function defs(): array
    {
        return [
            'ask' => ['label' => 'Answer @AI', 'description' => 'Answer a question asked to the AI in a conversation or a comment.', 'tier' => 'fast', 'capabilities' => ['document']],
            'notation' => ['label' => 'Project notation', 'description' => 'Propose a common notation for the project, and write facts again in it, when a member asks.', 'tier' => 'strong', 'capabilities' => []],
            'consolidate' => ['label' => 'Consolidate the facts', 'description' => 'After extractions, read the whole facts database and propose merges of duplicates, links across sources, open questions, subject tags, the cited results behind the outside references of proofs, and the project\'s notation.', 'tier' => 'strong', 'capabilities' => []],
            'source_check' => ['label' => 'Check a cited result', 'description' => 'Read the source of a result cited without proof, and say whether it states the result as written. People still accept it.', 'tier' => 'fast', 'capabilities' => ['document', 'web_search']],
        ];
    }

    private const INSTRUCTIONS = [
        'ask' => <<<'TXT'
TASK: answer the last message of the "thread" in task.json, which asks for the opinion of the AI.
Be precise and concise, separate what is proved from what is your opinion, and state your uncertainty.
"facts" gives the start of each fact's statement, and "cited_facts" the whole statement and proof of the facts the question cites.
You may cite project objects as @{fact:ID}, @{question:ID} or @{bib:ID}, using only ids listed in task.json.
Put the full answer in "reply" and one sentence in "summary".
TXT,
        'notation_propose' => <<<'TXT'
TASK: review the notation of the whole project, and help the team agree on it. Each fact defines its own symbols:
"local_notation" in task.json lists every symbol that facts define for themselves, with the facts that give it each meaning.
Suggest making a symbol global when several facts define it with the same meaning, or when it is a standard notion of the field,
and list the ids of the facts that define it in "facts". When facts give one symbol different meanings, propose one global meaning and say
in "note" which facts must use another symbol. "fact_texts" in task.json lists the facts, with their statement,
the meaning their "glossary" gives to symbols, and their "source". Papers often use the same symbol for different things, for example FS(X)
for the finite sums of X with or without 0, or different symbols for the same notion. Find the symbols whose meaning differs between sources,
or that matter to the project, and propose one entry for each: "symbol" in LaTeX without dollars, "meaning" as a precise definition with $...$,
"note" saying how the sources differ and naming them (or null), "variants" listing the other meanings or spellings found, each with "where",
and "definition_fact_id", the id of a fact that defines it, or null. When two meanings both matter, give them two different symbols, for example
FS(X) including 0 and NS(X) for FS(X) without 0. Prefer the most common convention of the literature.
Aim for a short list, a few dozen entries at most: the notions that several facts or sources share and that readers could confuse.
Do not propose notation that is standard in the field and that every reader knows, nor the machinery of one paper's proofs, nor names of
variables. A notation local to one argument, such as $B \cup C$ written for a union where $\max B < \min C$, stays defined within its fact.
One notion written in several ways, such as FS(X), FS(H) and \mathrm{FS}(S), is one entry: list the other spellings in "variants", and
use "relation": "clash" when one of them means something else, for example when it includes 0.
Some notions are defined differently in different settings but are one general notion: an IP set or a full-match makes sense in any semigroup,
and papers define it in $(\mathbb{N}, +)$ for Hindman's theorem or in $(\mathrm{FIN}, \cup)$ for the finite union theorem. Propose its general
definition, for an arbitrary semigroup or structure, and list each setting in "variants" with "relation": "instance".
Use "relation": "clash" only for a variant that gives the symbol a genuinely different meaning.
Some terms are parametric: unambiguous once their setting is known, but with a different meaning in each setting. "homogeneous" differs for a
coloring of pairs, of triples, or of an IP set; "full-match" and "half-match" differ for Hindman's theorem and for the finite union theorem.
Give each setting its own entry, with the setting in parentheses in the "symbol" itself, for example "full-match (HT)" and "full-match (FUT)",
or "homogeneous (pairs)". Keep a plain "full-match" entry only for a general definition, valid in any semigroup. Explain the abbreviation
of the setting in "meaning". "notation" lists the entries already
proposed or agreed, with the members' "comments" on each: do not propose those symbols again, but use the comments to see what the team prefers. Propose at most 30 entries. People decide which entries the project adopts.
TXT,
        'notation_rephrase' => <<<'TXT'
TASK: write the fact in "fact" in task.json again in the project's agreed notation, listed in "notation".
The fact comes from a source with its own conventions: its "glossary" and the quotations in "sources" tell what its symbols mean there.
For each symbol, decide what it means in this fact. Rewrite it when the agreed notation gives that symbol another meaning, or writes this notion
with another symbol. The members' "comments" on an entry explain its use: follow them. An entry with "status": "local" is not a project symbol:
unfold it, or define it within the statement, for example "where $B \oplus C$ denotes $B \cup C$ with $\max B < \min C$".
An entry whose "variants" are instances is one general notion: a fact working in one of these settings keeps using it, without renaming it.
An entry whose name ends with a setting in parentheses, such as "full-match (HT)", is the meaning of the term in that setting. Use the entry of
the fact's setting. Write the qualified name, or the bare term when the fact stays in that one setting, and then say in "local_notation" which
entry the bare term stands for, for example "full-match" meaning "full-match (HT)".
The mathematical content must stay exactly the same: do not correct, strengthen or weaken anything, and do not add or
remove hypotheses or steps. If nothing has to change, set "unchanged" to true and copy the text. The fact must be readable alone: in "local_notation", define every symbol
of the rewritten fact that is not a project symbol, including the local entries you defined. In "uses", list each symbol whose meaning matters:
"symbol" as the fact writes it, "meaning_here", and "project_symbol", the agreed symbol now used. Fill "proof" only if the fact has a proof.
TXT,
        'source_check' => <<<'TXT'
TASK: "fact" in task.json is a cited result: a statement that the project takes from another work, without its proof.
Check whether its source really states it. "fact.references" names the work it is cited from, and "fact.sources" quote where the project found it.
When the folder has the text of the source (document.txt or paper.pdf), read it. Otherwise use web search to find the work and the result in it.
Answer in "verdict": "confirmed" if the work states this result, as written or in an equivalent form; "differs" if it states something
different, for example with other hypotheses, a weaker conclusion or another setting; "not_found" if you could not find the result in it,
or could not read the work. In "where", give the theorem number and page when you found it, or an empty string. In "explanation", say what the
work states, quoting it briefly, and how it differs when it does. You do not judge whether the result is true, only what the work says.
TXT,
        'consolidate' => <<<'TXT'
TASK: consolidate the facts database of this project. Facts were extracted one source at a time, so no extraction
saw the others. "fact_texts" in task.json lists every fact in short: its id, label, kind, title, statement, whether it has a proof, its source,
the ids it "depends_on", its "topics", its "status" and whether it is already "worth_reading". Read them all and propose, in "suggestions", the changes that only the whole database shows:
- "same": "fact" and "other_fact" state the same result, for example a theorem proved in one paper and cited in another. Put the fact to keep
  in "fact", usually the one with a proof, and the duplicate in "other_fact". Only when the statements are equivalent as written, not when one
  is a special case, a strengthening or a variant of the other.
- "depends": the proof of "fact" uses "other_fact", although this is not recorded, for example a result cited from another source.
- "kind": "fact" has the wrong kind; give the right one in "new_kind". A remark that states a result with a proof is a lemma or a proposition.
- "question": "fact" is a remark that asks a question that is still open, and is not a result. Give the question a short "title".
  Do not propose this for a remark that other facts depend on.
- "topics": free subject tags for "fact", in "topics", a few words each, such as the area, the method or the object studied. Reuse the tags of
  "topics" in task.json whenever they fit, so that the same subject has one name, and add a new tag only when none fits. Give each fact 1 to 4 tags.
- "cite": a proof must rely only on facts of the database. "basis" says whether a fact is "proved" (its proof is here) or "cited" (a result of
  another work, stated without proof). The "outside_refs" of a proved fact are references its proof still uses directly. For each one, give its
  "key" in "ref", and in "other_fact" the fact of the database that states the result the proof takes from it, usually a cited result.
  When there is none, leave "other_fact" null and write the result as a new cited result: a short "title", its full "statement" as the proof
  uses it, and "new_kind" (lemma, proposition, theorem or corollary). Write only what the reference is cited for, not more.
  A reference given only as background, that the proof does not use as a result, needs no proposal.
- "progress": "fact" is real progress that a member of the team should read: a new result on a question of the project, a key step
  of a proof, a surprising example or counterexample, a result that settles or reframes an approach. Most facts are routine
  steps written by AI: do not mark those. Say in "reason", in one sentence for a mathematician, why it matters. Mark at most 10
  facts per consolidation, the most important first, and never one with "worth_reading" already true.
- "notation": normalize the project's notation yourself, so that every fact can be written in one notation and people need not
  decide it. "notation" in task.json lists the entries already written, with their "status" and "decided_by"; "local_notation" lists
  the symbols that several facts define for themselves, with each meaning and the facts that give it. Fill the "notation" object:
  "action" "adopt" makes an entry the project's notation: name an entry that is still proposed in "entry", or leave "entry" null and
  write a new one ("symbol" in LaTeX without dollars, "meaning" as a precise definition with $...$, "note" saying how sources differ or
  an empty string, "variants" listing the other spellings and meanings found, each with "where" and "relation": "instance" for the same
  notion in a particular setting, "clash" for a different meaning). "local" keeps a proposed entry out of the project's notation: too
  specific, each fact defines it. "reject" sets aside a proposed entry that should not be used. In "fact", name a fact that defines or
  uses the symbol. One symbol per proposal, at most 30. Never propose a change to an entry whose "decided_by" is "person".
  When sources disagree, choose: the most common convention of the literature, and another symbol for a meaning that also matters,
  for example FS(X) including 0 and NS(X) without it. Do not leave notation to people: a wrong choice is cheap, it can be undone, and
  the facts are rewritten in it automatically while their reviewed text stays as it is. Adopt only notions that several facts or sources
  share or that readers could confuse, not the standard notation every reader knows, nor variables of one proof.
Name facts by their id or label. In "reason", say in one or two sentences why, quoting the statements when it helps.
"earlier_suggestions" lists proposals already waiting, or that people rejected or undid: never propose them again.
Give each change a "confidence". "high" means you checked it and are sure: for "same", the two statements are equivalent as written,
with the same hypotheses and conclusion; for "depends", the proof plainly uses the other fact; for "cite", the reference is used as you say.
A change of high confidence is applied at once, without a person, so that people only decide what needs their judgment: use "high" only
when a careful mathematician would not hesitate. Use "medium" or "low" whenever the statements differ in a detail, a hypothesis or a
setting, or when the decision matters for the project: people then decide. Every change can be undone, a merge included.
"notation" and "topics" changes are applied at "medium" too, since they change no result: use "low" only when you would rather people choose.
Propose at most 200 changes, the most useful first.
TXT,
    ];

    private const SCHEMAS = [
        'ask' => ["type" => 'object', "additionalProperties" => false, "required" => ['summary', 'reply'], "properties" => ["summary" => ["type" => 'string'], "reply" => ["type" => 'string']]],
        'notation_propose' => ["type" => 'object', "additionalProperties" => false, "required" => ['summary', 'entries'], "properties" => ["summary" => ["type" => 'string'], "entries" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['symbol', 'meaning', 'note', 'variants', 'definition_fact_id', 'facts'], "properties" => ["symbol" => ["type" => 'string'], "meaning" => ["type" => 'string'], "note" => ["type" => ['string', 'null']], "variants" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['symbol', 'meaning', 'where', 'relation'], "properties" => ["symbol" => ["type" => 'string'], "meaning" => ["type" => 'string'], "where" => ["type" => 'string'], "relation" => ["type" => 'string', "enum" => ['instance', 'clash']]]]], "definition_fact_id" => ["type" => ['integer', 'null']], "facts" => ["type" => 'array', "items" => ["type" => 'integer']]]]]]],
        'notation_rephrase' => ["type" => 'object', "additionalProperties" => false, "required" => ['summary', 'unchanged', 'statement', 'proof', 'local_notation', 'uses'], "properties" => ["summary" => ["type" => 'string'], "unchanged" => ["type" => 'boolean'], "statement" => ["type" => 'string'], "proof" => ["type" => ['string', 'null']], "local_notation" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['symbol', 'meaning'], "properties" => ["symbol" => ["type" => 'string'], "meaning" => ["type" => 'string']]]], "uses" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['symbol', 'meaning_here', 'project_symbol'], "properties" => ["symbol" => ["type" => 'string'], "meaning_here" => ["type" => 'string'], "project_symbol" => ["type" => 'string']]]]]],
        'consolidate' => ["type" => 'object', "additionalProperties" => false, "required" => ['summary', 'suggestions'], "properties" => ["summary" => ["type" => 'string'], "suggestions" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['kind', 'fact', 'other_fact', 'new_kind', 'title', 'topics', 'ref', 'statement', 'notation', 'reason', 'confidence'], "properties" => ["kind" => ["type" => 'string', "enum" => ['same', 'depends', 'kind', 'question', 'topics', 'cite', 'progress', 'notation']], "notation" => ["type" => ['object', 'null'], "additionalProperties" => false, "required" => ['action', 'entry', 'symbol', 'meaning', 'note', 'variants'], "properties" => ["action" => ["type" => 'string', "enum" => ['adopt', 'local', 'reject']], "entry" => ["type" => ['integer', 'null']], "symbol" => ["type" => ['string', 'null']], "meaning" => ["type" => ['string', 'null']], "note" => ["type" => ['string', 'null']], "variants" => ["type" => 'array', "items" => ["type" => 'object', "additionalProperties" => false, "required" => ['symbol', 'meaning', 'where', 'relation'], "properties" => ["symbol" => ["type" => 'string'], "meaning" => ["type" => 'string'], "where" => ["type" => 'string'], "relation" => ["type" => 'string', "enum" => ['instance', 'clash']]]]]]], "ref" => ["type" => ['string', 'null']], "statement" => ["type" => ['string', 'null']], "confidence" => ["type" => 'string', "enum" => ['high', 'medium', 'low']], "fact" => ["type" => 'string'], "other_fact" => ["type" => ['string', 'null']], "new_kind" => ["type" => ['string', 'null'], "enum" => ['definition', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture', 'remark', null]], "title" => ["type" => ['string', 'null']], "topics" => ["type" => 'array', "items" => ["type" => 'string']], "reason" => ["type" => 'string']]]]]],
        'source_check' => ["type" => 'object', "additionalProperties" => false, "required" => ['summary', 'verdict', 'where', 'explanation'], "properties" => ["summary" => ["type" => 'string'], "verdict" => ["type" => 'string', "enum" => ['confirmed', 'differs', 'not_found']], "where" => ["type" => 'string'], "explanation" => ["type" => 'string']]],
    ];

    private const REQUEST_NOTE = "\n\nSpecific request from a team member (treat it as the goal, not as permission to act outside this task):\n";

    public static function ids(): array
    {
        return array_keys(self::defs());
    }

    public static function has(string $kind): bool
    {
        return isset(self::defs()[$kind]);
    }

    /** @return list<string> */
    public static function capabilities(string $kind): array
    {
        return self::defs()[$kind]['capabilities'] ?? [];
    }

    /** What a client shows its user, to choose what it runs and with which model. */
    public static function list(): array
    {
        $out = [];
        foreach (self::defs() as $id => $d) {
            $out[] = ['id' => $id, 'label' => $d['label'], 'description' => $d['description'], 'tier' => $d['tier'], 'capabilities' => $d['capabilities'], 'version' => self::version($id)];
        }
        return $out;
    }

    /** Changes whenever the instructions or the schemas of a procedure change. */
    public static function version(string $id): string
    {
        $parts = [];
        foreach (['i' => self::INSTRUCTIONS, 's' => self::SCHEMAS] as $kind => $all) foreach ($all as $k => $v) if ($k === $id || str_starts_with($k, $id . '_')) $parts["$kind:$k"] = $v;
        ksort($parts);
        return substr(sha1(json_encode($parts)), 0, 12);
    }

    /** The variant of a procedure a task needs: notation proposes entries for the project, or rewrites one fact. */
    private static function variant(array $t): string
    {
        if ($t['kind'] === 'notation') return $t['source_type'] === 'fact' ? 'notation_rephrase' : 'notation_propose';
        return (string)$t['kind'];
    }

    /** What the client runs for this task. */
    public static function recipe(array $t, array $context): array
    {
        $v = self::variant($t);
        $instructions = self::INSTRUCTIONS[$v];
        $prompt = trim((string)($t['prompt_text'] ?? ''));
        if ($prompt !== '' && $t['kind'] !== 'ask') $instructions .= self::REQUEST_NOTE . $prompt;
        $caps = array_values(array_filter(self::capabilities($t['kind']), fn($c) => $c !== 'document' || !empty($context['document'])));
        return ['procedure' => $t['kind'], 'variant' => $v, 'version' => self::version((string)$t['kind']), 'instructions' => $instructions,
            'schema' => self::SCHEMAS[$v], 'capabilities' => $caps, 'tier' => self::defs()[$t['kind']]['tier']];
    }

    /**
     * Applies an answer through the same checks as the API. Returns what the task produced:
     * summary, and fact_ids, suggestion_ids or reply_text.
     */
    public static function apply(array $t, mixed $answer, ?string $model, mixed $seconds): array
    {
        $v = self::variant($t);
        $why = self::mismatch(self::SCHEMAS[$v], $answer, 'answer');
        if ($why !== null) throw new HttpError(422, "The answer does not follow the procedure's schema: $why.");
        $pid = (int)$t['project_id'];
        $said = trim((string)($answer['summary'] ?? ''));
        switch ($v) {
            case 'ask':
                if (trim((string)$answer['reply']) === '') throw new HttpError(422, 'The answer has no reply.');
                return ['summary' => $said, 'reply_text' => (string)$answer['reply']];
            case 'notation_rephrase':
                $fid = NotationController::rephraseFact(Request::internal(['ai_model' => $model, 'generation_seconds' => $seconds, 'unchanged' => (bool)$answer['unchanged'],
                    'local_notation' => $answer['local_notation'], 'statement_text' => $answer['statement'], 'proof_text' => (string)($answer['proof'] ?? ''), 'uses' => $answer['uses']], ['id' => (int)$t['source_id']]));
                $done = $answer['unchanged'] ? "Already in the project's notation." : "Written again in the project's notation.";
                return ['summary' => trim("$done $said"), 'fact_ids' => [$fid]];
            case 'notation_propose':
                $created = 0; $known = 0;
                foreach (array_slice($answer['entries'], 0, 30) as $e) {
                    $body = ['symbol' => $e['symbol'], 'meaning_text' => $e['meaning'], 'note_text' => (string)($e['note'] ?? ''), 'variants' => $e['variants'], 'ai_model' => $model];
                    if ($e['definition_fact_id']) $body['definition_fact_id'] = $e['definition_fact_id'];
                    if ($e['facts']) $body['facts'] = array_slice($e['facts'], 0, 200);
                    try { NotationController::propose(Request::internal($body, ['id' => $pid])); $created++; }
                    catch (HttpError $err) { if (!in_array($err->status, [409, 422], true)) throw $err; $known++; }
                }
                $n = $created === 1 ? 'y' : 'ies';
                return ['summary' => trim("$created notation entr$n proposed" . ($known ? ", $known set aside (already there or invalid)" : '') . ". $said")];
            case 'consolidate':
                $items = [];
                foreach (array_slice($answer['suggestions'], 0, 200) as $x) {
                    $items[] = array_filter(['kind' => $x['kind'], 'fact' => $x['fact'], 'other_fact' => $x['other_fact'], 'new_kind' => $x['new_kind'], 'title' => $x['title'],
                        'topics' => array_slice($x['topics'], 0, 8), 'ref' => $x['ref'], 'statement' => $x['statement'], 'notation' => $x['notation'] ?? null, 'reason' => $x['reason'], 'confidence' => $x['confidence']], fn($y) => $y !== null && $y !== []);
                }
                $r = ConsolidationController::store($pid, $items, $model, Provenance::stamp($model, $seconds), (int)$t['id']);
                $a = count($r['applied']); $c = count($r['created']) - $a; $s = count($r['skipped']);
                $done = ($a ? "$a change" . ($a === 1 ? '' : 's') . ' applied at once, ' : '') . "$c change" . ($c === 1 ? '' : 's') . ' proposed';
                return ['summary' => trim($done . ($s ? ", $s set aside (already proposed, rejected, undone or invalid)" : '') . ". $said")];
            case 'source_check':
                return self::recordSourceCheck($t, $answer, $model, $seconds);
        }
        throw new HttpError(422, 'Unknown procedure.');
    }

    /** What the AI found in the source of a cited result. It stays evidence: only a person accepts a cited result. */
    private static function recordSourceCheck(array $t, array $answer, ?string $model, mixed $seconds): array
    {
        $fid = (int)$t['source_id'];
        $f = Db::one('SELECT id, project_id, current_revision, label FROM facts WHERE id = ? AND deleted_at IS NULL', [$fid]);
        if (!$f || (int)$f['project_id'] !== (int)$t['project_id']) throw new HttpError(409, 'This fact is no longer in the database.');
        $text = trim((string)$answer['explanation']);
        if (trim((string)$answer['where']) !== '') $text .= "\n\nWhere: " . trim((string)$answer['where']);
        Db::insert('fact_source_checks', Provenance::stamp($model, $seconds) + ['fact_id' => $fid, 'revision_no' => (int)$f['current_revision'], 'verdict' => $answer['verdict'],
            'body_html' => $text !== '' ? Sanitizer::clean(Sanitizer::textToHtml($text, (int)$f['project_id']))['html'] : null, 'ai_model' => $model,
            'checked_by' => Auth::id(), 'task_id' => (int)$t['id'], 'created_at' => Db::now()]);
        Activity::touch((int)$f['project_id'], 'fact', $fid, 'updated');
        $said = ['confirmed' => 'The source states it', 'differs' => 'The source states something different', 'not_found' => 'The result was not found in the source'][$answer['verdict']];
        return ['summary' => trim("$said. " . trim((string)$answer['summary'])), 'fact_ids' => [$fid]];
    }

    /** Why a value does not follow a JSON schema (the subset the procedures use), or null. */
    public static function mismatch(mixed $schema, mixed $v, string $at): ?string
    {
        $schema = (array)$schema;
        $types = (array)($schema['type'] ?? []);
        $type = match (true) {
            $v === null => 'null', is_bool($v) => 'boolean', is_int($v) => 'integer', is_float($v) => 'number', is_string($v) => 'string',
            is_array($v) && array_is_list($v) && ($v !== [] || !in_array('object', $types, true)) => 'array', is_array($v) => 'object', default => 'unknown',
        };
        if ($types && !in_array($type, $types, true) && !($type === 'integer' && in_array('number', $types, true))) return "$at must be " . implode(' or ', $types);
        if (isset($schema['enum']) && !in_array($v, $schema['enum'], true)) return "$at has an unexpected value";
        if ($type === 'object') {
            $props = (array)($schema['properties'] ?? []);
            foreach ((array)($schema['required'] ?? []) as $k) if (!array_key_exists($k, $v)) return "$at.$k is missing";
            foreach ($v as $k => $x) {
                if (!isset($props[$k])) { if (($schema['additionalProperties'] ?? true) === false) return "$at.$k is not expected"; continue; }
                if ($why = self::mismatch($props[$k], $x, "$at.$k")) return $why;
            }
        }
        if ($type === 'array' && isset($schema['items'])) foreach ($v as $i => $x) if ($why = self::mismatch($schema['items'], $x, "{$at}[$i]")) return $why;
        return null;
    }
}
