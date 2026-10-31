# Research

## Decision: synchronous libSQL driver

Official source: https://github.com/tursodatabase/libsql-js. npm stable 0.5.29 supports synchronous remote connections, statements, multi-statement exec and pragma. Installed source inspected. The default transaction wrapper does not nest; use savepoints. Independently checked by the speckit-plan research agent.

Alternatives: @libsql/client requires pervasive async edits; embedded replicas add unnecessary sync/durability semantics; PostgreSQL needs broader migration.

## Decision: remote safeguards

https://docs.turso.tech/cloud/limitations lists unsupported journal_mode and busy_timeout. Filter only these; retain schema pragmas. Remote db.name must not be a filesystem path. Require ENCRYPTION_KEY even in development to prevent the existing fallback storing it in the remote DB. Guard file restore, backup-now and pump independently.

## Decision: isolated trial

WSL CLI exists but is not logged in. Never reuse the other project's DB. Local tests proceed without credentials. Cloud initialization and latency remain explicit validation items; no production claim without results.

## Live findings and compatibility fixes

After CLI authentication, a separate freellmapi-trial database was created. Stable libsql remote object binding drops named values because parameter metadata is absent. The adapter rewrites named placeholders to positional bindings outside SQL quotes/comments, preserving repeated values and rejecting missing values. Evidence: https://github.com/tursodatabase/libsql-js/blob/v0.5.29/src/statement.rs and https://github.com/tursodatabase/libsql/blob/main/libsql/src/hrana/hyper.rs.

Turso also rejects TEMP tables used by upstream's endpoint-identity migration. Only the migration's reserved staging table declarations are translated to ordinary tables inside the same transaction; commit/drop or rollback preserves their lifetime. No upstream migration is changed. Live migrations and account/session/invite/API-key reconnect tests passed. Five warm SELECT probes measured 134–142 ms from the development machine; this is not a Render-region or concurrent-load benchmark.
