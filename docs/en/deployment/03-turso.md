# Experimental Turso/libSQL deployment

SQLite remains the default. Turso is an opt-in, single-instance trial backend.
It uses the synchronous `libsql` driver to preserve upstream compatibility.
Each network query blocks Node's event loop; catalog initialization and pages
with many queries can be slow. Measure on your Render region before cutover.

## Create an isolated database

Use the existing Turso CLI/account, but create a **new libSQL database**. Do not
reuse another application's database or select the separate beta TursoDB engine.

```sh
turso db create freellmapi-trial --group default --wait
turso db show freellmapi-trial --url
turso db tokens create freellmapi-trial --expiration 7d
```

The last command prints a secret. Store its result privately; use a
database-scoped token, never the CLI/account token, in the application.
Replace an expiring trial token before it expires.

Configure Render environment variables or a private local `.env.turso`:

```dotenv
FREEAPI_DB_DRIVER=turso
TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io
TURSO_AUTH_TOKEN=your-database-scoped-token
ENCRYPTION_KEY=your-existing-64-character-hex-key
```

An explicit encryption key is required even in development. Keep the same key
when transferring encrypted provider data. An empty trial can use a new key.
Set `FREEAPI_ENV_PATH` to the absolute `.env.turso` path for a local trial;
the server otherwise reads `.env`. Do not commit the private trial file.

## Verify before changing Render

```sh
npm run build:server
# With the variables above loaded, or FREEAPI_ENV_PATH set:
npx tsx server/src/scripts/turso-smoke.ts --disposable
```

The smoke script refuses databases with existing users. It initializes the
schema, creates temporary account/session/invite/API-key records, checks
rollback and persistence after reconnect, checks HTTP health/login/key/model
routes, reports query latency, then removes
its test records. It leaves the normal initialized schema/catalog in place.
Use only the dedicated trial database. Do not run two instances against it.

The empty trial correctly returns HTTP 503 from `/readyz` with
`no_upstreams_configured` until you configure a provider. `/livez` and
`/api/ping` return 200. The trial does not call any LLM provider.

The initial cloud trial on 2026-10-31 completed migrations and persistence
checks. Warm initialization took about 0.7 seconds; individual SELECT calls
from the development machine were usually 133–145 ms, with a 292 ms sample.
These are development-machine measurements, not a Render load benchmark.
The Windows native driver also emitted a shutdown warning about an unavailable
runtime after closing a stream; the persistence and HTTP checks still passed.

## Move existing Render data

1. Keep a backup of the current database and its matching `ENCRYPTION_KEY`.
2. Stop application writes and take a consistent SQLite snapshot, using
   SQLite's backup facility or copying only after the connection is closed.
   Do not copy a live main `.db` file without accounting for its WAL.
3. Create another empty Turso libSQL database with
   `turso db create freellmapi-production --from-file ./snapshot.db --wait`.
   Use a private machine and protect the snapshot; it contains account data.
4. Obtain a database-scoped token and configure the Render service with the
   four variables above, preserving its existing encryption key.
5. Deploy the tested code, inspect startup, log in with the existing account
   and verify `/livez`, `/readyz`, `/api/ping` and inference with your own key.
6. Keep the original snapshot until verification is complete. Switching back
   requires reconciling any writes made after cutover; switching env variables
   alone does not copy remote data back to SQLite.

This integration does not upload or replace your current Render data itself.

## Backups and operational limits

- The raw-file `FREEAPI_DB_BACKUP_*` restore/upload pump is skipped remotely;
  it cannot represent a remote database by reading a local path.
- Dashboard SQL dump exports query the active database, but their files are
  local. On Render's ephemeral filesystem, download/store them externally.
  Those exports exclude login accounts and are not full database migrations.
- Use Turso database export/recovery for complete hosted-data backups, and
  retain the matching encryption key separately.
- `FREEAPI_DB_PATH` is not the remote URL; it remains relevant to local paths
  such as SQL export storage. Never put tokens in URLs.
- Network failure or revoked token fails the operation; there is no silent
  fallback to an unrelated SQLite database.

References: [libSQL Node driver](https://github.com/tursodatabase/libsql-js),
[Turso limitations](https://docs.turso.tech/cloud/limitations).
