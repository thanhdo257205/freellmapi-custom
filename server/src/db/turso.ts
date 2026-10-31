import { createRequire } from 'node:module';
import type { Db, DbFactory, DbStatement } from './types.js';

const runtimeRequire = createRequire(import.meta.url);
const remoteDatabases = new WeakSet<Db>();

export function tursoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const driver = env.FREEAPI_DB_DRIVER?.trim().toLowerCase() || 'sqlite';
  if (driver !== 'sqlite' && driver !== 'turso') {
    throw new Error('FREEAPI_DB_DRIVER must be sqlite or turso');
  }
  return driver === 'turso';
}

export function readTursoConfig(env: NodeJS.ProcessEnv = process.env): { url: string; authToken: string } {
  const url = env.TURSO_DATABASE_URL?.trim() || '';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('TURSO_DATABASE_URL must be a libsql:// database URL'); }
  if (parsed.protocol !== 'libsql:' || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('TURSO_DATABASE_URL must be a libsql:// host without credentials, path or query');
  }
  const authToken = env.TURSO_AUTH_TOKEN?.trim() || '';
  if (!authToken) throw new Error('TURSO_AUTH_TOKEN is required for Turso');
  if (!/^[a-fA-F0-9]{64}$/.test(env.ENCRYPTION_KEY || '')) {
    throw new Error('ENCRYPTION_KEY must be explicitly set to 64 hex characters for Turso, including in development');
  }
  return { url, authToken };
}

export function isTursoDatabase(db: Db): boolean {
  return remoteDatabases.has(db);
}

/** Preserve the synchronous application contract and support nested migrations.
 * Remote connections deliberately expose no local filename or memory flag. */
export function wrapTursoDatabase(raw: Db, remote = true, secrets: readonly string[] = []): Db {
  let depth = 0;
  let sequence = 0;
  function safe<T>(operation: () => T): T {
    try { return operation(); } catch (error) {
      if (!(error instanceof Error) || secrets.length === 0) throw error;
      let message = error.message;
      for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
      const sanitized = new Error(message);
      const code = (error as Error & { code?: unknown }).code;
      if (typeof code === 'string' && /^SQLITE_[A-Z_]+$/.test(code)) Object.assign(sanitized, { code });
      throw sanitized;
    }
  }
  function row(value: unknown): unknown {
    if (value && typeof value === 'object' && '_metadata' in value) {
      const { _metadata, ...columns } = value as Record<string, unknown>;
      return columns;
    }
    return value;
  }
  function statement(sql: string): DbStatement {
    const stmt = safe(() => raw.prepare(sql));
    // libsql 0.5.x drops object bindings on the remote transport. Convert named
    // bindings to positional ones without touching quoted SQL or comments.
    const names: string[] = [];
    const positionalSql = sql.replace(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|([@:$][A-Za-z_][A-Za-z0-9_]*)/g,
      (token, name: string | undefined) => {
        if (!name) return token;
        names.push(name);
        return '?';
      },
    );
    let positional: DbStatement | undefined;
    function bound<T>(args: unknown[], run: (target: DbStatement, values: unknown[]) => T): T {
      const object = args[0];
      if (names.length && args.length === 1 && object && typeof object === 'object'
        && !Array.isArray(object) && !ArrayBuffer.isView(object)) {
        const values = object as Record<string, unknown>;
        const params = names.map(name => {
          if (Object.hasOwn(values, name)) return values[name];
          if (Object.hasOwn(values, name.slice(1))) return values[name.slice(1)];
          throw new Error(`Missing SQL named parameter ${name}`);
        });
        positional ??= safe(() => raw.prepare(positionalSql));
        return safe(() => run(positional!, params));
      }
      return safe(() => run(stmt, args));
    }
    return {
      get: (...args) => row(bound(args, (target, values) => target.get(...values))),
      all: (...args) => bound(args, (target, values) => target.all(...values)).map(row),
      run: (...args) => bound(args, (target, values) => target.run(...values)),
    };
  }
  const db: Db = {
    prepare: statement,
    exec: sql => {
      // Upstream's endpoint-identity migration parks child rows in TEMP tables.
      // Turso disallows TEMP. These reserved tables are created and dropped in
      // the same write transaction, so ordinary tables have the same lifetime.
      const compatible = remote && depth > 0
        ? sql.replace(/^(\s*CREATE\s+)TEMP(?:ORARY)?\s+(TABLE\s+"_endpoint_identity_[a-z_]+"\s+AS\b)/i, '$1$2')
        : sql;
      safe(() => raw.exec(compatible));
    },
    pragma: source => {
      // These are controlled by Turso, not by individual remote connections.
      if (remote && /^\s*(journal_mode|busy_timeout|wal_checkpoint)\b/i.test(source)) return [];
      return safe(() => raw.pragma(source));
    },
    close: () => raw.close?.(),
    transaction: <F extends (...args: any[]) => unknown>(fn: F): F => {
      const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const outermost = depth === 0;
        const savepoint = `freellmapi_turso_${++sequence}`;
        db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const result = fn.apply(this, args) as ReturnType<F>;
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            throw new Error('Turso transaction callbacks must be synchronous');
          }
          db.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          try {
            if (outermost) raw.exec('ROLLBACK');
            else {
              raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
            }
          } catch { /* Preserve the original failure. */ }
          throw error;
        } finally { depth -= 1; }
      };
      return wrapped as F;
    },
  };
  if (remote) remoteDatabases.add(db);
  return db;
}

export const tursoFactory: DbFactory = () => {
  const config = readTursoConfig();
  let Libsql: new (url: string, opts: { authToken: string }) => Db;
  try { Libsql = runtimeRequire('libsql') as typeof Libsql; }
  catch { throw new Error('Turso requires the libsql native driver. Reinstall dependencies for this platform.'); }
  try {
    return wrapTursoDatabase(new Libsql(config.url, { authToken: config.authToken }), true, [config.authToken, config.url]);
  } catch {
    // Native transport errors may contain the URL or auth headers.
    throw new Error('Could not connect to Turso. Check TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and network access.');
  }
};
