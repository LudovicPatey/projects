# Danus, as we follow it

[Danus](https://github.com/frenzymath/Danus) (Apache-2.0) is used in two ways:

- **The Danus integration** of the client (`oq.py danus`) installs Danus at one commit, `DANUS_COMMIT` in `client/oq.py`,
  changes it for macOS (`DANUS_MACOS_PATCH`), runs it on Claude (`DANUS_CLAUDE_ADAPTER`), and merges the project's facts
  into it (`DANUS_MERGE`).
- **The native prover** (`oq.py prove`, `docs/PROVER.md`) adapts its worker, verifier and lead instructions
  (`PROVER_*` in `client/oq.py`).

This folder keeps what lets us follow Danus as it improves:

| | |
|---|---|
| `manifest.json` | The repository, branch and commit we follow (always `DANUS_COMMIT`), every file the native prover adapts and where, and every file the integration depends on and how |
| `upstream/` | Those adapted files and the license, unchanged, at that commit |

## When Danus changes

```bash
npm run danus:upstream
```

It fetches Danus into `cache/danus-upstream` and reports, in `cache/danus-upstream-report.md`:

- the commits since the one we follow;
- the changes to each adapted file, and which instructions of the native prover it feeds;
- the changes to each file the integration depends on;
- whether the macOS patch still applies, and whether the merge still runs with Danus's own storage code, at the head.

It exits with code 2 when a check fails. `--branch main` compares with the branch whose lead agent runs on Claude Code.

After the audit:

1. Carry the improvements of the adapted files into `PROVER_*`, as text adapted to the platform (facts and notes of the
   platform, cited results, no shell).
2. Fix the integration if a check failed.
3. `npm run danus:upstream -- --accept` follows the new head: it updates `manifest.json`, `upstream/` and `DANUS_COMMIT`.
4. Raise the client version, and run `npm test`.

The files in `upstream/` are © their authors, under the Apache License 2.0 (`upstream/LICENSE`). The adapted instructions in
`client/oq.py` say where they come from.
