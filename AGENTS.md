# Instructions for coding agents

Open Questions is a collaborative research platform in plain PHP 8.1+ and Vue 3, with no Composer and no build step.

## Definition of done for every feature

A new or changed feature is not finished until all of the following are part of the same change:

1. **Unit tests.** Add or update tests in `tests/*.test.mjs` for the new behavior, including its permission and failure cases. Keep logic testable by putting it in dependency-free modules where possible.
2. **Documentation.** Update `README.md` (features, configuration, layout) and any affected guide in `docs/`: `AGENT_API.md` for API changes, `BACKUP.md` for stored data, `DEPLOY.md` for deployment.
3. **Help center.** Add or update the articles in `public/assets/js/help/content.js`. Register new controllers in `CONTROLLER_HELP` and new menu views in `VIEW_HELP`. Add project-aware pointers in `src/Controllers/HelpController.php` when useful.
4. **References.** Every new kind of object must be citable in rich text: add it to `src/References.php` and `public/assets/js/references.js`, with a link that opens exactly that object and the correct visibility.
5. **Interface.** A new page or panel must use the structured components (`panel`, `kpi`, `pill`, `StackBar`, work lists, `SectionHome`) rather than plain text, and work at phone width.
6. **First-use tutorial.** A new menu area needs a step in `public/assets/js/help/tour-steps.js`. Update any step whose description has become wrong.

Tests catch a missing article or tour step, but not a stale explanation, so reread the affected text.

## Checks

Run before reporting a feature as done:

```bash
npm test
```

## Conventions

- Database changes go in `sql/schema.mysql.sql` for new installations, and in the idempotent migrations of `Db::install()` for existing ones.
- Every AI-generated item records its model, responsible user and, when measured, its generation time.
- Results returned to a user must respect visibility: conversations and their comments are limited to participants.
- Never commit `config/config.php`, `cache/`, databases, uploads, backups or tokens.
- Commit, push or deploy only when explicitly asked.
