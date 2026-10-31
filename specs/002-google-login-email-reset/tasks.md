# Tasks: Google sign-in and email recovery
## Phase 1: Setup
- [x] T001 Generate spec, plan, research, contracts and checklist in specs/002-google-login-email-reset/.
## Phase 2: Foundation
- [ ] T002 Add regression tests in server/src/__tests__/custom/external-auth.test.ts.
- [ ] T003 Add shared/external-auth.ts, external-auth-config.ts and auth-security.ts configuration and security helpers.
- [ ] T004 Add 20261101_020000_custom_external_auth.ts and migration registry entry.
## Phase 3: US1 Google login
- [ ] T005 [US1] Implement verified Google code flow and transactional identities/handoffs in server/src/services/google-auth.ts.
- [ ] T006 [US1] Add server/src/routes/external-auth.ts and custom/register.ts hook.
- [ ] T007 [US1] Add GoogleSignIn.tsx, ExternalAuthCallback.tsx and minimal AuthGate integration.
## Phase 4: US2 Recovery
- [ ] T008 [US2] Add Gmail HTTPS delivery in server/src/services/gmail-mailer.ts and account-specific email-recovery.ts.
- [ ] T009 [US2] Add EmailRecovery.tsx and email-link/forgot UI integration.
## Phase 5: US3 Operator setup
- [ ] T010 [US3] Write docs/en/auth/04-google-login-and-email-recovery.md and environment template.
## Phase 6: Validation and delivery
- [ ] T011 Add client/src/custom/external-auth.test.tsx, complete backend and migration tests, build/lint and full test suite.
- [ ] T012 Open PR, verify CI, merge to main and report activation prerequisites.

Dependencies: T001 → T002/T003/T004 → T005/T006 → T007. T003/T004 → T008 → T009. T010 follows contracts. T011 follows integration, T012 follows validation. Tests precede implementation. US1 and US2 are independently validated; no cross-agent source edits are needed. Implementation strategy: foundational security and storage, login, recovery, documentation, then CI/PR delivery.
