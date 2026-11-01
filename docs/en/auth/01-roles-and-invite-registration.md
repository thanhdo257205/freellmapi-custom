# Roles, invite codes, and registration

**← [Domain overview](OVERVIEW.md)** · [Personal API keys →](02-user-api-keys.md)

How one FreeLLMAPI instance serves several named people: the `role` column on the account table, the granular `permissions` column on top of it, invite codes as the way in, and what each account is allowed to touch.

## The two roles

| | `admin` | `member` |
|---|---|---|
| Who gets it | The first account created on the install (dashboard setup), and every account that already existed when the RBAC migration ran ([server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts:19](../../../server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts#L19)) | Everyone created through invite registration, or through an approved `request-access` application; also the column default for any insert that omits `role` |
| Dashboard session | Yes | Yes |
| Dashboard navigation | Everything, plus an **Invites** page and a **Users** page ([client/src/App.tsx:272-282](../../../client/src/App.tsx#L272), routes at [`:527-529`](../../../client/src/App.tsx#L527)) | `/premium` always hidden; `/analytics` hidden unless `view_logs`; `/keys` hidden unless `manage_keys`, because that page reads `/api/health` and `/api/keys` and would otherwise be a wall of 403s ([`:274-278`](../../../client/src/App.tsx#L274)) — but see [Known gaps](#known-gaps): the nav is cosmetic, the server is the boundary |
| Provider keys, proxy settings, server logs + analytics, DB backups, self-update, invites, user accounts (`/api/admin/users`), health, free-tier, key-usage surfaces | Yes | **No — `403 { error: { type: 'forbidden' } }`** unless granted the matching permission |
| Models, fallback chain, profiles, cache, compression, premium, conversations | Yes | **Reads: yes.** `POST`/`PUT`/`PATCH`/`DELETE`: gated on `manage_settings` (or `manage_keys` for the modality catalogs), so a member cannot rewrite server-wide configuration |
| Own personal API keys (`/api/user/keys`) | Yes | Yes |

- Type and assignment: [`server/src/services/auth.ts:50`](../../../server/src/services/auth.ts#L50) — `UserRole = 'admin' | 'member'`, and `createUser` falls back to `admin` when the table is empty, `member` otherwise.
- On top of the role, `users.permissions` holds a JSON array of [`SYSTEM_PERMISSIONS`](../../../shared/user-access.ts#L3) — `manage_keys`, `manage_users`, `manage_invites`, `manage_requests`, `manage_settings`, `manage_backups`, `view_logs` — or the wildcard `'*'` ([`server/src/db/migrations/20261101_163500_custom_granular_rbac.ts`](../../../server/src/db/migrations/20261101_163500_custom_granular_rbac.ts)). [`parsePermissions`](../../../server/src/services/auth.ts#L40) and [`hasPermission`](../../../server/src/middleware/requirePermission.ts#L9) treat `role = 'admin'` and `is_primary` as holding everything, so the column only ever *adds* access for members; corrupt JSON fails closed to `[]`.
- `is_primary` marks the one account that cannot be demoted, signed out, or key-revoked by anyone. It is granted to the first **administrator** only — never to a member — and a repair migration ([`20261101_190500_custom_primary_admin_scope.ts`](../../../server/src/db/migrations/20261101_190500_custom_primary_admin_scope.ts)) clears it from installs where the earlier backfill keyed on row order instead of role ([server/src/services/auth.ts:65](../../../server/src/services/auth.ts#L65)).
- The role and the permissions travel with the session: [`verifyCredentials`](../../../server/src/services/auth.ts#L91) and [`validateSession`](../../../server/src/services/auth.ts#L124) re-read the `users` row on every request, so a revocation or a permission change bites on the target's next call without a re-login.
- Enforcement is [`requirePermission(permission)`](../../../server/src/middleware/requirePermission.ts#L21), installed over prefixes from the [`PERMISSION_GATES`](../../../server/src/custom/register.ts#L46) table by [`registerCustomRoutes`](../../../server/src/custom/register.ts#L87) ([server/src/app.ts:246](../../../server/src/app.ts#L246)). Each entry is `{ path, permission, methods? }`; `methods` narrows a gate to the state-changing verbs, and an entry without it gates reads too. (`requireAdmin` from the first version of this layer is still in the tree, but nothing imports it — grep for `requirePermission`.)
- The gates are registered **before** upstream mounts its own `/api/keys`, `/api/settings`, … lines, and the table lives entirely in fork code. That ordering is deliberate: an upstream commit that rewrites or reorders its `app.use` lines cannot silently remove a gate. (Gating the router objects themselves does **not** work — `router.use()` appends to a stack that is already populated at import time, so the routes answer first.) An authorized request therefore validates the session twice, one extra indexed `SELECT` per call.
- The gate list and its test copy are deliberately duplicated, not imported: see [Verification](#verification).
- Role is **not** added to upstream's auth responses. `GET /api/auth/status`, `POST /api/auth/login`, `GET /api/auth/me` and `POST /api/auth/setup` stay byte-identical to upstream; the fork exposes the same information — plus `isPrimary` and `permissions` — on `GET /api/user/session` ([server/src/routes/user-keys.ts:21](../../../server/src/routes/user-keys.ts#L21)).
- The dashboard reads that one endpoint and nothing else for access: [`useUserSession`](../../../client/src/custom/use-session.ts#L8) caches it and returns `isAdmin` / `isMember` / `hasPermission` ([`:20-21`](../../../client/src/custom/use-session.ts#L20)), which is what the nav filter, the Invites page, the Users page and the member key view branch on. Nothing in `client/` infers a role from the account list or the session token.

### Exact mount table

The upstream `createApp` body is untouched apart from the single `registerCustomRoutes(app)` call, so the two lists below are maintained in different places:

- `requireAuth` mounts: upstream's own lines in [server/src/app.ts:259-289](../../../server/src/app.ts#L259).
- Permission gating: the fork-only [`PERMISSION_GATES`](../../../server/src/custom/register.ts#L46) table plus the three fork-mounted admin routers in [`registerCustomRoutes`](../../../server/src/custom/register.ts#L87).

A request to a gated prefix runs the fork's `requireAuth` → `requirePermission('<permission>')` from [`installGate`](../../../server/src/custom/register.ts#L74), then hits upstream's `requireAuth` + router. "Full" means every method, reads included; "writes" means only `POST`/`PUT`/`PATCH`/`DELETE`, so `GET` stays open to any signed-in account.

| Permission | Gate | Prefix (upstream `app.use` line) | fork entry |
|---|---|---|---|
| `manage_keys` | full | `keys` [259](../../../server/src/app.ts#L259), `health` [279](../../../server/src/app.ts#L279), `free-tier` [280](../../../server/src/app.ts#L280), `fallback/rate-limit-usage` [273](../../../server/src/app.ts#L273) | [register.ts:47](../../../server/src/custom/register.ts#L47), [`:56-58`](../../../server/src/custom/register.ts#L56) |
| `manage_settings` | full | `client-profiles` [263](../../../server/src/app.ts#L263), `settings` [281](../../../server/src/app.ts#L281), `update` [289](../../../server/src/app.ts#L289) | [register.ts:48-50](../../../server/src/custom/register.ts#L48) |
| `manage_backups` | full | `backups` [286](../../../server/src/app.ts#L286) | [register.ts:51](../../../server/src/custom/register.ts#L51) |
| `view_logs` | full | `logs` [270](../../../server/src/app.ts#L270), `analytics` [278](../../../server/src/app.ts#L278), `fallback/token-usage` + `fallback/quota-forecast` [273](../../../server/src/app.ts#L273) | [register.ts:52](../../../server/src/custom/register.ts#L52), [`:59`](../../../server/src/custom/register.ts#L59) |
| `manage_settings` | writes | `profiles` [272](../../../server/src/app.ts#L272), `models` [271](../../../server/src/app.ts#L271), `fallback` [273](../../../server/src/app.ts#L273), `cache` [287](../../../server/src/app.ts#L287), `compression` [288](../../../server/src/app.ts#L288), `premium` [282](../../../server/src/app.ts#L282) | [register.ts:62-67](../../../server/src/custom/register.ts#L62) |
| `manage_keys` | writes | `embeddings` [274](../../../server/src/app.ts#L274), `media` [275](../../../server/src/app.ts#L275), `search` [276](../../../server/src/app.ts#L276), `decisions` [277](../../../server/src/app.ts#L277) | [register.ts:71](../../../server/src/custom/register.ts#L71) |
| `manage_invites` | full | `invites` — router mounted by the fork | [register.ts:96](../../../server/src/custom/register.ts#L96) |
| `manage_users` | full | `admin/users` — account list, role change, permissions, session and key revocation ([05](05-admin-user-management.md)) | [register.ts:97](../../../server/src/custom/register.ts#L97) |
| `manage_requests` | full | `admin/registration-requests` | [register.ts:98](../../../server/src/custom/register.ts#L98) |
| none (`requireAuth` only) | — | `conversations` [266](../../../server/src/app.ts#L266) | — |
| none (`requireAuth` only) | — | `user` (personal keys + `/session`), mounted by the fork | [register.ts:99](../../../server/src/custom/register.ts#L99) |
| no auth | — | `auth` — the fork mounts `externalAuthRouter` **then** `customAuthRouter` on the same path ([register.ts:95](../../../server/src/custom/register.ts#L95)), both *before* upstream's `authRouter` at [app.ts:251](../../../server/src/app.ts#L251), so fork paths win (`/google/*`, `/email/*` from the first, `/validate-invite` · `/register` from the second) and upstream's `/login`, `/status`, … still resolve normally. That chain is also how upstream's `/forgot-password` gets intercepted with a `410` — see [Recovery paths](#recovery-paths-behave-differently-than-youd-expect) | [register.ts:95](../../../server/src/custom/register.ts#L95) |

`/api/fallback` is in the table three times, and the order is what makes it work: the two narrower full gates (`rate-limit-usage`, `token-usage` / `quota-forecast`) are installed before the write-only `fallback` gate, so a member reading the chain gets through while `GET /api/fallback/token-usage` still answers `403`. `app.use` matches in registration order, which means a merge that re-sorts `PERMISSION_GATES` can silently widen a surface — [Verification](#verification) is what catches it.

`GET /api/keys/export` keeps its own tighter limiter ([app.ts:257](../../../server/src/app.ts#L257)) on top of the `manage_keys` gate.

## Invite codes

Codes live in the `invite_codes` table ([migration:26](../../../server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts#L26)) and are managed by [`server/src/services/invites.ts`](../../../server/src/services/invites.ts).

| Field | Behavior |
|---|---|
| `code` | `FLM-XXXXXX-XXXXXX` (two 3-byte hex segments, uppercase) when the admin omits it ([invites.ts:33](../../../server/src/services/invites.ts#L33)); a supplied code is trimmed, uppercased, and must be unique → duplicate is `409 code_exists`. Lookups compare upper-cased input, so codes are case-insensitive. |
| `max_uses` | Defaults to `1`; the route schema clamps to `1..1000`. |
| `expires_at_ms` | `expiresInDays` × 24h from creation, or `NULL` for never. |
| `used_count` | Incremented by one atomic `UPDATE` per successful registration. |
| `note` | Free text, max 255 chars. |
| `revoked` | Set by `DELETE /api/invites/:id`; never unset. |
| `status` | Computed at read time, not stored: `revoked` → `expired` → `exhausted` → `active` ([invites.ts:109](../../../server/src/services/invites.ts#L109)). |

`validateInviteCode` is a pure check ([invites.ts:144](../../../server/src/services/invites.ts#L144)); `claimInviteCode` is the state-changing step and carries the whole guard in one statement — `revoked = 0 AND used_count < max_uses AND (expires_at_ms IS NULL OR expires_at_ms > now)` — so two simultaneous registrations cannot both consume the last slot ([invites.ts:177](../../../server/src/services/invites.ts#L177)).

## Registration flow

`POST /api/auth/register` ([server/src/custom/auth.ts:83](../../../server/src/custom/auth.ts#L83)) is the only way a non-admin account comes into existence *directly*. There is no env flag that turns it off, and no open `signup` route. `POST /api/auth/request-access` ([`:49`](../../../server/src/custom/auth.ts#L49)) is the other entry: it stores a pending application that creates no account until an operator approves it through `/api/admin/registration-requests`.

The dashboard drives it from the same URL: `/?mode=register` or, better, `/?invite=CODE` opens the register form with the code pre-filled ([client/src/components/auth-gate.tsx:84](../../../client/src/components/auth-gate.tsx#L84)), and a successful submit stores the returned session token and shows the one-time `apiKey` ([`:131`](../../../client/src/components/auth-gate.tsx#L131)). Send an invite link in that form and the person never has to type a code. One client-side test covers that happy path — `/?invite=REVIEW` → `/api/auth/register` → secret shown once ([client/src/custom/user-access.test.tsx:369](../../../client/src/custom/user-access.test.tsx#L369)) — but nothing in `client/` exercises the failure branch, so the `400 invalid_invite_code` / `409 email_taken` answers are only under test server-side (see [Verification](#verification)).

```
1. validateInviteCode(code)         → 400 invalid_invite_code  (reason-specific message)
2. createUser(email, password, 'member')
                                    → 409 email_taken
3. claimInviteCode(code)            → increments used_count
4. mintUserApiKey(userId, 'Default Key')
                                    → sk-flm-… returned in the response body once
5. createSession(userId)            → 201 { token, email, role, apiKey }
```

```bash
# check a code without consuming it
curl -s "$BASE/api/auth/validate-invite?code=FLM-3F0A1C-9B7D2E"
# → { "valid": true, "inviteId": 4, "maxUses": 1, "usedCount": 0 }

curl -s -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"coder@example.com","password":"…","inviteCode":"FLM-3F0A1C-9B7D2E"}'
# → { "token": "…dashboard session…", "email": "coder@example.com",
#     "role": "member", "apiKey": "sk-flm-…" }
```

The `token` is an ordinary dashboard session (30-day TTL) used against `/api/*`; the `apiKey` is the personal inference key described in [02-user-api-keys.md](02-user-api-keys.md). The plaintext key is printed once — only its SHA-256 hash is stored.

### Invite management (admin, or anyone holding `manage_invites`)

| Method | Path | Body / effect |
|---|---|---|
| `GET` | `/api/invites` | — | `{ invites: [...] }`, newest first, with computed `status` and the creator's email |
| `POST` | `/api/invites` | `{ code?, maxUses?, expiresInDays?, note? }` | `201 { invite }`; random code when `code` is omitted |
| `DELETE` | `/api/invites/:id` | — | Sets `revoked = 1`. `404` when unknown or already revoked |

Revoking a code stops future registrations; it does **not** deactivate accounts that code already created. Drop a person's access by revoking their sessions and keys from the **Users** page, or by deleting their row outright (their `user_api_keys` cascade with it) — not by revoking an invite. Note that session revocation is a sign-out, not a lockout: the account can log back in with its password until it is deleted.

## Recovery paths behave differently than you'd expect

- **Two recovery mechanisms exist and they are not the same one.** `POST /api/auth/email/forgot-password` + `/email/reset-password` ([server/src/routes/external-auth.ts:68](../../../server/src/routes/external-auth.ts#L68), [`:84`](../../../server/src/routes/external-auth.ts#L84)) are **per-account**: the token is issued for the exact `users.email` row, bound to that account's password fingerprint, and expires in 15 minutes ([`services/email-recovery.ts:12`](../../../server/src/services/email-recovery.ts#L12), [`:8`](../../../server/src/services/email-recovery.ts#L8)), delivered through the operator's Gmail sender. This is the path a *member* uses, and it only answers when Gmail is configured — otherwise `503 not_configured`. Setup and validation live in [04-google-login-and-email-recovery.md](04-google-login-and-email-recovery.md). Upstream's `POST /api/auth/forgot-password` + `/reset-password` ([server/src/routes/auth.ts:366](../../../server/src/routes/auth.ts#L366), [:389](../../../server/src/routes/auth.ts#L389)) are still the **single-account** path — the code is minted for the *first* account and the reset writes to `SELECT … FROM users LIMIT 1`, then hands back a session for that user — so in a multi-user database they are an operator-recovery path, equivalent to admin access for anyone who can read the server log. `externalAuthRouter` now sits in front of them: unless `legacyResetAllowed` (which means no `PUBLIC_APP_URL` is set, or the desktop build is running), `POST /api/auth/forgot-password` answers **410 `email_recovery_required`** ([`external-auth.ts:94`](../../../server/src/routes/external-auth.ts#L94)).
- There is **no endpoint to delete an account, disable one, or reset another user's password** — those stay `sqlite3` / Turso statements. Roles, however, are now admin-editable: `PATCH /api/admin/users/:id/role` promotes and demotes in place, and `POST /api/admin/users/:id/revoke-sessions` / `…/revoke-keys` cut a person's current access without deleting anything ([05-admin-user-management.md](05-admin-user-management.md)).
- A member who forgets their password self-resets through the `/api/auth/email/*` routes above — but **only if the operator configured a Gmail sender**. With no sender, `503 not_configured` on the email routes plus `410` on upstream's (hosted) leaves a member with no recovery at all: `/api/auth/change-password` needs the current password, and no endpoint lets anyone else set it, so recovery means rewriting `users.password_hash` in the database. Decide whether to run email recovery *before* inviting people who might lose their password.

## Known gaps

Read these before relying on the model.

- **Gap: `/api/conversations` is instance-wide, not per-user.** It is `requireAuth` only, and transcripts have no owner column, so any signed-in account can list, open, rename and delete every other person's Playground history. A permission gate is the wrong fix — members must keep writing their own transcripts — so this needs a `user_id` migration plus an ownership filter in the router.
- **Gap: reads of shared configuration stay open.** The write-only gates mean a member can still read the model catalog, the fallback chain, cache/compression state, and the premium license status through `GET /api/models`, `/api/fallback`, `/api/cache`, `/api/compression`, `/api/premium`. That is deliberate (the member dashboard renders those to build the Playground's chain picker), but it does mean server-wide configuration is not secret from a member. Credential-shaped reads are *not* open: `/api/keys`, `/api/health`, `/api/free-tier`, and `/api/fallback/rate-limit-usage` are gated in full, because their payloads name provider keys or install-wide quota.
- **Gap: the claim result is not checked.** `register` ignores the boolean from `claimInviteCode` ([server/src/custom/auth.ts:117](../../../server/src/custom/auth.ts#L117)). If two requests race for the last slot, the loser still gets an account — the counter stays correct, the cap on *accounts* does not.
- **Gap: invite codes are not the only door.** `POST /api/auth/request-access` ([server/src/custom/auth.ts:49](../../../server/src/custom/auth.ts#L49)) lets anyone with no invite submit a *pending* registration application, which becomes an account only when an operator approves it through `/api/admin/registration-requests` (gated on `manage_requests`, [register.ts:98](../../../server/src/custom/register.ts#L98)); `customAuthRouter` also installs a `/login` pre-handler that answers `403 registration_pending` before upstream's login runs. So "invite codes are the only way in" is true only if nobody approves an application — and that path has no `max_uses` equivalent. Endpoints and caveats in [05 — The pending-approval queue](05-admin-user-management.md#the-pending-approval-queue-lives-on-this-page-too).
- **The dashboard UI is role-aware, but only cosmetically.** `client/src/custom/` ships the invite admin page ([InvitesPage.tsx:35](../../../client/src/custom/InvitesPage.tsx#L35) → `GET`/`POST`/`DELETE /api/invites`), the member key manager ([MemberKeysView.tsx:33](../../../client/src/custom/MemberKeysView.tsx#L33) → `/api/user/keys`), the account admin page ([UsersPage.tsx:14](../../../client/src/custom/UsersPage.tsx#L14) → `/api/admin/users`, see [05-admin-user-management.md](05-admin-user-management.md)), and an invite-gated register form reachable at `/?mode=register` or `/?invite=CODE` ([auth-gate.tsx:84](../../../client/src/components/auth-gate.tsx#L84), submit at [`:131`](../../../client/src/components/auth-gate.tsx#L131)). Hiding a nav item is **not** authorization, and the nav is narrower than the API: `/keys` disappears unless the account holds `manage_keys` ([client/src/App.tsx:277](../../../client/src/App.tsx#L277)), but the rest of the gated surface is simply not linked. Treat [`PERMISSION_GATES`](../../../server/src/custom/register.ts#L46) plus the fork's own `app.use` lines as the only source of truth, and remember the flip side — a member granted `manage_keys` sees the full admin Keys page, because the nav filter only branches on the permission, not on the role.
- **No per-user *cost* attribution.** Each account has an RPM cap and a monthly request count ([02](02-user-api-keys.md#what-is-enforced-and-where-the-edges-are)), but token usage is never recorded and Analytics still reports the instance as one tenant.

## Before exposing an instance

Upstream's advice is *"don't expose it to the internet"* ([architecture](../architecture/00-high-level-index.md#limitations)); invite-based access means breaking that advice on purpose. Minimum posture:

1. Serve it behind HTTPS with the host guard already in `app.ts` ([server/src/app.ts:116](../../../server/src/app.ts#L116)), and keep `ENCRYPTION_KEY` stable — provider keys are AES-256-GCM encrypted with it.
2. Leave the per-IP `/api` limiter on: default `600` requests/min, tuned with `ADMIN_RATE_LIMIT_RPM`, `0` disables ([server/src/middleware/rateLimit.ts:91](../../../server/src/middleware/rateLimit.ts#L91)). Login also has its own per-email lockout.
3. Mint invites with `maxUses: 1` and an `expiresInDays` value, and record who got which code in `note`.
4. Give each person their own `sk-flm-…` key rather than the unified key, so a leak is revocable in one call.
5. Decide the permission grants deliberately, not the nav. `/api/keys`, `/api/settings`, `/api/logs`, `/api/analytics`, `/api/backups`, `/api/update`, `/api/invites`, `/api/admin/users` and the shared-configuration writes are refused to a member by default — that is already the case, and the risk is the [Known gaps](#known-gaps), not the gated set. What you control is who you hand a permission to: `manage_keys` alone exposes the provider-key roster and lets the holder spend stored keys through `/api/health` and `/api/free-tier`; `manage_settings` rewrites server-wide routing, credentials for client profiles, and the premium license; `manage_users` is the path to every other grant, so treat it as admin-equivalent in practice even though [05](05-admin-user-management.md#how-a-delegate-is-limited) documents the containment rules around it.
6. Check the database's `is_primary` row before you rely on it: only the first *administrator* may hold it, and [`20261101_190500_custom_primary_admin_scope.ts`](../../../server/src/db/migrations/20261101_190500_custom_primary_admin_scope.ts) repairs installs where the original backfill keyed on row order. A member with `is_primary = 1` is unaccountable — `hasPermission` short-circuits to `true` for every permission.

## Verification

Four suites hold this domain in place; re-run with `npm run test -w server`.

- [`server/src/__tests__/services/user-keys-and-invites.test.ts`](../../../server/src/__tests__/services/user-keys-and-invites.test.ts) — invite-based registration plus the `403` assertion on the gated mounts, role round-trip through `validateSession`, key mint/revoke.
- [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) — the tripwire. It keeps **three frozen copies** of the gate table — `FULL_METHOD_GATES` (path → permission for every-method gates), `WRITE_METHOD_GATES` (path → method → permission), and `MEMBER_READABLE` (GETs a signed-in member must not be refused) — and drives them over HTTP instead of importing `PERMISSION_GATES`. The duplication is the point: a merge that shrinks or re-sorts [register.ts](../../../server/src/custom/register.ts#L46) while the app still boots turns this suite red rather than shipping a widened surface. It also asserts the custom migration is still registered, `customAuthRouter` still wins `/api/auth/register`, and `GET /api/user/session` reports role + permissions. Each refusal is checked for `error.type === 'forbidden'` *and* the permission name in the message, so a gate wired to the wrong constant fails too. Verified by mutation: commenting out the single `registerCustomRoutes(app)` line turns the suite red with `/api/keys must stay gated: expected 200 to be 403` and `404` on `/api/user/session` — the exact silent-failure mode the test exists to catch.
- [`server/src/__tests__/custom/admin-users.test.ts`](../../../server/src/__tests__/custom/admin-users.test.ts) — the account-administration routes, the self-edit lock, and the delegation containment rules; see [05-admin-user-management.md](05-admin-user-management.md#verification).
- [`server/src/__tests__/custom/primary-admin.test.ts`](../../../server/src/__tests__/custom/primary-admin.test.ts) and [`server/src/__tests__/db/migrate/primary-admin-scope.test.ts`](../../../server/src/__tests__/db/migrate/primary-admin-scope.test.ts) — the `is_primary` invariants: only an administrator can hold it, `createUser` never hands it to a member, and the repair migration both fixes damaged rows and round-trips back to the pre-migration state.
