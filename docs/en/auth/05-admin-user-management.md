# Admin user management

Who is on this instance, what each account can reach, and how an operator takes access away. This is the dashboard page at `/users` plus the `/api/admin/users` surface behind it. It is fork-only — upstream has one operator and no reason to enumerate accounts.

Parent: [OVERVIEW.md](OVERVIEW.md) · Roles and the mount table: [01-roles-and-invite-registration.md](01-roles-and-invite-registration.md) · Personal keys: [02-user-api-keys.md](02-user-api-keys.md)

## Who can reach it

`/api/admin/users` is mounted as `requireAuth` → `requirePermission('manage_users')` → the router, all three in one fork line ([server/src/custom/register.ts:97](../../../server/src/custom/register.ts#L97)). A request therefore answers **401 `{ error: { type: 'authentication_error' } }`** with no or expired session, and **403 `{ error: { type: 'forbidden', message: "Permission denied: 'manage_users' access required." } }`** for a signed-in account that does not hold the grant — which means an admin, the primary account, and any member explicitly given `manage_users`. The `/users` nav entry and route are cosmetic ([client/src/App.tsx:282](../../../client/src/App.tsx#L282), route at [`:529`](../../../client/src/App.tsx#L529)): a member who types the URL gets the page shell and then the 403 surfaced as an error state. Nothing here widens or narrows what an account can do — the middleware chain is the only source of truth, and the gate is an argument on the fork's own mount line, where a merge cannot reorder it away without failing [the tripwire](01-roles-and-invite-registration.md#verification).

## Endpoints

All of these are dashboard-session routes (`Authorization: Bearer <session token>`); a personal `sk-flm-…` key does not authenticate them.

| Method | Path | Effect | Source |
|---|---|---|---|
| `GET` | `/api/admin/users` | `{ users: [...] }` — every account, oldest first, with `role`, `isPrimary`, `permissions`, `createdAt`, `activeKeys` (non-revoked personal keys), `sessions` (unexpired dashboard sessions) and `isSelf` | [routes/admin-users.ts:36](../../../server/src/routes/admin-users.ts#L36) |
| `PATCH` | `/api/admin/users/:id/role` | `{ role: 'admin' \| 'member' }` → `{ success, id, role }`. Promoting also writes `permissions = ["*"]`, demoting writes `[]` | [`:43`](../../../server/src/routes/admin-users.ts#L43) |
| `PUT` | `/api/admin/users/:id/permissions` | `{ permissions: [...] }` from `SYSTEM_PERMISSIONS` (or `'*'`) → `{ success, id, permissions }` | [`:90`](../../../server/src/routes/admin-users.ts#L90) |
| `POST` | `/api/admin/users/:id/revoke-sessions` | Deletes every session row of that account → `{ revoked: n }` | [`:133`](../../../server/src/routes/admin-users.ts#L133) |
| `POST` | `/api/admin/users/:id/revoke-keys` | Sets `revoked = 1` on that account's still-valid personal keys → `{ revoked: n }` | [`:152`](../../../server/src/routes/admin-users.ts#L152) |
| `GET` | `/api/admin/users/usage` | `?month=YYYY-MM` → every account's `{ requests, tokens, rpmLimit, keyPrefix, lastUsedAt }`, busiest first ([02](02-user-api-keys.md#what-is-enforced-and-where-the-edges-are)) | [`:171`](../../../server/src/routes/admin-users.ts#L171) |
| `PUT` | `/api/admin/users/:id/quota` | `{ rpmLimit: 1..1000 }` → `{ success, id, rpmLimit, updated }`, the per-user inference cap on `sk-flm-…` bearer traffic | [`:181`](../../../server/src/routes/admin-users.ts#L181) |

`listUsers` reports `permissions` as what the account *holds*, not what the column says: an admin or primary row comes back as `['*']` and corrupt JSON as `[]`, so the page and the server agree on the answer ([`grantedPermissions`](../../../server/src/services/users.ts#L19)).

Error `type` values: `invalid_user_id` (400, non-numeric or ≤ 0 `:id`), `invalid_role` / `invalid_permissions` / `invalid_quota` (400, schema), `user_not_found` (404, also on the two revoke routes and `quota` so an unknown id is never reported as a successful no-op), `self_role_change` and `self_permission_change` (409), `forbidden` (403, the `manage_users` middleware), `insufficient_privileges` (403, the service-level rules below), `primary_admin_protected` (403), `authentication_error` (401).

The list carries no secret material: `activeKeys` is a count, and the key rows themselves are only ever visible to their owner on `/api/user/keys`.

## Four invariants worth knowing before you click

**You cannot change your own role.** `setUserRole` rejects `userId === actorUserId` before touching the database ([server/src/services/users.ts:78](../../../server/src/services/users.ts#L78)), and the page renders that row's control disabled ([client/src/custom/UsersPage.tsx:325](../../../client/src/custom/UsersPage.tsx#L325)). This is what keeps *"at least one admin exists"* true without a counter: every allowed demotion is performed by an admin on **someone else**, so the actor is still an admin afterwards. There is no last-admin check because, given the self-lock, the last admin is always the caller.

**You cannot change your own permissions.** Same lock, same reasoning, one hop later: `setUserPermissions` refuses `userId === actorUserId` ([server/src/services/users.ts:130](../../../server/src/services/users.ts#L130)) with `409 self_permission_change`, before the actor lookup, so neither widening (self-escalation) nor narrowing (self-lockout) is reachable. A primary account editing its own grant hits this branch too — it is refused as *self*, not as *primary* — and its role and `isPrimary` come back unchanged. Unlike the role button, **the page offers the Permissions dialog on your own row** ([client/src/custom/UsersPage.tsx:312](../../../client/src/custom/UsersPage.tsx#L312)), so this server-side check is the only thing standing between a caller and their own lockout; [`PermissionsDialog`](../../../client/src/custom/PermissionsDialog.tsx) surfaces the `error.message` when it fires.

**The primary admin account is untouchable by anyone else.** `is_primary` blocks demotion, session revocation, key revocation, and permission edits with `403 primary_admin_protected` ([`setUserRole`:101](../../../server/src/services/users.ts#L101), [`setUserPermissions`:148](../../../server/src/services/users.ts#L148), [`revokeSessionsForUser`:190](../../../server/src/services/users.ts#L190), [`revokeApiKeysForUser`:204](../../../server/src/services/users.ts#L204)) — and because `hasPermission` short-circuits on `isPrimary`, that account holds every grant regardless of what the column says. Only the first *administrator* gets the flag; [01](01-roles-and-invite-registration.md#the-two-roles) covers the migration that repairs installs where the original backfill set it by row order instead.

**A role or permission change needs no re-login and no session revoke.** [`validateSession`](../../../server/src/services/auth.ts#L124) re-reads the `users` row — role, `is_primary`, and `permissions` ([`:136`](../../../server/src/services/auth.ts#L136)) — on every request, so a demoted or de-granted account hits `403` on its very next call, including while its existing token stays valid. Promotion works the same way in reverse.

`revoke-sessions` is the "sign them out of every device" button; sessions are rows hashed with SHA-256, so there is nothing to invalidate in place — they are deleted, and the person can sign in again with their password. `revoke-keys` is irreversible by design: only the hash is stored, so a revoked personal key can never be restored, only re-minted by that user.

## How a delegate is limited

`manage_users` is the one grant that can change other people's access, so `setUserPermissions` carries three more rules after the self- and primary-locks ([server/src/services/users.ts:161-184](../../../server/src/services/users.ts#L161)):

| Actor | Target / payload | Result |
|---|---|---|
| Admin or `is_primary` (holds `'*'`) | anything | written as given — including `[]`, which is how you take a grant away |
| A `manage_users` delegate | another **administrator** | `403 insufficient_privileges` — a delegate cannot rewrite admin access |
| A `manage_users` delegate | payload contains `'*'` | `403 insufficient_privileges` — full administrative access cannot be minted from below |
| A `manage_users` delegate | payload contains a permission the actor does not hold | `403 insufficient_privileges`, message names the offending grants |

The last row is the one that matters: containment means a delegate can only ever hand out a subset of its own access, so it cannot walk the instance from `manage_users` to `manage_keys` to `manage_backups` one victim at a time and end up indistinguishable from an admin. Note the asymmetry — **delegation does not extend to roles**: `setUserRole` requires the actor row to be `role = 'admin'` or `is_primary` ([`:88`](../../../server/src/services/users.ts#L88)), so a `manage_users` member can adjust granular grants but cannot promote or demote anyone, and gets `403 insufficient_privileges` for trying.

In practice still treat `manage_users` as near-admin: the delegate sees every account's email and usage, ends sessions, revokes personal keys, and can strip a member of *all* grants (including the one that lets them use the instance at all).

## The pending-approval queue lives on this page too

The **Users** page also renders `registration_requests`, the second way an account can appear. `POST /api/auth/request-access` ([server/src/custom/auth.ts:49](../../../server/src/custom/auth.ts#L49)) is unauthenticated: it stores `{ email, password_hash, note }` with `status = 'pending'` and creates **no** `users` row, and a matching pre-handler on `POST /api/auth/login` ([`:29`](../../../server/src/custom/auth.ts#L29)) answers `403 registration_pending` so the applicant cannot get a session while waiting.

| Method | Path | Effect | Source |
|---|---|---|---|
| `GET` | `/api/admin/registration-requests` | `{ requests: [...] }` — **pending only**, newest first | [routes/admin-registration-requests.ts:26](../../../server/src/routes/admin-registration-requests.ts#L26) |
| `POST` | `/api/admin/registration-requests/:id/approve` | Inserts the `users` row as `member`, mints a `Default Key`, marks approved, fires the notification mail | [`:32`](../../../server/src/routes/admin-registration-requests.ts#L32) |
| `POST` | `/api/admin/registration-requests/:id/reject` | Marks rejected; the row is kept | [`:57`](../../../server/src/routes/admin-registration-requests.ts#L57) |

`manage_requests` guards the whole prefix ([server/src/custom/register.ts:98](../../../server/src/custom/register.ts#L98)) — a *separate* grant from `manage_users`, so approving strangers and editing established accounts can be delegated to different people. Errors: `invalid_request_id` (400), `not_found` (404), `email_taken` (409, and note the request is still marked approved as it is no longer actionable), `invalid_status` (400, approving something already decided).

Three consequences worth knowing before you rely on this path:

- The approved account's first personal key is minted and **its plaintext is discarded** — [`approveRegistrationRequest`](../../../server/src/services/registration-requests.ts#L114) calls [`mintUserApiKey` without returning it](../../../server/src/services/registration-requests.ts#L151), and the HTTP response carries only `{ userId, email, role }`. The person has to sign in and mint their own key at `POST /api/user/keys`; that `Default Key` row is simply an unusable active key in the roster.
- Approval inserts the email **as submitted**, without `normalizeEmail` ([`:146`](../../../server/src/services/registration-requests.ts#L146)), so a mixed-case application can create a row that later logins do not match, and the `email_taken` check is a plain equality compare.
- `registration_requests` is in `EXCLUDED_TABLES` for database dumps ([server/src/services/backups.ts:81](../../../server/src/services/backups.ts#L81)), so pending applications — including their password hashes — do not travel with a backup.

## What this page deliberately does not do

- **Create an account.** Invite codes remain the only way a non-admin comes into existence *as an activated account* ([01 — Registration flow](01-roles-and-invite-registration.md#registration-flow)); `POST /api/auth/request-access` creates a *pending* request that an operator must approve. An admin-set password signup path would bypass the cap that `invite_codes.max_uses` enforces.
- **Delete an account.** No migration or FK audit for that exists yet, and `sessions`, `user_api_keys` and `invite_codes.created_by` all cascade — deleting a user would erase history an operator cannot rebuild. Revoking sessions and keys gets you the same *access* outcome with the audit trail intact.
- **Disable an account.** There is no `disabled` column on `users`; a soft ban would need a migration plus a check in `verifyCredentials` and `validateSession`, i.e. in the path every request takes. Not free, so not bundled here.
- **Settle money.** `GET /api/admin/users/usage` counts requests per month per account, and `PUT …/quota` caps them, but tokens are never recorded ([02](02-user-api-keys.md#what-is-enforced-and-where-the-edges-are)), the RPM window lives in process memory, and there is no billing. There is no spend figure per person to show.
- **Change another account's password or email.** Both are self-scoped in upstream's `routes/auth.ts`, and the fork kept them that way on purpose.

The server-wide configuration surfaces are no longer open to every signed-in account: writes to `/api/models`, `/api/profiles`, `/api/fallback`, `/api/cache`, `/api/compression` and `/api/premium` need `manage_settings`, writes to the modality catalogs need `manage_keys`, and `/api/keys`–`/api/health`–`/api/free-tier` are gated in full ([01 — Exact mount table](01-roles-and-invite-registration.md#exact-mount-table)). Promoting someone is therefore no longer the only lever, but neither is it the strongest one — grant the narrow permission instead.

## Verification

- [`server/src/__tests__/custom/admin-users.test.ts`](../../../server/src/__tests__/custom/admin-users.test.ts) — real app over HTTP, 11 cases: member 403 at the prefix; counts (including two sessions for one account after a second `createSession`); promote then demote observed through the target's own still-valid token; `self_role_change` 409 with the caller unchanged; bad id / bad role / unknown id; `revoke-keys` returning 2 then 0 and the owner's list showing everything revoked; `revoke-sessions` returning 2 and the target's next `/api/user/session` answering 401; the primary account protected against demotion, revocation **and** permission edits; a granular grant (`manage_keys`) visible in `/api/user/session` and reflected in what `/api/keys` answers while `/api/invites` and `/api/admin/users` stay 403; the delegate containment cases; the self-permission lock; and `view_logs` gating `/api/analytics/summary`.
- [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) — `/api/admin/users` and `/api/admin/registration-requests` are both entries in that suite's duplicated `FULL_METHOD_GATES`, so a merge that drops the `requirePermission('manage_users')` argument fails there too.
- [`client/src/custom/user-access.test.tsx`](../../../client/src/custom/user-access.test.tsx) — the `admin users page` block: `You` flag with the self role button present but `disabled`, the two-click arm→confirm PATCH hitting `/api/admin/users/2/role` with `{ role: 'admin' }` (and asserting **no** request on the first click), the email filter changing only what is rendered (no extra read), and a failed read showing `role="alert"` + Retry instead of an empty list. The permissions dialog, the quota prompt, and the pending-request approve/reject buttons have no client-side test; their behavior is pinned server-side.
- Mutation checks, each one run against the merged tree with the rest of the suite green (`11 passed` baseline):
  - delete the three delegate rules from `setUserPermissions` ([`users.ts:167-184`](../../../server/src/services/users.ts#L167)) → `prevents privilege escalation when a member has manage_users` fails with `expected 200 to be 403`, 1 failed / 10 passed.
  - delete the self-lock at [`users.ts:130`](../../../server/src/services/users.ts#L130) → `will not let the caller change their own permissions` fails with `expected 409 to be 403`; containment happens to refuse the widening request for a different reason, so the case pins the **code**, not merely "some refusal".
  - `registerCustomRoutes(app)` commented out in `app.ts` → the whole gate table goes red in `surface.test.ts` (`/api/keys must stay gated: expected 200 to be 403`) and `/api/user/session` returns 404.
- **The full server suite is only verifiable in CI, not on this Windows box.** Locally, `npm run test -w server` dies before printing a verdict: `--pool=forks` ends in `ERR_IPC_CHANNEL_CLOSED` and `--pool=threads` in SIGSEGV, both times inside an unrelated provider test with zero assertion failures beforehand; chunks of 28 files crash the same way. GitHub Actions (Linux, Node 20/22/24) is therefore the authoritative pass, and it is the only place the full server tree gets one. What was measured locally is the blast radius instead: the four suites that hold this domain — `custom/admin-users`, `custom/surface`, `custom/primary-admin`, `services/user-keys-and-invites` — 20 tests, plus the migration suites, the client suite, `test:migrations`, `npm run build` and the CI lint gate.
