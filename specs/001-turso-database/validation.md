# Validation — 2026-10-31

## Passed

- npm run build (server, CLI, client); server rebuilt after adapter and smoke changes.
- npm run lint (server and CLI); git diff --check.
- Adapter tests: 13 passed, including named bindings, reserved staging tables, nested rollback, full reversible migration down/up and local compatibility.
- Focused database/migration/backup/auth suite: 18 files, 84 passed, 3 skipped.
- npm run test:migrations: 3 passed.
- Client: 56 files, 436 tests passed; i18n validation passed for 60 locales.
- Isolated real Turso database freellmapi-trial in the existing default group. The existing exe-webapp database was not modified.
- Real cloud migrations; account/password verification, session, invitation and personal API-key persistence after reconnect; rollback; encrypted value persisted and decrypted after reconnect.
- HTTP /livez and /api/ping return 200; /readyz returns expected 503/no_upstreams_configured for the empty trial; dashboard login, personal key list and personal-key /v1/models return 200. No LLM provider inference was invoked.
- Warm initialization: 709–737 ms. SELECT round trips usually 133–145 ms; one sample 292 ms. Initial pending migrations on cloud took about 30 seconds in the last migration pass; these numbers do not represent a production load test.

## Limitations observed

- npm test was attempted twice; the Windows Vitest fork pool stopped with ERR_IPC_CHANNEL_CLOSED at different server suites and did not finish. A separately rerun proxy-cache suite passed all 19 tests. Do not claim the complete server suite passed.
- CLI tests: 178 passed, one failed in src/detect.test.ts because a Unix expected /opt/tools/bin/codex path was normalized to Windows backslashes. No CLI source was changed for Turso.
- The Windows native libSQL driver emitted a shutdown warning about an unavailable runtime after closing a remote stream. Cloud persistence and HTTP checks completed successfully.
- Remote operations are synchronous and block the Node event loop. This is an opt-in experiment for modest traffic; Render-region latency, concurrent traffic and actual LLM inference remain unmeasured.

## Local configuration and deployment state

- Private .env.turso contains only the dedicated trial URL, a database-scoped token valid for seven days and a newly generated trial encryption key. It is ignored by Git, excluded from Docker builds and restricted to the file owner.
- The existing .env and Render deployment were not changed by this work. Existing production data was not uploaded. Do not use the trial encryption key with the production snapshot.
- The repository received commits from another session while this work was running; those commits incorporated intermediate Turso files. Final compatibility fixes and verification artifacts remain in the working tree for review.
