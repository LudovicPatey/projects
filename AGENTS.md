# Instructions for coding agents

Open Questions is a collaborative research platform in plain PHP 8.1+ and Vue 3, with no Composer and no build step.

## Definition of done for every feature

A new or changed feature is not finished until all of the following are part of the same change:

1. **Unit tests.** Add or update tests in `tests/*.test.mjs` for the new behavior, including its permission and failure cases. Keep logic testable by putting it in dependency-free modules where possible.
2. **Documentation.** Update `README.md` (features, configuration, layout) and any affected guide in `docs/`: `AGENT_API.md` for API changes, `BACKUP.md` for stored data, `DEPLOY.md` for deployment.
3. **Help center.** Add or update the articles in `public/assets/js/help/content.js`. Register new controllers in `CONTROLLER_HELP` and new menu views in `VIEW_HELP`. Add project-aware pointers in `src/Controllers/HelpController.php` when useful.
4. **References.** Every new kind of object must be citable in rich text: add it to `src/References.php` and `public/assets/js/references.js`, with a link that opens exactly that object and the correct visibility.
5. **Interface.** Follow `docs/INTERFACE.md`, the interface rules: every action says what it changes, what it leaves, how far it reaches and whether it can be undone; every piece of data says whether it waits for an AI pass or a person. A new page or panel must use the structured components (`panel`, `kpi`, `pill`, `StackBar`, work lists, `SectionHome`) rather than plain text, and work at phone width. Members do not know the interface: name each action without ambiguity, and say what it changes and what it leaves as it is, on hover and in its confirmation, and beside it when its reach is not obvious (the project notation page, "What each choice changes", is an example). Adding information to a page re-thinks the layout of what it joins (`docs/INTERFACE.md`, section 6): one structure with labelled parts, never one more block or color. Data that an AI pass is still due on says so where it is shown, with the `ai-pending` component (`Sweeps::pendingForFact`, `pendingItems`): which pass, what it will do, and what a person should do meanwhile, so that nobody takes it for final or fixes by hand what an AI is about to do. A new sweep adds its pass to `PENDING_PASSES` in `ai-model.js`.
6. **First-use tutorial.** A new menu area needs a step in `public/assets/js/help/tour-steps.js`. Update any step whose description has become wrong.
7. **Front page.** Decide whether the feature changes what the public should know, and update `public/assets/js/views/landing.js` when it does: its text, sections, screenshots and architecture. Remove any claim that has become wrong, and do not advertise what is not available yet. A new menu area must be declared in `FRONT_PAGE_COVERAGE`.
8. **Client protocol.** Run `npm run protocol` whenever the server changes. If what the AI client relies on changed, decide whether clients already released still work with it. Record `npm run protocol -- --compatible "why"`, or, when they would break, release a new client version first and record `npm run protocol -- --breaking "what breaks"`: the platform then refuses older clients and they ask their user to update. Tests and `npm run deploy` refuse an unrecorded change.

Tests catch a missing article, tour step or front-page decision, but not a stale explanation, so reread the affected text, including the front page.

## Checks

Run before reporting a feature as done:

```bash
npm test
```

**Visual check.** After any change to the interface, open each affected view in a browser at widths 1440, 1024, 800 and 375, including the dialogs it opens, and run `scripts/visual-audit.js` in the page (paste it in the console, or evaluate it from a test browser). It must return an empty list. It reports a page wider than the window, text squeezed letter by letter, controls off screen or spilling out of their column, dropdowns without the custom arrow or cutting their text, rows whose dropdown and buttons differ in height, menus opening outside the window, card footers whose controls wrap onto two lines or that do not line up across a row of cards, formulas KaTeX cannot read, dollars left in the text, and words set as one formula in italics. A change to how symbols or formulas are drawn is also checked against every symbol of a real project, with its types (`npm run audit:fetch`, then render each one as the page does and run the audit): a few examples are not enough. Then look at a screenshot at each width, with realistic data (long names and labels, every state a card or row can be in): the audit does not judge taste, and a test page with short texts hides what longer ones break. Use `select.sm` beside `btn sm`, and never set `background:` or a small right padding on a `select`.

**Procedures on real data.** A change to an AI procedure (its instructions, answer format or how the platform applies it) is also run with a real model on a copy of real data: `npm run audit:fetch`, then `npm run bench:procedures -- --export audit/<folder>`, and read its report. Tests with answers written by hand do not show what a model does with real facts.

**Audits.** When asked to audit a project, follow `docs/AUDIT.md`: besides the validity of the data, check its semantics (read the mathematics), the split of decisions between people and AI, the interface, missing features and obsolete ones.

## Conventions

- Database changes go in `sql/schema.mysql.sql` for new installations, and in the idempotent migrations of `Db::install()` for existing ones.
- Every AI-generated item records its model, responsible user and, when measured, its generation time.
- Results returned to a user must respect visibility: conversations and their comments are limited to participants.
- Never commit `config/config.php`, `cache/`, databases, uploads, backups or tokens.
- The platform never runs an AI model. AI work goes through the queue (`AiTaskController`) and the local client `client/oq.py`, which has no dependency and never gives its key to the AI process.
- When `client/oq.py` or `client/desktop` changes for users, raise `VERSION` in `client/oq.py` and the version in `client/desktop/package.json` together: clients detect updates from GitHub Releases and the platform. If a client needs new server features, also raise `API_LEVEL` in `client/oq.py` and `AiTaskController`. In the other direction, a server that older clients can no longer use raises the minimum client version with `npm run protocol -- --breaking`.
- The project is licensed under AGPL-3.0-only. Keep the source-code links visible, and check that any new dependency has a compatible license.
- Danus is followed at one commit (`third_party/danus/manifest.json`, equal to `DANUS_COMMIT` in `client/oq.py`). Run `npm run danus:upstream` to audit upstream changes before carrying them into the native prover (`PROVER_*`) or the Danus integration, then `-- --accept`.
- Commit, push or deploy only when explicitly asked.
