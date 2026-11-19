import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMMON_SCHEMA_DDL, SQLITE_IMMUTABILITY_TRIGGERS } from './schema';
import { AppConfig } from '../config/env';

/**
 * Clean SQL Abstraction Layer supporting better-sqlite3 (WAL mode default)
 * and PostgreSQL parameter translation ($1, $2, ...) compatibility.
 */
export interface IDbStatement<T = any> {
  run(...params: any[]): { changes: number };
  get(...params: any[]): T | undefined;
  all(...params: any[]): T[];
}

export interface IDatabase {
  readonly driver: 'sqlite' | 'postgres';
  exec(sql: string): void;
  prepare<T = any>(sql: string): IDbStatement<T>;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Converts standard `?` placeholders to PostgreSQL `$1, $2...` when generating
 * queries for PostgreSQL deployments.
 */
export function toPostgresSql(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export function hashPassword(password: string, salt?: string): string {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, actualSalt, 100000, 64, 'sha512')
    .toString('hex');
  return `${actualSalt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, originalHash] = storedHash.split(':');
  if (!salt || !originalHash) return false;
  const candidate = hashPassword(password, salt);
  const candidateBuf = Buffer.from(candidate);
  const storedBuf = Buffer.from(storedHash);
  if (candidateBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, storedBuf);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class SqliteDatabaseAdapter implements IDatabase {
  public readonly driver = 'sqlite' as const;
  private rawDb: any;
  private isBetterSqlite3 = false;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }

    try {
      // Primary: better-sqlite3 as specified in TRD v3.0
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const BetterSqlite3 = require('better-sqlite3');
      this.rawDb = new BetterSqlite3(sqlitePath);
      this.isBetterSqlite3 = true;
      this.rawDb.pragma('journal_mode = WAL');
      this.rawDb.pragma('foreign_keys = ON');
      this.rawDb.pragma('busy_timeout = 5000');
    } catch {
      // Fallback: Node 22 built-in node:sqlite if native C++ addon is not compiled on host
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      this.rawDb = new DatabaseSync(sqlitePath);
      this.isBetterSqlite3 = false;
      this.rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    }
  }

  exec(sql: string): void {
    this.rawDb.exec(sql);
  }

  prepare<T = any>(sql: string): IDbStatement<T> {
    const stmt = this.rawDb.prepare(sql);
    return {
      run: (...params: any[]) => {
        const res = stmt.run(...params);
        return { changes: Number(res?.changes ?? 0) };
      },
      get: (...params: any[]) => stmt.get(...params) as T | undefined,
      all: (...params: any[]) => stmt.all(...params) as T[],
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.isBetterSqlite3) {
      const trx = this.rawDb.transaction(fn);
      return trx();
    }
    this.rawDb.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.rawDb.close();
  }
}

export function initializeDatabase(config: AppConfig): IDatabase {
  const db = new SqliteDatabaseAdapter(config.sqlitePath);
  db.exec(COMMON_SCHEMA_DDL);
  db.exec(SQLITE_IMMUTABILITY_TRIGGERS);

  // Seed default Admin account if none exists
  const existingAdmin = db
    .prepare<{ id: string }>('SELECT id FROM users WHERE username = ?')
    .get(config.defaultAdminUsername);

  if (!existingAdmin) {
    const adminId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO users (id, username, email, password_hash, role, monthly_page_quota, pages_used_current_period, is_active)
       VALUES (?, ?, ?, ?, 'ADMIN', ?, 0, 1)`
    ).run(
      adminId,
      config.defaultAdminUsername,
      config.defaultAdminEmail,
      hashPassword(config.defaultAdminPassword),
      config.defaultMonthlyQuota * 10
    );
  }

  return db;
}
