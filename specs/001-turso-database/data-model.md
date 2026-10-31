# Data model

No schema changes. Existing users, sessions, invites, user keys, settings, provider keys, analytics and migration ledger use the selected connection.

Configuration: FREEAPI_DB_DRIVER is sqlite (default) or turso; TURSO_DATABASE_URL is a libsql:// host with no credentials/path/query; TURSO_AUTH_TOKEN is nonempty; ENCRYPTION_KEY is exactly 64 hexadecimal characters. Explicit factories and :memory: remain available for tests.

State: disconnected -> validated -> connected -> migrated -> serving -> closed. Failures never silently fall back to local storage. Remote metadata must not be interpreted as a local file.
