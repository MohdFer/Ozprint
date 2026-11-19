export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: 'ADMIN' | 'MEMBER' | 'KIOSK_GUEST';
  monthlyPageQuota: number;
  pagesUsedCurrentPeriod: number;
}

export interface DocumentItem {
  id: string;
  ownerId: string;
  parentDocId: string | null;
  folderId: string | null;
  originalFilename: string;
  storageKey: string;
  mimeType: string;
  fileSizeBytes: number;
  pageCount: number;
  sha256Checksum: string;
  tags: string[];
  revisionNumber: number;
  revisionNote: string | null;
  createdAt: string;
}

export interface PrinterItem {
  id: string;
  systemName: string;
  displayName: string;
  adapterType: 'LOCAL_CUPS' | 'REMOTE_AGENT';
  agentId: string | null;
  capabilities: {
    color: boolean;
    duplex: boolean;
    media: string[];
  };
  operationalState: string;
  isEnabled: boolean;
}

export interface PrintJobItem {
  jobId: string;
  idempotencyKey: string;
  documentId: string;
  documentFilename?: string;
  printerId: string;
  printerName?: string;
  username?: string;
  state:
    | 'UPLOADED'
    | 'VALIDATED'
    | 'QUEUED'
    | 'PROCESSING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
    | 'UNKNOWN';
  resolvedPages: number[];
  logicalPageCount: number;
  physicalSheets: number;
  cupsJobId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

class ApiClient {
  private token: string | null = localStorage.getItem('ozprint_jwt');

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('ozprint_jwt', token);
    } else {
      localStorage.removeItem('ozprint_jwt');
    }
  }

  getToken(): string | null {
    return this.token;
  }

  async request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (this.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (
      init.body &&
      !(init.body instanceof FormData) &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`/api${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });

    if (!res.ok) {
      let errPayload: any = {};
      try {
        errPayload = await res.json();
      } catch {
        // Ignore
      }
      throw new Error(
        errPayload.error || errPayload.message || `HTTP_${res.status}`
      );
    }

    return res.json();
  }

  getStreamUrl(docId: string): string {
    return `/api/documents/${docId}/stream`;
  }
}

export const api = new ApiClient();
