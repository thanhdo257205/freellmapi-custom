# Tasks: Optional Turso database

## Phase 1: Setup
- [x] T001 Inspect CLI, driver and upstream constraints; write specs/001-turso-database/research.md.
- [x] T002 Install libsql in server/package.json and package-lock.json.

## Phase 2: Foundation
- [x] T003 Add failing adapter and configuration tests in server/src/__tests__/db/turso.test.ts.

## Phase 3: US1 - Hosted persistence
- [x] T004 [US1] Implement strict configuration, adapter and nested transactions in server/src/db/turso.ts.
- [x] T005 [US1] Select the optional factory in server/src/db/index.ts without local filesystem operations.
- [x] T006 [US1] Verify full migrations and reconnect persistence in server/src/__tests__/db/turso.test.ts.

## Phase 4: US2 - Compatibility
- [x] T007 [US2] Guard raw-file backup/restore in server/src/lib/db-backup.ts and test those guards.
- [x] T008 [US2] Verify default SQLite and explicit factory overrides in server/src/__tests__/db/turso.test.ts.

## Phase 5: US3 - Isolated evaluation
- [x] T009 [P] [US3] Document env settings and Render transfer/rollback in .env.example and docs/en/deployment/03-turso.md.
- [x] T010 [US3] Add an opt-in disposable remote verification script in server/src/scripts/turso-smoke.ts.

## Phase 6: Validation
- [x] T011 Run build, lint, tests and migration checks; record results in specs/001-turso-database/validation.md.

## Dependencies and independent checks

T001–T003 precede US1; US2 builds on the adapter; US3 documentation can run alongside US2 after the contract is stable. US1 independently checks migrations/reconnect; US2 checks local selection and backup exclusion; US3 checks reproducible isolated setup. MVP is US1 plus safe local compatibility. Cloud smoke execution depends on account login and is reported separately from code completion.
