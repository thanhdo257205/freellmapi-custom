# Multi-user access domain — Overview & File Index

This domain documents the access layer this fork adds on top of upstream FreeLLMAPI: two dashboard roles (`admin` / `member`) with a granular `permissions` column on top of them, invite-code (or operator-approved) registration, per-user `sk-flm-…` inference keys with their own request quota, and the permission gates that decide what each `/api/*` surface accepts. Upstream is deliberately single-user, so nothing here exists in [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi); these pages are the authoritative description of the custom behavior.

## File Index

| File | Scope |
|------|-------|
| [`01-roles-and-invite-registration.md`](01-roles-and-invite-registration.md) | The `users.role` and `users.permissions` columns and how they are assigned, the invite-code lifecycle, `POST /api/auth/register`, and the exact `/api/*` mount table with the permission each gate demands. |
| [`02-user-api-keys.md`](02-user-api-keys.md) | `sk-flm-…` personal keys: format, storage, mint/revoke endpoints, which surfaces accept them, the per-user RPM limit and request counter, and what is and is not enforced. |
| [`03-user-key-storage-design.md`](03-user-key-storage-design.md) | **Proposed, not implemented:** user-owned provider-key storage, envelope encryption, tenant isolation, admin boundaries, migration and release criteria. |
| [`04-google-login-and-email-recovery.md`](04-google-login-and-email-recovery.md) | Google OAuth, operator Gmail sender setup, account-specific password recovery and deployment validation. |
| [`05-admin-user-management.md`](05-admin-user-management.md) | The `/users` admin page and `/api/admin/users`: listing accounts with key/session counts and grants, promote/demote, granular permissions, per-user quota, revoke sessions, revoke keys — plus the self-locks, the delegation containment rules, what each action does to a live session, and what the page refuses to do. |
| [`CHANGELOG.md`](CHANGELOG.md) | Doc revision history for this domain. |

## Where the fork's wiring lives

So that `git merge upstream/main` stays conflict-free, every HTTP piece of this domain is in fork-only files:

| File | Contents |
|------|----------|
| [`server/src/custom/register.ts`](../../../server/src/custom/register.ts) | `PERMISSION_GATES` + `WRITE_METHODS` and the `installGate` helper, then the `/api/auth` · `/api/invites` · `/api/admin/users` · `/api/admin/registration-requests` · `/api/user` mounts and the `/v1` user-key quota gate — everything the fork adds to the HTTP surface, in one file. |
| [`server/src/custom/auth.ts`](../../../server/src/custom/auth.ts) | `POST /api/auth/register`, `GET /api/auth/validate-invite`, `POST /api/auth/request-access`, and the `POST /api/auth/login` pre-handler that answers `403 registration_pending`, kept out of upstream's `routes/auth.ts`. |
| [`server/src/routes/invites.ts`](../../../server/src/routes/invites.ts), [`server/src/routes/user-keys.ts`](../../../server/src/routes/user-keys.ts), [`server/src/routes/admin-users.ts`](../../../server/src/routes/admin-users.ts), [`server/src/routes/admin-registration-requests.ts`](../../../server/src/routes/admin-registration-requests.ts) | Fork-only routers. |
| [`server/src/services/users.ts`](../../../server/src/services/users.ts) | Account enumeration and the admin-side role / permission / session / key mutations, including the self-locks and delegation containment, kept out of `services/auth.ts`. |
| [`server/src/middleware/requirePermission.ts`](../../../server/src/middleware/requirePermission.ts) | The gate itself: `hasPermission` (role, `is_primary`, `'*'`, then the list) and `requirePermission(permission)`. |
| [`server/src/middleware/user-rate-limit.ts`](../../../server/src/middleware/user-rate-limit.ts), [`server/src/services/user-quotas.ts`](../../../server/src/services/user-quotas.ts) | The `/v1` per-user RPM window and monthly request counter for `sk-flm-…` keys. |
| [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) | Tripwire: fails if a merge drops a gate, a mount, or the custom migration registration. |
| [`client/src/custom/`](../../../client/src/custom/) | Dashboard side: `use-session.ts` (the only reader of `/api/user/session`, and therefore of role *and* grants), `InvitesPage.tsx`, `MemberKeysView.tsx`, `UsersPage.tsx`, `PermissionsDialog.tsx`. The invite-gated register form is an edit inside upstream's `components/auth-gate.tsx` and `App.tsx`. |

Upstream's [`server/src/app.ts`](../../../server/src/app.ts) carries five added lines and no modified ones — the `registerCustomRoutes` import, its call, and the two comment lines plus the blank that document it (`git diff upstream/main -- server/src/app.ts` → `5 0`). Its [`server/src/routes/auth.ts`](../../../server/src/routes/auth.ts) is byte-identical to `upstream/main`. The remaining upstream-file edits in this domain are additive and in low-churn files (`services/auth.ts`, `lib/system-prompt.ts`, `db/migrate/defaults.ts`). See [01 — Exact mount table](01-roles-and-invite-registration.md#exact-mount-table).

## Deviation from upstream

Two upstream statements no longer hold in this fork:

- [`../architecture/00-high-level-index.md`](../architecture/00-high-level-index.md) lists *"Per-user billing / multi-tenant auth — single-user by design"* under **Not yet supported**. Auth is now multi-user, and each account has a request-count and an RPM cap ([02](02-user-api-keys.md#what-is-enforced-and-where-the-edges-are)); **billing is still not implemented** and no token usage is recorded, so the sentence is only half true.
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
