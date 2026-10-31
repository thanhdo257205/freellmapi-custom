# Validation guide

1. npm install; npm run build:server.
2. npm run test -w server -- src/__tests__/db/turso.test.ts.
3. npm run test:migrations; npm run lint; npm run build; npm test.
4. Create a separate libSQL DB with Turso CLI; never reuse the other project's URL/token.
5. Set FREEAPI_DB_DRIVER=turso, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and ENCRYPTION_KEY privately.
6. Run the opt-in smoke script against the disposable DB to verify migrations and reconnect persistence.
7. Follow docs/en/deployment/03-turso.md for Render setup and existing-data transfer. This trial does not cut over Render.
