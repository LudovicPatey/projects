// An extraction says what each fact is (a result, an example, a counterexample, an obstacle), instead of calling every fact a
// conclusion, and each fact records its share of the time the extraction measured.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const CLIENT = path.resolve('client/oq.py');

test('the extraction asks for a label, and the client keeps it, or falls back to conclusion', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
props = oq.SCHEMAS["extract"]["properties"]["facts"]["items"]
task = {"id": 1, "kind": "derive", "context": {"facts": []}}
base = {"title": "T", "kind": "lemma", "statement": "S.", "proof": "P.", "quote": None, "page": None, "covers": None, "depends_on": [], "local_notation": []}
answer = {"facts": [dict(base, ref="a", label="counterexample"), dict(base, ref="b", label="gossip"), dict(base, ref="c")]}
items, dropped = oq.fact_items(task, answer, None)
print(json.dumps({"enum": props["properties"]["label"]["enum"], "required": "label" in props["required"], "labels": [i["labels"] for i in items],
  "rule": 'Give each fact a "label"' in oq.INSTRUCTIONS["extract"] and 'Give each fact a "label"' in oq.INSTRUCTIONS["extract_conversation"]}))
`, CLIENT], { encoding: 'utf8' });
  const r = JSON.parse(out.stdout || '{}');
  assert.deepEqual(r.enum, ['conclusion', 'example', 'counterexample', 'obstacle'], out.stderr);
  assert.equal(r.required, true); assert.equal(r.rule, true);
  assert.deepEqual(r.labels, [['counterexample'], ['conclusion'], ['conclusion']]);
});

test('each extracted fact records its share of the measured time', () => {
  const src = (n) => spawnSync('grep', ['-n', n, CLIENT], { encoding: 'utf8' }).stdout;
  assert.match(src('it\\["generation_seconds"\\] = round(seconds / len(items), 1)'), /generation_seconds/);
});

test('a dependency on a new fact with a long ref is kept, as Prove new facts wrote it (live fact 1494)', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
task = {"id": 591, "kind": "derive", "context": {"facts": [{"id": 1484, "label": "thm:old"}]}}
base = {"kind": "lemma", "statement": "S.", "proof": "P.", "quote": None, "page": None, "covers": None, "local_notation": []}
answer = {"facts": [
  dict(base, ref="lem:apart-refinement-with-divisibility", title="Apart refinement", depends_on=[]),
  dict(base, ref="lem:apart-refinement-with-divisibility-two", title="Another", depends_on=[]),
  dict(base, ref="lem:binary-support-pullback", title="Pullback", depends_on=["lem:apart-refinement-with-divisibility", "thm:old", "1484", "nowhere"])]}
items, dropped = oq.fact_items(task, answer, None)
print(json.dumps({"refs": [i["ref"] for i in items], "deps": items[2]["depends_on"], "ids": [i["external_id"] for i in items]}))
`, CLIENT], { encoding: 'utf8' });
  const r = JSON.parse(out.stdout || '{}');
  assert.equal(r.refs[0], 'lem:apart-refinement-with-divisibility', out.stderr);
  assert.deepEqual(r.deps, ['lem:apart-refinement-with-divisibility', 'thm:old', '1484'], 'the new fact, and existing ones by label or id');
  assert.equal(new Set(r.ids).size, 3, 'two refs that share their beginning keep different ids');
  assert.ok(r.ids.every((x) => x.length <= 64));
});
