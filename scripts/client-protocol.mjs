// Keeps track of the protocol between the platform and the AI clients (AGENTS.md, docs/DEPLOY.md).
//
//   npm run protocol                                   shows whether the protocol changed since the last decision
//   npm run protocol -- --compatible "reason"          records that clients already released still work
//   npm run protocol -- --breaking "reason"            records a break: older clients must update to the current VERSION
//
// A break needs a new client release first: raise VERSION in client/oq.py and client/desktop/package.json.
// The platform then refuses older clients with 426 (src/ClientProtocol.php), and they tell their user to update.
import fs from 'node:fs';
import path from 'node:path';
import { RECORD, clientVersion, compareProtocol, currentProtocol, newer, readRecord, serverMinimum, unreviewedMessage } from './lib/protocol.mjs';

process.chdir(path.resolve(import.meta.dirname, '..'));
const fail = (m) => { console.error(m); process.exit(1); };
const argv = process.argv.slice(2);
const mode = argv[0];
const note = argv.slice(1).join(' ').trim();
if (mode && !['--compatible', '--breaking', '--baseline'].includes(mode)) fail('Usage: npm run protocol -- [--compatible "reason" | --breaking "reason"]');
if (mode && note.length < 10) fail('Explain the decision in a few words, between quotes.');

const record = readRecord();
const current = currentProtocol();
const diff = compareProtocol(record, current);
const version = clientVersion();

if (!mode) {
  if (!record) fail(`No protocol record yet: ${RECORD}.`);
  console.log(`Client protocol: minimum client version ${record.min_version}, current client ${version}.`);
  if (diff.same) { console.log('No change since the last decision.'); process.exit(0); }
  fail(unreviewedMessage(diff));
}
if (mode === '--baseline' && record) fail('A record already exists: use --compatible or --breaking.');
if (mode !== '--baseline' && !record) fail('Record a baseline first.');
if (mode !== '--baseline' && diff.same) fail('The protocol did not change since the last decision: nothing to record.');

let minimum = record?.min_version ?? serverMinimum();
if (mode === '--breaking') {
  if (!newer(version, record.client_version)) fail(`Raise VERSION in client/oq.py first (now ${version}, the same as at the last decision). Older clients will have to update to it.`);
  minimum = version;
  const file = 'src/ClientProtocol.php';
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/const MIN_VERSION = '[^']+'/, `const MIN_VERSION = '${minimum}'`));
}
const entry = { date: new Date().toISOString().slice(0, 10), decision: mode.slice(2), client_version: version, min_version: minimum, note,
  changed: [...diff.changed, ...diff.added.map((k) => `+${k}`), ...diff.removed.map((k) => `-${k}`)].slice(0, 200) };
if (mode === '--baseline') entry.changed = [];
const out = { min_version: minimum, client_version: version, fingerprint: current.fingerprint, routes: current.routes, items: current.items, history: [...(record?.history || []), entry] };
fs.writeFileSync(RECORD, JSON.stringify(out, null, 1) + '\n');
console.log(`Recorded a ${entry.decision} decision. Minimum client version: ${minimum}.`);
if (mode === '--breaking') console.log('Before deploying: publish the new client (npm run deploy -- --installers, and a GitHub release), so that older clients can update.');
