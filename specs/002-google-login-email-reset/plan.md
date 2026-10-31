# Implementation Plan: Google sign-in and Gmail recovery
**Branch**: `codex/feat-google-login-email-reset` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

## Summary
Add standalone server services/router and React components. Use Google authorization code + PKCE and jose JWT verification. Use the Gmail REST API with a separate operator-authorized refresh token; Render Free blocks SMTP. Preserve upstream password auth and isolate hosted recovery.

## Technical Context
TypeScript, Node 20/22/24, Express 5, React, React Query, jose 6, existing AES-GCM helpers. SQLite and Turso synchronous Db interface. Vitest integration and UI tests; migration up/down/up tests. HTTPS on Render Free; localhost HTTP for development. Small invite-only deployment. Requests to Google have bounded timeouts; recovery acknowledgements do not await email delivery.

## Constitution Check
PASS before and after design: new timestamped migration only; existing public endpoints preserved; standalone custom modules; shared DTOs; encrypted temporary OAuth result payloads and hash-only reset tokens; no credential logging. Branch → PR → CI → merge. Credentials absent means integrations remain disabled, with explicit setup documentation.

## Project Structure
- server/src/services/{external-auth-config,auth-security,google-auth,gmail-mailer,email-recovery}.ts
- server/src/routes/external-auth.ts; custom/register.ts is the single route hook.
- server/src/db/migrations/20261101_020000_custom_external_auth.ts and registry entry.
- shared/external-auth.ts
- client/src/custom/{GoogleSignIn,EmailRecovery,ExternalAuthCallback}.tsx
- AuthGate: minimal hooks for buttons, recovery and callback views.
- server/src/__tests__/custom/external-auth.test.ts; client/src/custom/external-auth.test.tsx
- docs/en/auth/04-google-login-and-email-recovery.md

## Design
Only Google sub identifies a linked identity. Verify signature, RS256, issuer, audience, expiration, nonce, verified email and authoritative claims before auto-linking. Encrypt the attempt cookie; persist state hashes for one-time consumption. Exchange the result via a short-lived HttpOnly cookie and encrypted database payload; redirect contains no credentials. New identities claim invitations, create member accounts and mint a key atomically. Recovery uses random 256-bit token hashes, account fingerprint, 15-minute TTL, durable bounded rate limits, per-user invalidation and normal login after reset. Public acknowledgements return before delivery. Delivery failure removes the undelivered token and logs only a constant error. Expired temporary rows are purged during auth operations.
