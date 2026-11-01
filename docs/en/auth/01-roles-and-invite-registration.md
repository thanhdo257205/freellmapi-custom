# Roles, invite codes, and registration

**← [Domain overview](OVERVIEW.md)** · [Personal API keys →](02-user-api-keys.md)

How one FreeLLMAPI instance serves several named people: the `role` column on the account table, invite codes as the only way in, and what each role is allowed to touch.

## The two roles

| | `admin` | `member` |
|---|---|---|
| Who gets it | The first account created on the install (dashboard setup), and every account that already existed when the RBAC migration ran ([server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts:19](../../../server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts#L19)) | Everyone created through invite registration; also the column default for any insert that omits `role` |
| Dashboard session | Yes | Yes |
| Dashboard navigation | Everything, plus an **Invites** page and a **Users** page ([client/src/App.tsx:266-267](../../../client/src/App.tsx#L266), routes `:513` and `:514`) | `/analytics`, `/premium` and `/users` hidden; `/keys` renders the member's own key manager ([client/src/pages/KeysPage.tsx:40](../../../client/src/pages/KeysPage.tsx#L40)) |
| Provider keys, proxy settings, server logs, DB backups, self-update, invites, user accounts (`/api/admin/users`) | Yes | **No — `403 forbidden`** |
| Models, fallback chain, profiles, analytics, health, cache, compression, conversations, premium | Yes | Yes (see [Known gaps](#known-gaps)) |
| Own personal API keys (`/api/user/keys`) | Yes | Yes |

- Type and assignment: [`server/src/services/auth.ts:11`](../../../server/src/services/auth.ts#L11) declares `UserRole = 'admin' | 'member'`; [`createUser`](../../../server/src/services/auth.ts#L37) takes an optional role and falls back to `admin` when the table is empty, `member` otherwise.
- The role travels with the session: `verifyCredentials` and `validateSession` read `users.role`, so `req.user.role` is available to every gated route ([`server/src/services/auth.ts:54`](../../../server/src/services/auth.ts#L54), [`:85`](../../../server/src/services/auth.ts#L85)).
- Enforcement is one middleware, [`requireAdmin`](../../../server/src/middleware/requireAdmin.ts#L8), mounted as a **single app-level guard** over the admin-only prefixes ([server/src/custom/register.ts:38](../../../server/src/custom/register.ts#L38)), called from one added line in upstream's `createApp` ([server/src/app.ts:246](../../../server/src/app.ts#L246)). It answers `403` with `{ error: { type: 'forbidden' } }`.
- The guard is registered **before** upstream mounts its own `/api/keys`, `/api/settings`, … lines, and the `ADMIN_ONLY_PREFIXES` list ([server/src/custom/register.ts:22](../../../server/src/custom/register.ts#L22)) lives entirely in fork code. That ordering is deliberate: an upstream commit that rewrites or reorders its `app.use` lines cannot silently remove the gate. (Gating the router objects themselves does **not** work — `router.use()` appends to a stack that is already populated at import time, so the routes answer first.) An admin request therefore validates the session twice, one extra indexed `SELECT` per admin call.
- Role is **not** added to upstream's auth responses. `GET /api/auth/status`, `POST /api/auth/login`, `GET /api/auth/me` and `POST /api/auth/setup` stay byte-identical to upstream; the fork exposes the same information on `GET /api/user/session` → `{ email, role, userId }` ([server/src/routes/user-keys.ts:20](../../../server/src/routes/user-keys.ts#L20)).
- The dashboard reads that one endpoint and nothing else for role: [`useUserSession`](../../../client/src/custom/use-session.ts#L8) caches it and returns `isAdmin` / `isMember` ([`:20-21`](../../../client/src/custom/use-session.ts#L20)), which is what the nav filter, the Invites page and the member key view branch on. Nothing in `client/` infers a role from the account list or the session token.

### Exact mount table

The upstream `createApp` body is untouched apart from the single `registerCustomRoutes(app)` call, so the two lists below are maintained in different places:

- `requireAuth` mounts: upstream's own lines in [server/src/app.ts:259-289](../../../server/src/app.ts#L259).
- admin gating: the fork-only [`ADMIN_ONLY_PREFIXES`](../../../server/src/custom/register.ts#L22) array.

A request to an admin prefix runs `requireAuth` → `requireAdmin` from the guard at [register.ts:38](../../../server/src/custom/register.ts#L38), then hits upstream's `requireAuth` + router.

| Gate | Prefix | upstream `app.use` line |
|---|---|---|
| `requireAuth` + `requireAdmin` (guard) | `keys` [259](../../../server/src/app.ts#L259), `client-profiles` [263](../../../server/src/app.ts#L263), `logs` [270](../../../server/src/app.ts#L270), `settings` [281](../../../server/src/app.ts#L281), `backups` [286](../../../server/src/app.ts#L286), `update` [289](../../../server/src/app.ts#L289) | upstream lines, unmodified |
| `requireAuth` + `requireAdmin` (guard, mounted by the fork) | `invites` | [register.ts:43](../../../server/src/custom/register.ts#L43) |
| `requireAuth` + `requireAdmin` (guard, mounted by the fork) | `admin/users` — account list, role change, session and key revocation ([04](05-admin-user-management.md)) | [register.ts:44](../../../server/src/custom/register.ts#L44) |
| `requireAuth` only | `conversations` [266](../../../server/src/app.ts#L266), `models` [271](../../../server/src/app.ts#L271), `profiles` [272](../../../server/src/app.ts#L272), `fallback` [273](../../../server/src/app.ts#L273), `embeddings` [274](../../../server/src/app.ts#L274), `media` [275](../../../server/src/app.ts#L275), `search` [276](../../../server/src/app.ts#L276), `decisions` [277](../../../server/src/app.ts#L277), `analytics` [278](../../../server/src/app.ts#L278), `health` [279](../../../server/src/app.ts#L279), `free-tier` [280](../../../server/src/app.ts#L280), `premium` [282](../../../server/src/app.ts#L282), `cache` [287](../../../server/src/app.ts#L287), `compression` [288](../../../server/src/app.ts#L288) | upstream lines, unmodified |
| `requireAuth` only (mounted by the fork) | `user` (personal keys + `/session`) | [register.ts:45](../../../server/src/custom/register.ts#L45) |
| no auth | `auth` — the fork mounts `externalAuthRouter` **then** `customAuthRouter` on the same path ([register.ts:42](../../../server/src/custom/register.ts#L42)), both *before* upstream's `authRouter` at [app.ts:251](../../../server/src/app.ts#L251), so fork paths win (`/google/*`, `/email/*` from the first, `/validate-invite` · `/register` from the second) and upstream's `/login`, `/status`, … still resolve normally. That chain is also how upstream's `/forgot-password` gets intercepted with a `410` — see [Recovery paths](#recovery-paths-behave-differently-than-youd-expect) | [register.ts:42](../../../server/src/custom/register.ts#L42) |

`GET /api/keys/export` keeps its own tighter limiter ([app.ts:257](../../../server/src/app.ts#L257)) on top of the admin guard.

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

`POST /api/auth/register` ([server/src/custom/auth.ts:23](../../../server/src/custom/auth.ts#L23)) is the only way a non-admin account comes into existence. There is no env flag that turns it off, and no open `signup` route.

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

### Invite management (admin only)

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

- **Gap: member-write surfaces.** `/api/models`, `/api/profiles`, `/api/fallback`, `/api/cache`, `/api/compression`, `/api/premium` and `/api/conversations` are `requireAuth` only, and each has `POST`/`PUT`/`PATCH`/`DELETE` handlers. A member can therefore enable or disable catalog models, reorder the shared fallback chain, change global cache and compression settings, and replace the instance's premium license or open the billing portal (`/api/premium/key`, `/api/premium/portal`) — all of which affect every other user. `requireAdmin` currently protects the credential, settings, log, backup, update, invite and user-account surfaces only.
- **Gap: the claim result is not checked.** `register` ignores the boolean from `claimInviteCode` ([server/src/custom/auth.ts:57](../../../server/src/custom/auth.ts#L57)). If two requests race for the last slot, the loser still gets an account — the counter stays correct, the cap on *accounts* does not.
- **The dashboard UI is role-aware, but only cosmetically.** Since `30de3e2b`, `client/src/custom/` ships the invite admin page ([InvitesPage.tsx:35](../../../client/src/custom/InvitesPage.tsx#L35) → `GET`/`POST`/`DELETE /api/invites`), the member key manager ([MemberKeysView.tsx:33](../../../client/src/custom/MemberKeysView.tsx#L33) → `/api/user/keys`), the account admin page ([UsersPage.tsx:14](../../../client/src/custom/UsersPage.tsx#L14) → `/api/admin/users`, see [05-admin-user-management.md](05-admin-user-management.md)), and an invite-gated register form reachable at `/?mode=register` or `/?invite=CODE` ([auth-gate.tsx:84](../../../client/src/components/auth-gate.tsx#L84), submit at [`:131`](../../../client/src/components/auth-gate.tsx#L131)). Before that commit this page listed "no role-aware UI" as a gap; the UI exists now, and what replaced it is the caveat: hiding a nav item is **not** authorization. A member who calls `/api/models` or `/api/settings` directly still reaches whatever the server allows — the member-write gap above — so treat `ADMIN_ONLY_PREFIXES` as the only source of truth.
- **No per-user quota or usage attribution.** See [02-user-api-keys.md](02-user-api-keys.md#what-is-not-enforced).

## Before exposing an instance

Upstream's advice is *"don't expose it to the internet"* ([architecture](../architecture/00-high-level-index.md#limitations)); invite-based access means breaking that advice on purpose. Minimum posture:

1. Serve it behind HTTPS with the host guard already in `app.ts` ([server/src/app.ts:116](../../../server/src/app.ts#L116)), and keep `ENCRYPTION_KEY` stable — provider keys are AES-256-GCM encrypted with it.
2. Leave the per-IP `/api` limiter on: default `600` requests/min, tuned with `ADMIN_RATE_LIMIT_RPM`, `0` disables ([server/src/middleware/rateLimit.ts:91](../../../server/src/middleware/rateLimit.ts#L91)). Login also has its own per-email lockout.
3. Mint invites with `maxUses: 1` and an `expiresInDays` value, and record who got which code in `note`.
4. Give each person their own `sk-flm-…` key rather than the unified key, so a leak is revocable in one call.
5. Keep `/api/keys`, `/api/settings`, `/api/logs`, `/api/backups`, `/api/update`, `/api/invites` and `/api/admin/users` admin-only — that is already the case; the risk is the [Known gaps](#known-gaps), not the gated set.

## Verification

Three suites hold this domain in place; re-run with `npm run test -w server`.

- [`server/src/__tests__/services/user-keys-and-invites.test.ts`](../../../server/src/__tests__/services/user-keys-and-invites.test.ts) — invite-based registration plus the `403` assertion on admin mounts, role round-trip through `validateSession`, key mint/revoke.
- [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) — the tripwire. It asserts the custom migration is still registered, every `ADMIN_ONLY_PREFIXES` entry answers `403` to a member and not to an admin, `customAuthRouter` still wins the `/api/auth/register` path, and `GET /api/user/session` reports the role. If a future upstream merge drops a mount line or re-arranges `app.ts` so that the gate is bypassed, this test fails instead of shipping an unauthenticated admin surface. Verified by mutation: commenting out the single `registerCustomRoutes(app)` line turns the suite red with `/api/keys must stay admin-only: expected 200 to be 403` and `404` on `/api/user/session` — i.e. the exact silent-failure mode the test exists to catch.
- [`server/src/__tests__/custom/admin-users.test.ts`](../../../server/src/__tests__/custom/admin-users.test.ts) — the account-administration routes only; see [05-admin-user-management.md](05-admin-user-management.md#verification) for what each case pins down.
