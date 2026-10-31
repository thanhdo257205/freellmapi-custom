# Multi-user access domain — Changelog

Doc revision history for `docs/en/auth/`, seeded from the commits that introduced the feature.

## 2026-11-01

- **Merging `origin/main` back in removed a second, duplicate gate.** `12aa82eb` had re-added `requireAdmin` inline on upstream's own mount lines in `app.ts` (eight references) after the Turso rollout silently dropped them. That mechanism and the `custom/register.ts` guard do the same job, so `app.ts` went back to upstream + 5 added lines and the guard is the single source of truth — the tripwire suite is what proves the gate still exists after deleting those inline arguments.

- **refactor(auth): move the fork's HTTP surface to `server/src/custom/`** — `POST /api/auth/register` + `GET /api/auth/validate-invite` moved from upstream's `routes/auth.ts` (now byte-identical to `upstream/main`) to [`server/src/custom/auth.ts`](../../../server/src/custom/auth.ts); admin gating, invite and user-key mounts moved to [`server/src/custom/register.ts`](../../../server/src/custom/register.ts), called from two added lines in `app.ts`. The `requireAdmin` guard is now an **app-level mount registered before** upstream's own `/api/keys` · `/api/settings` · … lines, because mutating the imported router singletons with `router.use()` appends the gate *after* the routes and silently never runs. New `GET /api/user/session` returns `{ email, role, userId }`, replacing the `role` fields the fork had injected into upstream's `/api/auth/status` · `/login` · `/me` · `/setup` responses.
- Docs updated to match: [01](01-roles-and-invite-registration.md) gained a rewritten **Exact mount table** and a `surface.test.ts` tripwire entry under *Verification*; [02](02-user-api-keys.md) lists `/api/user/session`; [OVERVIEW.md](OVERVIEW.md) gained *Where the fork's wiring lives*.
- **Behaviour unchanged for clients**, with one exception: `role` is no longer present on the four upstream auth responses — read `GET /api/user/session` instead. The tripwire was mutation-checked (commenting out `registerCustomRoutes(app)` makes `surface.test.ts` fail with `expected 200 to be 403`), and the full server suite is green: 385 files / 4775 tests.

## 2026-10-31

- **docs(auth): scaffold multi-user access domain** — new `docs/en/auth/` domain with `OVERVIEW.md` + `CHANGELOG.md`, `01-roles-and-invite-registration.md` (the `users.role` column, the `requireAdmin` mount table, invite-code lifecycle, `POST /api/auth/register`, recovery-path caveats, known gaps) and `02-user-api-keys.md` (`sk-flm-…` format and hashing, per-surface acceptance, what is not enforced). Documents commit `59caaeff`; no upstream page was rewritten, only [`../README.md`](../README.md) gained an index entry and [`../architecture/00-high-level-index.md`](../architecture/00-high-level-index.md) gained a deviation pointer.

## 2026-10-31 — Prerequisite history

- **59caaeff** feat(auth): implement multi-user RBAC, invite code system, and personal API keys in database
- **e4ed0886** fix(ci): update migration count assertion in legacy-baseline-rerun test, fix lint error, and add Turso support
- **554ac4d3** fix(turso): support remote migrations and verify deployment flows
