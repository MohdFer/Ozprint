import {
  IPrintAdapter,
  DiscoveredPrinter,
  PrintSubmissionRequest,
  PrintSubmissionResult,
  CupsJobStatusResult,
} from './IPrintAdapter';
import {
  validateSafePrinterName,
  validateSafeCupsJobId,
} from '../security/sandbox';

export interface IAgentBridge {
  isAgentOnline(agentId: string): boolean;
  sendJobToAgent(
    agentId: string,
    payload: {
      jobId: string;
      printerSystemName: string;
      sliceDownloadUrl: string;
      options: PrintSubmissionRequest['options'];
    }
  ): Promise<{ cupsJobId: string }>;
  getAgentJobStatus(agentId: string, jobId: string): CupsJobStatusResult;
  cancelAgentJob(agentId: string, cupsJobId: string): Promise<void>;
}

export class RemoteAgentAdapter implements IPrintAdapter {
  public readonly adapterType = 'REMOTE_AGENT' as const;

  constructor(private readonly agentBridge: IAgentBridge) {}

  async discoverPrinters(): Promise<DiscoveredPrinter[]> {
    // Remote agent printers are registered push-style upon AGENT_HELLO
    return [];
  }

  async submitJob(req: PrintSubmissionRequest): Promise<PrintSubmissionResult> {
    const safePrinter = validateSafePrinterName(req.printerSystemName);
    if (!req.agentId) {
      throw new Error('REMOTE_AGENT_ID_MISSING');
    }
    if (!this.agentBridge.isAgentOnline(req.agentId)) {
      throw new Error(`REMOTE_AGENT_OFFLINE:${req.agentId}`);
    }

    return this.agentBridge.sendJobToAgent(req.agentId, {
      jobId: req.jobId,
      printerSystemName: safePrinter,
      sliceDownloadUrl: `/api/print-jobs/${req.jobId}/agent-slice`,
      options: req.options,
    });
  }

  async getJobStatus(
    cupsJobId: string,
    printerSystemName: string,
    agentId?: string | null
  ): Promise<CupsJobStatusResult> {
    validateSafeCupsJobId(cupsJobId);
    validateSafePrinterName(printerSystemName);

    if (!agentId || !this.agentBridge.isAgentOnline(agentId)) {
      return {
        state: 'UNKNOWN',
        reason: 'Remote Print Agent disconnected during job execution',
      };
    }

    return this.agentBridge.getAgentJobStatus(agentId, cupsJobId);
  }

  async cancelJob(cupsJobId: string, agentId?: string | null): Promise<void> {
    const safeJobId = validateSafeCupsJobId(cupsJobId);
    if (agentId && this.agentBridge.isAgentOnline(agentId)) {
      await this.agentBridge.cancelAgentJob(agentId, safeJobId);
    }
  }
}
