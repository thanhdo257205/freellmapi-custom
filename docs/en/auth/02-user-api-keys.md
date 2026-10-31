# Personal API keys (`sk-flm-…`)

**← [Domain overview](OVERVIEW.md)** · [Roles and invites →](01-roles-and-invite-registration.md)

A third inference credential kind, added by this fork alongside upstream's unified key and the client-profile (`sk-cp-…`) key: one key per dashboard account, so several people can share a router without sharing one string.

Implementation: [`server/src/services/user-keys.ts`](../../../server/src/services/user-keys.ts) (storage) and [`server/src/routes/user-keys.ts`](../../../server/src/routes/user-keys.ts) (HTTP). Resolution happens in [`server/src/lib/system-prompt.ts:62`](../../../server/src/lib/system-prompt.ts#L62), inside `resolveAuth`.

## Format and storage

| | |
|---|---|
| Shape | `sk-flm-` + 48 lowercase hex chars (`crypto.randomBytes(24)`) — 55 chars total ([user-keys.ts:36](../../../server/src/services/user-keys.ts#L36)) |
| Stored | `key_hash` = SHA-256 of the full key, `UNIQUE`, indexed ([migration:44](../../../server/src/db/migrations/20261031_155642_custom_user_roles_and_keys.ts#L44)) |
| Shown | Once, in the mint response. Nothing recoverable is kept — the plaintext is never written. |
| Displayed later | `key_prefix` = first 11 chars + `…` + last 4, e.g. `sk-flm-3f0a…9b2e` ([user-keys.ts:39](../../../server/src/services/user-keys.ts#L39)) |
| Lookup | Hash the presented token and match `key_hash`; revoked rows return `null`, indistinguishable from an unknown key ([user-keys.ts:110](../../../server/src/services/user-keys.ts#L110)) |

Unlike provider keys, user keys are **hashed, not AES-256-GCM encrypted**: they are one-way credentials, so `ENCRYPTION_KEY` rotation does not affect them. The `encrypted_key` column in `user_api_keys` is declared but never written — treat it as reserved, and note that a DB dump therefore cannot re-export these keys either.

`user_id … ON DELETE CASCADE`: deleting an account removes its keys. `invite_codes.created_by` cascades the same way, so removing an admin orphans nothing but does erase who issued which invite.

## Endpoints

All of these are dashboard-session routes (`Authorization: Bearer <session token>` from `/api/auth/login`), scoped to the caller — a key is never valid on `/api/*` ([`requireAuth`](../../../server/src/middleware/requireAuth.ts) only accepts session tokens). Mounted at `/api/user` with `requireAuth` but **not** `requireAdmin` ([server/src/custom/register.ts:41](../../../server/src/custom/register.ts#L41)), so members manage their own keys.

| Method | Path | Effect |
|---|---|---|
| `GET` | `/api/user/session` | Caller's `{ email, role, userId }` ([server/src/routes/user-keys.ts:20](../../../server/src/routes/user-keys.ts#L20)) — the fork's way to read the role without touching upstream's `/api/auth/*` responses |
| `GET` | `/api/user/keys` | Caller's keys, newest first, with `revoked` and `lastUsedAt` |
| `POST` | `/api/user/keys` | `{ name? }` → `201 { key: { id, key, keyPrefix, name, createdAt } }`; plaintext appears only here |
| `DELETE` | `/api/user/keys/:id` | Sets `revoked = 1` for a key owned by the caller; `404` if it is another user's key or already revoked |

There is no endpoint that lists or revokes *another* user's keys, and no un-revoke.

`POST /api/auth/register` auto-mints one key named `Default Key` for the new member and prints it in the response body ([server/src/custom/auth.ts:23](../../../server/src/custom/auth.ts#L23)) — see [the registration flow](01-roles-and-invite-registration.md#registration-flow).

## Where a user key is accepted

`resolveAuth` returns `{ kind: 'user', userId, email, systemPrompt: null }`, so every surface that authenticates through it accepts these keys:

| Surface | Route | User key |
|---|---|---|
| `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, images / video / audio | [server/src/routes/proxy.ts:71](../../../server/src/routes/proxy.ts#L71) | ✅ |
| `/v1/responses` (Codex CLI) | [server/src/routes/responses.ts:692](../../../server/src/routes/responses.ts#L692) | ✅ |
| `/v1/messages` (Claude Code, Anthropic SDKs) | [server/src/routes/anthropic.ts:215](../../../server/src/routes/anthropic.ts#L215) | ✅ |
| `/v1beta` (Gemini CLI) | [server/src/routes/gemini.ts:58](../../../server/src/routes/gemini.ts#L58) | ✅ |
| `/v1/moderations` | [server/src/routes/moderation.ts:12](../../../server/src/routes/moderation.ts#L12) | ✅ |
| `/mcp` | [server/src/routes/mcp.ts:638](../../../server/src/routes/mcp.ts#L638) | ❌ unified key only |
| Ollama emulation | [server/src/routes/ollama.ts:56](../../../server/src/routes/ollama.ts#L56) | ❌ unified key only |
| `/v1/t/<token>` URL tokens | [server/src/routes/url-tokens.ts:32](../../../server/src/routes/url-tokens.ts#L32) | ❌ substitutes the unified key; the URL token is the credential |
| `/api/*` dashboard | [server/src/middleware/requireAuth.ts](../../../server/src/middleware/requireAuth.ts) | ❌ session token only |

Send it as `Authorization: Bearer …` or `x-api-key`; `x-goog-api-key` and Gemini's `?key=` also resolve ([extractApiToken](../../../server/src/routes/proxy.ts#L82)). Prefer headers — a key in a query string lands in shell history and proxy logs.

```bash
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $FLM_USER_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

A member's key routes through the same catalog, fallback chain, sticky sessions and provider pool as the unified key. It grants no model restriction, no chain restriction, and no separate spend view.

## What is not enforced

Verified against the current code — do not document or sell these as features:

- **`rpm_limit` is inert.** The column defaults to `60` and `validateUserApiKey` returns it, but no consumer reads it ([user-keys.ts:143](../../../server/src/services/user-keys.ts#L143)); `resolveAuth` drops it. The only real ceilings are the per-IP proxy limiter (`PROXY_RATE_LIMIT_RPM`, default 120) and the upstream providers' own quotas.
- **No per-user usage accounting.** `kind: 'user'` carries `userId` and `email`, and nothing downstream uses them, so Analytics still reports the instance as one tenant. Attribution by person currently means one instance per person, or reading `last_used_at`.
- **No expiry** on a key, and no way to scope one to a model or an endpoint.

## Cost of using one

Every authenticated inference request with a user key runs `SELECT` on `key_hash` **plus** a `UPDATE … last_used_at` write, best-effort and inside a `try`/`catch` that swallows lock and concurrency errors ([user-keys.ts:133](../../../server/src/services/user-keys.ts#L133)). On local SQLite that is negligible; on the hosted [Turso](../deployment/03-turso.md) driver, where each query is a blocking network round trip, it is two extra trips per request. `lastUsedAt` is therefore approximate — a lost write is silently ignored.

## Verification

[`server/src/__tests__/services/user-keys-and-invites.test.ts`](../../../server/src/__tests__/services/user-keys-and-invites.test.ts) covers mint → `validateUserApiKey` → `resolveAuth` (`kind: 'user'`) → revoke → `null`, and the ownership scoping. The persistence half (key still valid after reconnecting to a hosted database) is exercised by [`server/src/scripts/turso-smoke.ts`](../../../server/src/scripts/turso-smoke.ts) against a disposable Turso database.
