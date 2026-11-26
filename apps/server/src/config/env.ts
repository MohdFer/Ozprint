import path from 'node:path';

export interface AppConfig {
  port: number;
  nodeEnv: string;
  jwtSecret: string;
  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  databaseUrl: string;
  storageRoot: string;
  cupsPollIntervalMs: number;
  cupsTimeoutMs: number;
  pythonBinary: string;
  defaultAdminUsername: string;
  defaultAdminEmail: string;
  defaultAdminPassword: string;
  defaultMonthlyQuota: number;
  documentTtlHours: number;
  kioskSessionTtlMinutes: number;
  cleanupIntervalMs: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const defaultStorageRoot =
    process.env.NODE_ENV === 'production' && process.platform !== 'win32'
      ? '/var/lib/ozprint'
      : path.resolve(process.cwd(), 'storage');

  const rawStorageRoot =
    overrides.storageRoot || process.env.STORAGE_ROOT || defaultStorageRoot;
  const storageRoot = path.isAbsolute(rawStorageRoot)
    ? rawStorageRoot
    : path.resolve(process.cwd(), rawStorageRoot);

  return {
    port: Number(process.env.PORT || 4000),
    nodeEnv: process.env.NODE_ENV || 'development',
    jwtSecret:
      process.env.JWT_SECRET ||
      'ozprint-default-dev-jwt-secret-do-not-use-in-prod-9876543210',
    dbDriver: process.env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite',
    sqlitePath:
      overrides.sqlitePath ||
      process.env.SQLITE_PATH ||
      path.join(storageRoot, 'ozprint.db'),
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgres://ozprint:ozprint@localhost:5432/ozprint',
    storageRoot,
    cupsPollIntervalMs: Number(process.env.CUPS_POLL_INTERVAL_MS || 2000),
    cupsTimeoutMs: Number(process.env.CUPS_TIMEOUT_MS || 15000),
    pythonBinary:
      process.env.PYTHON_BINARY ||
      (process.platform === 'win32' ? 'python' : '/usr/bin/python3'),
    defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
    defaultAdminEmail: process.env.DEFAULT_ADMIN_EMAIL || 'admin@ozprint.local',
    defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'ozprint-admin',
    defaultMonthlyQuota: Number(process.env.DEFAULT_MONTHLY_QUOTA || 500),
    documentTtlHours: Number(process.env.DOCUMENT_TTL_HOURS || 168),
    kioskSessionTtlMinutes: Number(process.env.KIOSK_SESSION_TTL_MINUTES || 30),
    cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 60000),
    ...overrides,
  };
}
