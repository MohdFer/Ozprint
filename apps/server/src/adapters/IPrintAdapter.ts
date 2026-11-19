export interface PrinterCapabilities {
  color: boolean;
  duplex: boolean;
  media: string[];
}

export interface DiscoveredPrinter {
  systemName: string;
  displayName: string;
  adapterType: 'LOCAL_CUPS' | 'REMOTE_AGENT';
  agentId?: string | null;
  capabilities: PrinterCapabilities;
  operationalState: 'IDLE' | 'PRINTING' | 'OFFLINE' | 'FAULT';
}

export interface PrintJobOptions {
  range?: string;
  subset?: 'all' | 'odd' | 'even';
  reverse?: boolean;
  copies: number;
  duplex: 'none' | 'long-edge' | 'short-edge';
  colorMode: 'monochrome' | 'color';
  mediaSize: string;
}

export interface PrintSubmissionRequest {
  jobId: string;
  printerSystemName: string;
  agentId?: string | null;
  sliceFilePath: string;
  sliceStorageKey?: string;
  options: PrintJobOptions;
}

export interface PrintSubmissionResult {
  cupsJobId: string;
}

export interface CupsJobStatusResult {
  state: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  reason?: string;
}

export interface IPrintAdapter {
  readonly adapterType: 'LOCAL_CUPS' | 'REMOTE_AGENT';
  discoverPrinters(): Promise<DiscoveredPrinter[]>;
  submitJob(req: PrintSubmissionRequest): Promise<PrintSubmissionResult>;
  getJobStatus(
    cupsJobId: string,
    printerSystemName: string,
    agentId?: string | null
  ): Promise<CupsJobStatusResult>;
  cancelJob(cupsJobId: string, agentId?: string | null): Promise<void>;
}
