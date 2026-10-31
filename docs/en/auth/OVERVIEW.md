# Multi-user access domain — Overview & File Index

This domain documents the role-based access layer this fork adds on top of upstream FreeLLMAPI: two dashboard roles (`admin` / `member`), invite-code-only registration, and per-user `sk-flm-…` inference keys. Upstream is deliberately single-user, so nothing here exists in [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi); these pages are the authoritative description of the custom behavior.

## File Index

| File | Scope |
|------|-------|
| [`01-roles-and-invite-registration.md`](01-roles-and-invite-registration.md) | The `users.role` column and how it is assigned, the invite-code lifecycle, `POST /api/auth/register`, and exactly which `/api/*` mounts each role reaches. |
| [`02-user-api-keys.md`](02-user-api-keys.md) | `sk-flm-…` personal keys: format, storage, mint/revoke endpoints, which surfaces accept them, and what is and is not enforced. |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain. |

## Where the fork's wiring lives

So that `git merge upstream/main` stays conflict-free, every HTTP piece of this domain is in fork-only files:

| File | Contents |
|------|----------|
| [`server/src/custom/register.ts`](../../../server/src/custom/register.ts) | `ADMIN_ONLY_PREFIXES`, the `requireAuth + requireAdmin` guard mount, and the `/api/auth` · `/api/invites` · `/api/user` mounts. |
| [`server/src/custom/auth.ts`](../../../server/src/custom/auth.ts) | `POST /api/auth/register` and `GET /api/auth/validate-invite`, kept out of upstream's `routes/auth.ts`. |
| [`server/src/routes/invites.ts`](../../../server/src/routes/invites.ts), [`server/src/routes/user-keys.ts`](../../../server/src/routes/user-keys.ts) | Fork-only routers. |
| [`server/src/middleware/requireAdmin.ts`](../../../server/src/middleware/requireAdmin.ts) | The gate itself. |
| [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) | Tripwire: fails if a merge drops the gate, a mount, or the custom migration registration. |

Upstream's [`server/src/app.ts`](../../../server/src/app.ts) carries two added lines (an import and one `registerCustomRoutes(app)` call) and its [`server/src/routes/auth.ts`](../../../server/src/routes/auth.ts) is byte-identical to `upstream/main`. The remaining upstream-file edits in this domain are additive and in low-churn files (`services/auth.ts`, `lib/system-prompt.ts`, `db/migrate/defaults.ts`). See [01 — Exact mount table](01-roles-and-invite-registration.md#exact-mount-table).

## Deviation from upstream

Two upstream statements no longer hold in this fork:

- [`../architecture/00-high-level-index.md`](../architecture/00-high-level-index.md) lists *"Per-user billing / multi-tenant auth — single-user by design"* under **Not yet supported**. Auth is now multi-user; **billing and per-user quota accounting are still not implemented**, so the sentence is only half true.
- The same page's *"Local-first. There's no multi-tenant auth. Run this for yourself; don't expose it to the internet."* The invite system exists precisely so one instance can serve several named people, which means the deployment is exposed. Read the [exposure checklist](01-roles-and-invite-registration.md#before-exposing-an-instance) before doing it.

Upstream's [`GLOSSARY.md`](../../../GLOSSARY.md), the unified key, and the client-profile (`sk-cp-…`) key are unchanged; a user key is a **third** credential kind next to those two.

## Navigation

- ← [Documentation root](../README.md)
- Deep-dives: [`01-roles-and-invite-registration.md`](01-roles-and-invite-registration.md), [`02-user-api-keys.md`](02-user-api-keys.md)

## Related

- [`../architecture/`](../architecture/) — the router and credential resolution that consumes these keys.
- [`../install/01-install.md`](../install/01-install.md) — first-user setup, password recovery, Docker deployment.
- [`../deployment/03-turso.md`](../deployment/03-turso.md) — hosted database mode, where accounts and invite codes survive a host replacement.
- [`../env/02-security-and-keys.md`](../env/02-security-and-keys.md) — `ENCRYPTION_KEY` and the encrypted provider-key store.
