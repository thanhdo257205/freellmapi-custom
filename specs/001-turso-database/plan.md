# Implementation Plan: Optional Turso database

**Date**: 2026-10-31 | **Spec**: [spec.md](spec.md)

## Summary

Keep SQLite as default. Add a synchronous libSQL adapter selected by FREEAPI_DB_DRIVER=turso. Validate a dedicated libsql URL, token and explicit encryption key. Use savepoints for nested transactions, suppress unsupported connection pragmas and guard raw-file backups.

## Technical Context

- TypeScript ESM on Node 20.18–24; libsql 0.5.29; existing Express and Vitest.
- Direct remote libSQL, not the separate beta TursoDB engine. Local SQLite unchanged.
- Test adapter contracts, full migrations, persistence and backup guards; optional remote smoke test.
- Windows development and Linux Render runtime.
- Experimental single-instance, low-traffic scope. Synchronous network calls block the event loop; measure before cutover.

## Constitution Check

PASS before and after design: dedicated adapter, tests and docs; narrow factory/backup hooks; no migration edits; existing auth changes preserved; explicit encryption key and sanitized driver errors; no endpoint changes. Run build, lint, full tests and migration checks.

## Project Structure

- server/src/db/turso.ts: configuration, adapter, transaction savepoints.
- server/src/db/index.ts: optional backend selection and remote filesystem bypass.
- server/src/lib/db-backup.ts: guard raw-file backup and restore.
- server/src/__tests__/db/turso.test.ts: adapter and migration contracts.
- server/src/scripts/turso-smoke.ts: disposable-database verification.
- docs/en/deployment/03-turso.md and .env.example: setup and migration.

## Complexity Tracking

Synchronous networking preserves the current contract but blocks Node's event loop. A broad async rewrite would conflict with the minimal-upstream-touch objective. No new business schema is needed.
