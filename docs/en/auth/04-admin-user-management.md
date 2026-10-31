# Admin user management

Who is on this instance, what each account can reach, and how an operator takes access away. This is the dashboard page at `/users` plus the `/api/admin/users` surface behind it. It is fork-only — upstream has one operator and no reason to enumerate accounts.

Parent: [OVERVIEW.md](OVERVIEW.md) · Roles and the mount table: [01-roles-and-invite-registration.md](01-roles-and-invite-registration.md) · Personal keys: [02-user-api-keys.md](02-user-api-keys.md)

## Who can reach it

`/api/admin/users` is listed in `ADMIN_ONLY_PREFIXES` ([server/src/custom/register.ts:29](../../../server/src/custom/register.ts#L29)), so the app-level guard ([`:37`](../../../server/src/custom/register.ts#L37)) answers **401** for no session and **403 `{ error: { type: 'forbidden' } }`** for a member session before the router at [`:43`](../../../server/src/custom/register.ts#L43) is consulted. The `/users` nav entry and route are cosmetic (`client/src/App.tsx:267`, `:514`): a member who types the URL gets the page shell and then the 403 surfaced as an error state. Nothing here widens or narrows what a role can do — the prefix list is still the only source of truth.

## Endpoints

All four are dashboard-session routes (`Authorization: Bearer <session token>`); a personal `sk-flm-…` key does not authenticate them.

| Method | Path | Effect | Source |
|---|---|---|---|
| `GET` | `/api/admin/users` | `{ users: [...] }` — every account, oldest first, with `role`, `createdAt`, `activeKeys` (non-revoked personal keys), `sessions` (unexpired dashboard sessions) and `isSelf` | [routes/admin-users.ts:32](../../../server/src/routes/admin-users.ts#L32) |
| `PATCH` | `/api/admin/users/:id/role` | `{ role: 'admin' \| 'member' }` → `{ success, id, role }` | [`:39`](../../../server/src/routes/admin-users.ts#L39) |
| `POST` | `/api/admin/users/:id/revoke-sessions` | Deletes every session row of that account → `{ revoked: n }` | [`:70`](../../../server/src/routes/admin-users.ts#L70) |
| `POST` | `/api/admin/users/:id/revoke-keys` | Sets `revoked = 1` on that account's still-valid personal keys → `{ revoked: n }` | [`:81`](../../../server/src/routes/admin-users.ts#L81) |

Error `type` values: `invalid_user_id` (400, non-numeric or ≤ 0 `:id`), `invalid_role` (400, anything other than `admin`/`member`), `user_not_found` (404, also on the two revoke routes so an unknown id is never reported as a successful no-op), `self_role_change` (409), `forbidden` (403, the guard), `authentication_error` (401).

The list carries no secret material: `activeKeys` is a count, and the key rows themselves are only ever visible to their owner on `/api/user/keys`.

## Two invariants worth knowing before you click

**You cannot change your own role.** `setUserRole` rejects `userId === actorUserId` before touching the database ([server/src/services/users.ts:52](../../../server/src/services/users.ts#L52)), and the page renders that row's control disabled ([client/src/custom/UsersPage.tsx:144](../../../client/src/custom/UsersPage.tsx#L144)). This is what keeps *"at least one admin exists"* true without a counter: every allowed demotion is performed by an admin on **someone else**, so the actor is still an admin afterwards. There is no last-admin check because, given the self-lock, the last admin is always the caller.

**A role change needs no re-login and no session revoke.** `validateSession` reads `role` through a join on `users` for every request ([server/src/services/auth.ts:90](../../../server/src/services/auth.ts#L90)), so a demoted account hits `403` on the admin prefixes on its very next call — including while its existing token stays valid. Promotion works the same way in reverse.

`revoke-sessions` is the "sign them out of every device" button; sessions are rows hashed with SHA-256, so there is nothing to invalidate in place — they are deleted, and the person can sign in again with their password. `revoke-keys` is irreversible by design: only the hash is stored, so a revoked personal key can never be restored, only re-minted by that user.

## What this page deliberately does not do

- **Create an account.** Invite codes remain the only way a non-admin comes into existence ([01 — Registration flow](01-roles-and-invite-registration.md#registration-flow)). An admin-set password signup path would bypass the cap that `invite_codes.max_uses` enforces.
- **Delete an account.** No migration or FK audit for that exists yet, and `sessions`, `user_api_keys` and `invite_codes.created_by` all cascade — deleting a user would erase history an operator cannot rebuild. Revoking sessions and keys gets you the same *access* outcome with the audit trail intact.
- **Disable an account.** There is no `disabled` column on `users`; a soft ban would need a migration plus a check in `verifyCredentials` and `validateSession`, i.e. in the path every request takes. Not free, so not bundled here.
- **Per-user quota or usage attribution.** Still unimplemented; see [02 — What is not enforced](02-user-api-keys.md#what-is-not-enforced).
- **Change another account's password or email.** Both are self-scoped in upstream's `routes/auth.ts`, and the fork kept them that way on purpose.

Member-write surfaces (`/api/models`, `/api/profiles`, `/api/fallback`, `/api/cache`, `/api/compression`, `/api/premium`, `/api/conversations`) are still not admin-gated, so promoting is not the only way to gain influence — see the gap list in [01](01-roles-and-invite-registration.md#known-gaps).

## Verification

- [`server/src/__tests__/custom/admin-users.test.ts`](../../../server/src/__tests__/custom/admin-users.test.ts) — real app over HTTP: member 403; counts (including two sessions for one account after a second `createSession`); promote then demote observed through the target's own still-valid token; `self_role_change` 409 with the caller unchanged; bad id / bad role / unknown id; `revoke-keys` returning 2 then 0 and the owner's list showing everything revoked; `revoke-sessions` returning 2 and the target's next `/api/user/session` answering 401.
- [`server/src/__tests__/custom/surface.test.ts`](../../../server/src/__tests__/custom/surface.test.ts) — `/api/admin/users` is in that suite's duplicated prefix list, so a merge that drops the guard fails there too.
- [`client/src/custom/user-access.test.tsx`](../../../client/src/custom/user-access.test.tsx) — the `admin users page` block: `You` flag with the self action disabled, the two-click arm→confirm PATCH hitting `/api/admin/users/2/role` with `{ role: 'admin' }` (and asserting **no** request on the first click), the email filter changing only what is rendered (no extra read), and a failed read showing `role="alert"` + Retry instead of an empty list.
- Mutation check, run against this branch: commenting out `app.use(ADMIN_ONLY_PREFIXES, requireAuth, requireAdmin)` in `registerCustomRoutes` gives **3 failures across both files** — `surface.test.ts` aborts its prefix loop at the first entry (`/api/keys must stay admin-only: expected 200 to be 403`), and `admin-users.test.ts` loses both `refuses a member session at the prefix` and `promotes and demotes with the effect visible on the target next request` with `expected 200 to be 403`. Restoring the one line returns both files to `11 passed`. The second failure is the one that matters most: the router itself is mounted with `requireAuth` only ([server/src/custom/register.ts:43](../../../server/src/custom/register.ts#L43)), so without the guard a member can reach `PATCH /api/admin/users/:id/role` and promote their own account. The page's access-control story is the guard, not the disabled button.
- **The full server suite is only verifiable in CI, not on this Windows box.** Locally, `npm run test -w server` dies before printing a verdict: `--pool=forks` ends in `ERR_IPC_CHANNEL_CLOSED` and `--pool=threads` in SIGSEGV, both times inside an unrelated provider test with zero assertion failures beforehand; chunks of 28 files crash the same way. GitHub Actions (Linux, Node 20/22/24) is therefore the authoritative pass — 387 server files, 57 client files and 7 cli files, all green on the commit that introduced this page. What was verified locally is the blast radius instead: the 6 files that read `registerCustomRoutes` / `ADMIN_ONLY_PREFIXES` / `validateSession` / invite claiming (35 tests), plus the client suite and `test:migrations`.
