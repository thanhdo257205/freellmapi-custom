# Configuration contract

- Empty/unset FREEAPI_DB_DRIVER preserves SQLite; turso selects remote libSQL.
- Unknown driver, missing token, malformed URL or invalid encryption key fails startup.
- Explicit factory or :memory: path bypasses environment backend selection.
- URL/token are server-side configuration and never frontend variables.
- Raw SQLite file backup/restore is skipped remotely. SQL dump exports remain local and need external retention on Render.
- Existing /v1, /livez, /readyz and /api/ping contracts are unchanged.
