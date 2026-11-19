import {
  IPrintAdapter,
  DiscoveredPrinter,
  PrinterCapabilities,
  PrintSubmissionRequest,
  PrintSubmissionResult,
  CupsJobStatusResult,
} from './IPrintAdapter';
import {
  runSafeBinary,
  validateSafePrinterName,
  validateSafeCupsJobId,
} from '../security/sandbox';

export class LocalCupsAdapter implements IPrintAdapter {
  public readonly adapterType = 'LOCAL_CUPS' as const;

  constructor(private readonly timeoutMs = 15000) {}

  async discoverPrinters(): Promise<DiscoveredPrinter[]> {
    const { stdout } = await runSafeBinary(
      '/usr/bin/lpstat',
      ['-p', '-d'],
      this.timeoutMs
    );
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const discovered: DiscoveredPrinter[] = [];

    for (const line of lines) {
      // Example: "printer HP_LaserJet_M1136 is idle.  enabled since ..."
      const match = /^printer\s+([a-zA-Z0-9_.-]+)\s+(.*)$/i.exec(line);
      if (!match) continue;
      const systemName = validateSafePrinterName(match[1]);
      const statusText = match[2].toLowerCase();

      let operationalState: DiscoveredPrinter['operationalState'] = 'IDLE';
      if (statusText.includes('disabled') || statusText.includes('Paused')) {
        operationalState = 'OFFLINE';
      } else if (statusText.includes('printing')) {
        operationalState = 'PRINTING';
      }

      const capabilities = await this.parseCapabilities(systemName);
      discovered.push({
        systemName,
        displayName: systemName.replace(/[_-]+/g, ' '),
        adapterType: 'LOCAL_CUPS',
        agentId: null,
        capabilities,
        operationalState,
      });
    }

    return discovered;
  }

  private async parseCapabilities(
    systemName: string
  ): Promise<PrinterCapabilities> {
    const safeName = validateSafePrinterName(systemName);
    try {
      const { stdout } = await runSafeBinary(
        '/usr/bin/lpoptions',
        ['-p', safeName, '-l'],
        this.timeoutMs
      );
      const lower = stdout.toLowerCase();
      const color =
        lower.includes('colormodel') &&
        (lower.includes('rgb') || lower.includes('color') || lower.includes('cmyk'));
      const duplex =
        lower.includes('duplex') &&
        (lower.includes('duplexnotumble') || lower.includes('duplextumble'));

      const media: string[] = [];
      for (const size of ['A4', 'Letter', 'Legal', 'A3', 'A5']) {
        if (stdout.includes(size)) {
          media.push(size);
        }
      }
      if (media.length === 0) media.push('A4', 'Letter');

      return { color, duplex, media };
    } catch {
      return { color: false, duplex: true, media: ['A4', 'Letter'] };
    }
  }

  async submitJob(req: PrintSubmissionRequest): Promise<PrintSubmissionResult> {
    const safePrinter = validateSafePrinterName(req.printerSystemName);
    const copies = Math.max(1, Math.min(100, Math.floor(req.options.copies || 1)));

    const sidesMap: Record<string, string> = {
      none: 'one-sided',
      'long-edge': 'two-sided-long-edge',
      'short-edge': 'two-sided-short-edge',
    };
    const sidesValue = sidesMap[req.options.duplex] || 'one-sided';
    const colorValue = req.options.colorMode === 'color' ? 'RGB' : 'Gray';
    const mediaValue = /^[a-zA-Z0-9_.-]+$/.test(req.options.mediaSize || 'A4')
      ? req.options.mediaSize
      : 'A4';

    const args = [
      '-d',
      safePrinter,
      '-n',
      String(copies),
      '-o',
      `sides=${sidesValue}`,
      '-o',
      `ColorModel=${colorValue}`,
      '-o',
      `media=${mediaValue}`,
      '--',
      req.sliceFilePath,
    ];

    const { stdout } = await runSafeBinary('/usr/bin/lp', args, this.timeoutMs);
    // Expected CUPS stdout: "request id is HP_LaserJet_M1136-14 (1 file(s))"
    const idMatch = /request id is\s+([a-zA-Z0-9_.-]+)/i.exec(stdout);
    const cupsJobId = idMatch
      ? validateSafeCupsJobId(idMatch[1])
      : `${safePrinter}-${Date.now()}`;

    return { cupsJobId };
  }

  async getJobStatus(
    cupsJobId: string,
    printerSystemName: string
  ): Promise<CupsJobStatusResult> {
    const safeJobId = validateSafeCupsJobId(cupsJobId);
    const safePrinter = validateSafePrinterName(printerSystemName);

    try {
      // 1. Check completed jobs
      const completedRes = await runSafeBinary(
        '/usr/bin/lpstat',
        ['-W', 'completed', '-o', safePrinter],
        this.timeoutMs
      );
      if (
        completedRes.stdout
          .split('\n')
          .some((line) => line.trim().startsWith(`${safeJobId} `))
      ) {
        return { state: 'COMPLETED' };
      }

      // 2. Check active queue & printer fault status
      const activeRes = await runSafeBinary(
        '/usr/bin/lpstat',
        ['-W', 'not-completed', '-o', safePrinter],
        this.timeoutMs
      );
      const printerRes = await runSafeBinary(
        '/usr/bin/lpstat',
        ['-p', safePrinter],
        this.timeoutMs
      );

      const lowerPrinter = printerRes.stdout.toLowerCase();
      if (
        lowerPrinter.includes('aborted') ||
        lowerPrinter.includes('paper jam') ||
        lowerPrinter.includes('fault') ||
        lowerPrinter.includes('stopped')
      ) {
        return {
          state: 'FAILED',
          reason: `CUPS fault reported on ${safePrinter}: ${printerRes.stdout.trim()}`,
        };
      }

      if (
        activeRes.stdout
          .split('\n')
          .some((line) => line.trim().startsWith(`${safeJobId} `))
      ) {
        return { state: 'PROCESSING' };
      }

      // If no longer in not-completed and printer is healthy, it finished between calls
      return { state: 'COMPLETED' };
    } catch (err: any) {
      // Communication loss or timeout with CUPS daemon -> UNKNOWN safety state!
      return {
        state: 'UNKNOWN',
        reason: err?.message || 'CUPS_POLL_TIMEOUT_OR_UNREACHABLE',
      };
    }
  }

  async cancelJob(cupsJobId: string): Promise<void> {
    const safeJobId = validateSafeCupsJobId(cupsJobId);
    await runSafeBinary('/usr/bin/cancel', [safeJobId], this.timeoutMs);
  }
}
