# Data model
All tables are introduced in a new reversible migration.
- auth_google_identities: subject primary key, unique user_id FK users cascade, created_at. A user links to at most one Google subject; roles remain on users.
- auth_google_attempts: state_hash primary key, expires_at_ms. Cookie contains encrypted verifier/nonce/invite and expiry; deleting the state atomically consumes a callback.
- auth_google_handoffs: ticket_hash primary key, user_id FK users cascade, encrypted payload, expires_at_ms. Result includes session and optional initial key; one-time completion deletes the row.
- auth_email_resets: token_hash primary key, user_id FK users cascade, account_fingerprint, expires_at_ms. Issuance invalidates previous links. Reset atomically verifies current fingerprint, updates password, deletes all owner reset rows and sessions.
- auth_request_limits: bucket_hash primary key, started_at_ms, attempts. Fixed 15-minute windows, expired rows pruned and bounded size. Hashes avoid storing emails/IPs in limiter rows.
