// Fact titles written with formulas but no dollars render as formulas; prose is left alone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { bareTex } from '../public/assets/js/bare-tex.js';

test('bare formulas in titles become formulas, names upright, sets kept as braces', () => {
  assert.equal(bareTex('HT^{∃{a,b}}_2 with 2-apartness is equivalent to ACA_0'), '$\\mathsf{HT}^{∃\\{a,b\\}}_2$ with 2-apartness is equivalent to $\\mathsf{ACA}_0$');
  assert.equal(bareTex('Addition-like RT^f_2 has a computable instance with no Σ^0_2 solution'), 'Addition-like $\\mathsf{RT}^f_2$ has a computable instance with no $\\Sigma^0_2$ solution');
  assert.equal(bareTex("Countable Hindman's theorem is provable in ACA_0^+"), "Countable Hindman's theorem is provable in $\\mathsf{ACA}_0^+$");
  assert.equal(bareTex('and x_i and a_{n+1}'), 'and $x_i$ and $a_{n+1}$');
  assert.equal(bareTex("Hindman's theorem is provable in Pi^1_1-CA_0"), "Hindman's theorem is provable in $\\Pi^1_1$-$\\mathsf{CA}_0$", 'a Greek letter spelled out');
});

test('prose, and texts that already have their dollars, are left as they are', () => {
  for (const t of ['No bound on the size of half-matching sets', 'a snake_case word', '$\\lambda$regHT^{=n} as written', 'Hindman (1974)']) assert.equal(bareTex(t), t);
  assert.match(fs.readFileSync('public/assets/js/editor.js', 'utf8'), /bareTex\(/, 'every math text goes through it');
});
