import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const SERVER_URL = (process.env.OZPRINT_SERVER_URL || 'http://localhost:4000').replace(
  /\/+$/,
  ''
);
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws/agent';
const AGENT_TOKEN = process.env.AGENT_ENROLLMENT_TOKEN || '';

function validateSafeToken(name: string): string {
  if (!name || name.startsWith('-') || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error(`SECURITY_INVALID_IDENTIFIER:${name}`);
  }
  return name;
}

function runSafeAgentBinary(
  binary: '/usr/bin/lp' | '/usr/bin/lpstat' | '/usr/bin/lpoptions' | '/usr/bin/cancel',
  args: string[],
  timeoutMs = 15000
): Promise<{ stdout: string; stderr: string }> {
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

    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`BINARY_EXIT_${code}:${stderr.trim()}`));
    });
  });
}

async function discoverLocalPrinters(): Promise<any[]> {
  try {
    const { stdout } = await runSafeAgentBinary('/usr/bin/lpstat', ['-p', '-d']);
    const printers: any[] = [];
    for (const line of stdout.split('\n')) {
      const m = /^printer\s+([a-zA-Z0-9_.-]+)\s+/i.exec(line.trim());
      if (!m) continue;
      const systemName = validateSafeToken(m[1]);
      printers.push({
        systemName,
        displayName: `${systemName.replace(/[_-]+/g, ' ')} (Remote)`,
        adapterType: 'REMOTE_AGENT',
        capabilities: { color: false, duplex: true, media: ['A4', 'Letter'] },
        operationalState: 'IDLE',
      });
    }
    return printers;
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'CUPS discovery failed; reporting empty printer list');
    return [];
  }
}

async function downloadSlice(sliceUrl: string, destPath: string): Promise<void> {
  const fullUrl = sliceUrl.startsWith('http') ? sliceUrl : `${SERVER_URL}${sliceUrl}`;
  const res = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`SLICE_DOWNLOAD_HTTP_${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  await fs.writeFile(destPath, Buffer.from(arrayBuf));
}

async function pollCupsUntilDone(cupsJobId: string, printerName: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { stdout } = await runSafeAgentBinary('/usr/bin/lpstat', [
      '-W',
      'completed',
      '-o',
      printerName,
    ]);
    if (stdout.split('\n').some((line) => line.trim().startsWith(`${cupsJobId} `))) {
      return;
    }
  }
  throw new Error('CUPS_COMPLETION_POLL_TIMEOUT');
}

function connectAgent(): void {
  if (!AGENT_TOKEN) {
    logger.error('AGENT_ENROLLMENT_TOKEN environment variable is required');
    process.exit(1);
  }

  logger.info({ wsUrl: WS_URL }, 'Connecting Remote Print Agent to OzPrint Server');
  const ws = new WebSocket(WS_URL, {
    headers: {
      Authorization: `Bearer ${AGENT_TOKEN}`,
    },
  });

  let heartbeatTimer: NodeJS.Timeout | null = null;

  ws.on('open', async () => {
    logger.info('Connected to OzPrint Server WebSocket Hub');
    const printers = await discoverLocalPrinters();
    ws.send(
      JSON.stringify({
        type: 'AGENT_HELLO',
        printers,
      })
    );

    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'HEARTBEAT',
            timestamp: new Date().toISOString(),
          })
        );
      }
    }, 15000);
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'JOB_ASSIGN') {
        const { jobId, printerSystemName, sliceDownloadUrl, options } = msg;
        const safePrinter = validateSafeToken(printerSystemName);
        const tempFile = path.join(
          os.tmpdir(),
          `ozagent_slice_${validateSafeToken(jobId)}.pdf`
        );

        try {
          await downloadSlice(sliceDownloadUrl, tempFile);

          const copies = Math.max(1, Math.min(100, Number(options?.copies || 1)));
          const sides =
            options?.duplex === 'long-edge'
              ? 'two-sided-long-edge'
              : options?.duplex === 'short-edge'
                ? 'two-sided-short-edge'
                : 'one-sided';
          const color = options?.colorMode === 'color' ? 'RGB' : 'Gray';
          const media = validateSafeToken(options?.mediaSize || 'A4');

          const { stdout } = await runSafeAgentBinary('/usr/bin/lp', [
            '-d',
            safePrinter,
            '-n',
            String(copies),
            '-o',
            `sides=${sides}`,
            '-o',
            `ColorModel=${color}`,
            '-o',
            `media=${media}`,
            '--',
            tempFile,
          ]);
          const idMatch = /request id is\s+([a-zA-Z0-9_.-]+)/i.exec(stdout);
          const cupsJobId = idMatch
            ? validateSafeToken(idMatch[1])
            : `${safePrinter}-${Date.now()}`;

          ws.send(
            JSON.stringify({
              type: 'JOB_PROGRESS',
              jobId,
              cupsJobId,
              state: 'PROCESSING',
            })
          );

          await pollCupsUntilDone(cupsJobId, safePrinter);
          await fs.unlink(tempFile).catch(() => {});

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'JOB_PROGRESS',
                jobId,
                cupsJobId,
                state: 'COMPLETED',
              })
            );
          }
        } catch (err: any) {
          await fs.unlink(tempFile).catch(() => {});
          ws.send(
            JSON.stringify({
              type: 'JOB_PROGRESS',
              jobId,
              state: 'FAILED',
              reason: err?.message || 'AGENT_SPOOL_ERROR',
            })
          );
        }
      } else if (msg.type === 'JOB_CANCEL') {
        const safeCupsId = validateSafeToken(msg.cupsJobId);
        await runSafeAgentBinary('/usr/bin/cancel', [safeCupsId]).catch(() => {});
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Error handling server message');
    }
  });

  ws.on('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.warn('Disconnected from OzPrint Server; retrying in 5s...');
    setTimeout(connectAgent, 5000);
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message }, 'WebSocket error');
  });
}

if (require.main === module) {
  connectAgent();
}
