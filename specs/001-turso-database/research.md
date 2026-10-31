# Research

## Decision: synchronous libSQL driver

Official source: https://github.com/tursodatabase/libsql-js. npm stable 0.5.29 supports synchronous remote connections, statements, multi-statement exec and pragma. Installed source inspected. The default transaction wrapper does not nest; use savepoints. Independently checked by the speckit-plan research agent.

Alternatives: @libsql/client requires pervasive async edits; embedded replicas add unnecessary sync/durability semantics; PostgreSQL needs broader migration.

## Decision: remote safeguards

https://docs.turso.tech/cloud/limitations lists unsupported journal_mode and busy_timeout. Filter only these; retain schema pragmas. Remote db.name must not be a filesystem path. Require ENCRYPTION_KEY even in development to prevent the existing fallback storing it in the remote DB. Guard file restore, backup-now and pump independently.

## Decision: isolated trial

WSL CLI exists but is not logged in. Never reuse the other project's DB. Local tests proceed without credentials. Cloud initialization and latency remain explicit validation items; no production claim without results.
