import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'libsql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectDb } from '../../db/index.js';
import { runMigrations, runMigrationsSync } from '../../db/migrate/runner.js';
import { DEFAULT_MIGRATIONS } from '../../db/migrate/defaults.js';
import { readTursoConfig, tursoEnabled, wrapTursoDatabase } from '../../db/turso.js';
import { backupDbNow, restoreDbBackupIfNeeded, startDbBackupPump } from '../../lib/db-backup.js';

afterEach(() => vi.unstubAllEnvs());

describe('Turso configuration', () => {
  const valid = {
    TURSO_DATABASE_URL: 'libsql://freellmapi-test.example.turso.io',
    TURSO_AUTH_TOKEN: 'private-test-token',
    ENCRYPTION_KEY: 'a'.repeat(64),
  };

  it('is opt-in and rejects unknown drivers', () => {
    expect(tursoEnabled({})).toBe(false);
    expect(tursoEnabled({ FREEAPI_DB_DRIVER: 'sqlite' })).toBe(false);
    expect(tursoEnabled({ FREEAPI_DB_DRIVER: 'turso' })).toBe(true);
    expect(() => tursoEnabled({ FREEAPI_DB_DRIVER: 'typo' })).toThrow('FREEAPI_DB_DRIVER');
  });

  it('requires a dedicated URL, token and explicit encryption key', () => {
    expect(readTursoConfig(valid)).toEqual({ url: valid.TURSO_DATABASE_URL, authToken: valid.TURSO_AUTH_TOKEN });
    for (const url of ['', 'file:local.db', 'https://example.com', 'libsql://user:secret@example.com', 'libsql://example.com?token=secret']) {
      expect(() => readTursoConfig({ ...valid, TURSO_DATABASE_URL: url })).toThrow('TURSO_DATABASE_URL');
    }
    expect(() => readTursoConfig({ ...valid, TURSO_AUTH_TOKEN: '' })).toThrow('TURSO_AUTH_TOKEN');
    expect(() => readTursoConfig({ ...valid, ENCRYPTION_KEY: '' })).toThrow('ENCRYPTION_KEY');
    expect(() => readTursoConfig({ ...valid, ENCRYPTION_KEY: 'wrong' })).toThrow('ENCRYPTION_KEY');
  });

  it('keeps explicit memory connections local, even with Turso enabled', () => {
    vi.stubEnv('FREEAPI_DB_DRIVER', 'turso');
    const db = connectDb(':memory:');
    try { expect(db.memory).toBe(true); } finally { db.close?.(); }
  });

  it('preserves explicitly supplied database factories', () => {
    vi.stubEnv('FREEAPI_DB_DRIVER', 'turso');
    const factory = vi.fn(() => wrapTursoDatabase(new Database(':memory:'), false));
    const db = connectDb('unused.db', { ensureDir: false, factory });
    try { expect(factory).toHaveBeenCalledWith('unused.db'); } finally { db.close?.(); }
  });

  it('rejects invalid remote config without creating a local directory', () => {
    vi.stubEnv('FREEAPI_DB_DRIVER', 'turso');
    vi.stubEnv('TURSO_DATABASE_URL', '');
    const dir = path.join(os.tmpdir(), `freellmapi-turso-${crypto.randomUUID()}`);
    expect(() => connectDb(path.join(dir, 'db.sqlite'))).toThrow('TURSO_DATABASE_URL');
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('libSQL adapter', () => {
  it('maps named bindings to positional values while preserving quotes, comments and repeats', () => {
    const db = wrapTursoDatabase(new Database(':memory:'), false);
    try {
      const sql = `SELECT @value AS value, @value AS repeated, :other AS other,
        '@literal' AS literal, 1 AS "@identifier", 2 AS [@bracket], 3 AS \`@backtick\`
        /* @comment */ -- @line_comment
      `;
      expect(db.prepare(sql).get({ value: 'bound', other: null })).toEqual({
        value: 'bound', repeated: 'bound', other: null, literal: '@literal', '@identifier': 1, '@bracket': 2, '@backtick': 3,
      });
      expect(db.prepare('SELECT $value AS value').get({ '$value': 'prefixed' })).toEqual({ value: 'prefixed' });
      expect(() => db.prepare('SELECT @missing').get({ other: 1 })).toThrow('Missing SQL named parameter');
    } finally { db.close?.(); }
  });

  it('rolls back nested work while preserving outer writes and callback arguments', () => {
    const db = wrapTursoDatabase(new Database(':memory:'), false);
    try {
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT UNIQUE)');
      const insert = db.prepare('INSERT INTO items(value) VALUES (?)');
      const inner = db.transaction(() => { insert.run('inner'); throw new Error('rollback'); });
      const outer = db.transaction((value: string) => {
        insert.run(value);
        expect(inner).toThrow('rollback');
        return insert.run('after').changes;
      });
      expect(outer('before')).toBe(1);
      expect(db.prepare('SELECT value FROM items ORDER BY id').all()).toEqual([{ value: 'before' }, { value: 'after' }]);
      expect(db.transaction(() => { insert.run('discard'); throw new Error('outer'); })).toThrow('outer');
      expect(db.prepare("SELECT * FROM items WHERE value='discard'").get()).toBeUndefined();
      expect(db.transaction(() => Promise.resolve())).toThrow('synchronous');
    } finally { db.close?.(); }
  });

  it('runs every migration and supports migration down/up with existing auth data', async () => {
    vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
    const db = wrapTursoDatabase(new Database(':memory:'));
    try {
      db.pragma('foreign_keys = ON');
      runMigrationsSync(db);
      expect(db.prepare('SELECT count(*) AS n FROM migrations').get()).toEqual({ n: DEFAULT_MIGRATIONS.length });
      // The upstream baseline is intentionally irreversible.
      for (let i = 1; i < DEFAULT_MIGRATIONS.length; i++) await runMigrations(db, 'down');
      await runMigrations(db, 'up');
      db.prepare("INSERT INTO users(email,password_hash,role) VALUES (?,?,?)").run('trial@example.com', 'test-hash', 'admin');
      runMigrationsSync(db);
      await runMigrations(db, 'down');
      await runMigrations(db, 'up');
      expect(db.prepare('SELECT email, role FROM users').get()).toEqual({ email: 'trial@example.com', role: 'admin' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close?.(); }
  });

  it('keeps reserved migration staging tables within a transaction on remote storage', () => {
    const raw = new Database(':memory:');
    const exec = vi.spyOn(raw, 'exec');
    const db = wrapTursoDatabase(raw);
    try {
      db.exec('CREATE TABLE items(value TEXT); INSERT INTO items VALUES (\'saved\')');
      expect(db.transaction(() => {
        db.exec('CREATE TEMP TABLE "_endpoint_identity_items" AS SELECT * FROM items');
        expect(db.prepare('SELECT value FROM _endpoint_identity_items').get()).toEqual({ value: 'saved' });
        throw new Error('rollback staging');
      })).toThrow('rollback staging');
      expect(exec).toHaveBeenCalledWith('CREATE TABLE "_endpoint_identity_items" AS SELECT * FROM items');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='_endpoint_identity_items'").get()).toBeUndefined();
      expect(db.prepare('SELECT value FROM items').get()).toEqual({ value: 'saved' });
    } finally { db.close?.(); }
  });

  it('persists writes across reconnects without exposing remote file metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-libsql-'));
    const filename = path.join(dir, 'trial.db');
    try {
      // Child processes release native statement handles on Windows as well.
      const moduleUrl = new URL('../../db/turso.ts', import.meta.url).href;
      const prefix = `import Database from 'libsql'; import {wrapTursoDatabase} from ${JSON.stringify(moduleUrl)}; const db=wrapTursoDatabase(new Database(${JSON.stringify(filename)}),false);`;
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prefix + `db.exec("CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('persisted')"); db.close();`]);
      const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prefix + `console.log(JSON.stringify(db.prepare('SELECT value FROM items').get())); db.close();`], { encoding: 'utf8' });
      expect(JSON.parse(result)).toEqual({ value: 'persisted' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('skips unsupported remote pragmas but keeps schema introspection and SQL errors', () => {
    const db = wrapTursoDatabase(new Database(':memory:'));
    try {
      expect(db.name).toBeUndefined();
      expect(db.memory).toBeUndefined();
      expect(db.pragma('journal_mode = WAL')).toEqual([]);
      expect(db.pragma('busy_timeout = 5000')).toEqual([]);
      db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY)');
      expect(db.pragma('table_info(items)')).toHaveLength(1);
      expect(() => db.prepare('SELECT * FROM nonexistent').all()).toThrow();
    } finally { db.close?.(); }
  });

  it('redacts transport credentials in query errors without swallowing failures', () => {
    const raw = new Database(':memory:');
    const failing = { ...raw, exec: () => { throw new Error('failed with private-token at libsql://private-host'); } } as unknown as import('../../db/types.js').Db;
    const db = wrapTursoDatabase(failing, true, ['private-token', 'libsql://private-host']);
    try {
      expect(() => db.exec('SELECT 1')).toThrow('failed with [redacted] at [redacted]');
    } finally { raw.close(); }
  });
});

describe('remote backup guards', () => {
  it('does not read or overwrite a local file, or schedule a file backup', async () => {
    vi.stubEnv('FREEAPI_DB_DRIVER', 'turso');
    vi.stubEnv('FREEAPI_DB_BACKUP_PATH', path.join(os.tmpdir(), 'must-not-be-written.fapibk'));
    const db = wrapTursoDatabase(new Database(':memory:'));
    const every = vi.fn();
    try {
      expect(await restoreDbBackupIfNeeded('missing.db')).toMatchObject({ skipped: 'remote database' });
      expect(await backupDbNow(db, 'missing.db')).toMatchObject({ skipped: 'remote database' });
      expect(startDbBackupPump(db, { every } as any)).toBeNull();
      expect(every).not.toHaveBeenCalled();
    } finally { db.close?.(); }
  });
});
