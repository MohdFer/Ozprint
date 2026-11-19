import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

export type SafeBinaryPath =
  | '/usr/bin/lp'
  | '/usr/bin/lpstat'
  | '/usr/bin/lpoptions'
  | '/usr/bin/cancel'
  | '/usr/bin/python3'
  | '/usr/bin/pdfinfo'
  | '/usr/bin/pdftoppm';

const ALLOWED_BINARIES: ReadonlySet<string> = new Set<SafeBinaryPath>([
  '/usr/bin/lp',
  '/usr/bin/lpstat',
  '/usr/bin/lpoptions',
  '/usr/bin/cancel',
  '/usr/bin/python3',
  '/usr/bin/pdfinfo',
  '/usr/bin/pdftoppm',
]);

/**
 * TRD 6.1 Canonical Path Guard
 * Prevents directory traversal (../../etc/passwd), null-byte attacks, and symlink escapes.
 */
export async function resolveSafeStoragePath(
  storageRoot: string,
  storageKey: string
): Promise<string> {
  if (
    !storageKey ||
    typeof storageKey !== 'string' ||
    storageKey.includes('\0') ||
    path.isAbsolute(storageKey) ||
    /^[a-zA-Z]:/.test(storageKey) ||
    storageKey.startsWith('/') ||
    storageKey.startsWith('\\')
  ) {
    throw new Error('SECURITY_PATH_TRAVERSAL_BLOCKED');
  }

  await fs.mkdir(storageRoot, { recursive: true });
  const realRoot = await fs.realpath(storageRoot);
  const normalizedKey = storageKey.replace(/\\/g, '/');
  const segments = normalizedKey.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new Error('SECURITY_PATH_TRAVERSAL_BLOCKED');
  }

  const candidate = path.resolve(realRoot, normalizedKey);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!candidate.startsWith(rootWithSep)) {
    throw new Error('SECURITY_PATH_TRAVERSAL_BLOCKED');
  }
  return candidate;
}

/**
 * Validates a CUPS printer system_name to prevent argument injection (e.g. "-o", "--help")
 * or shell metacharacters (";", "|", "$()", "`", "&", "/", "\").
 */
export function validateSafePrinterName(printerName: string): string {
  if (
    !printerName ||
    typeof printerName !== 'string' ||
    printerName.length > 128 ||
    printerName.startsWith('-') ||
    !/^[a-zA-Z0-9_.-]+$/.test(printerName)
  ) {
    throw new Error(`SECURITY_INVALID_PRINTER_NAME:${printerName}`);
  }
  return printerName;
}

/**
 * Validates a CUPS Job ID (e.g., "HP_LaserJet_M1136-42") before passing to /usr/bin/cancel or lpstat.
 */
export function validateSafeCupsJobId(cupsJobId: string): string {
  if (
    !cupsJobId ||
    typeof cupsJobId !== 'string' ||
    cupsJobId.length > 160 ||
    cupsJobId.startsWith('-') ||
    !/^[a-zA-Z0-9_.-]+$/.test(cupsJobId)
  ) {
    throw new Error(`SECURITY_INVALID_CUPS_JOB_ID:${cupsJobId}`);
  }
  return cupsJobId;
}

/**
 * TRD 6.1 Safe Subprocess Execution
 * Zero-shell execution via child_process.spawn with strict binary allowlist and timeout enforcement.
 */
export function runSafeBinary(
  binary: SafeBinaryPath,
  args: string[],
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED_BINARIES.has(binary)) {
    return Promise.reject(new Error(`SECURITY_DISALLOWED_BINARY:${binary}`));
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    return Promise.reject(new Error('SECURITY_INVALID_BINARY_ARGS'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`BINARY_TIMEOUT:${binary}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`BINARY_EXIT_${code}:${stderr.trim()}`));
      }
    });
  });
}
