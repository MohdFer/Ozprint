import {
  IPrintAdapter,
  DiscoveredPrinter,
  PrintSubmissionRequest,
  PrintSubmissionResult,
  CupsJobStatusResult,
} from '../../apps/server/src/adapters/IPrintAdapter';
import {
  validateSafePrinterName,
  validateSafeCupsJobId,
} from '../../apps/server/src/security/sandbox';

interface MockJobRecord {
  cupsJobId: string;
  printerSystemName: string;
  submittedAt: number;
  state: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  reason?: string;
}

/**
 * Test-only Mock CUPS Adapter for deterministic integration testing
 * (simulating CUPS completions, disconnects, and paper jams in Vitest).
 */
export class MockCupsAdapter implements IPrintAdapter {
  public readonly adapterType = 'LOCAL_CUPS' as const;
  private counter = 100;
  private jobs = new Map<string, MockJobRecord>();
  private simulateDisconnect = false;
  private simulateSubmitFailure = false;
  private simulatePaperJam = false;
  private autoCompleteDelayMs: number;

  constructor(options?: { autoCompleteDelayMs?: number }) {
    this.autoCompleteDelayMs = options?.autoCompleteDelayMs ?? 1200;
  }

  public setSimulateDisconnect(disconnect: boolean): void {
    this.simulateDisconnect = disconnect;
  }

  public setSimulateSubmitFailure(fail: boolean): void {
    this.simulateSubmitFailure = fail;
  }

  public setSimulatePaperJam(jam: boolean): void {
    this.simulatePaperJam = jam;
  }

  async discoverPrinters(): Promise<DiscoveredPrinter[]> {
    return [
      {
        systemName: 'Test_CUPS_Printer',
        displayName: 'Test CUPS Printer',
        adapterType: 'LOCAL_CUPS',
        agentId: null,
        capabilities: {
          color: false,
          duplex: true,
          media: ['A4', 'Letter'],
        },
        operationalState: 'IDLE',
      },
    ];
  }

  async submitJob(req: PrintSubmissionRequest): Promise<PrintSubmissionResult> {
    const safePrinter = validateSafePrinterName(req.printerSystemName);

    if (this.simulateSubmitFailure) {
      throw new Error(`BINARY_EXIT_1:lp: printer ${safePrinter} is offline`);
    }
    if (this.simulateDisconnect) {
      throw new Error('BINARY_TIMEOUT:/usr/bin/lp');
    }

    const cupsJobId = `${safePrinter}-${++this.counter}`;
    this.jobs.set(cupsJobId, {
      cupsJobId,
      printerSystemName: safePrinter,
      submittedAt: Date.now(),
      state: 'PROCESSING',
    });

    return { cupsJobId };
  }

  async getJobStatus(
    cupsJobId: string,
    printerSystemName: string
  ): Promise<CupsJobStatusResult> {
    const safeJobId = validateSafeCupsJobId(cupsJobId);
    validateSafePrinterName(printerSystemName);

    if (this.simulateDisconnect) {
      return {
        state: 'UNKNOWN',
        reason: 'CUPS daemon communication timeout',
      };
    }

    if (this.simulatePaperJam) {
      return {
        state: 'FAILED',
        reason: 'CUPS fault: Paper jam detected in Tray 1',
      };
    }

    const record = this.jobs.get(safeJobId);
    if (!record) {
      return { state: 'COMPLETED' };
    }

    if (
      record.state === 'PROCESSING' &&
      Date.now() - record.submittedAt >= this.autoCompleteDelayMs
    ) {
      record.state = 'COMPLETED';
    }

    return {
      state: record.state,
      reason: record.reason,
    };
  }

  async cancelJob(cupsJobId: string): Promise<void> {
    const safeJobId = validateSafeCupsJobId(cupsJobId);
    this.jobs.delete(safeJobId);
  }
}
