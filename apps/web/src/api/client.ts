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

export function safeRandomUUID(): string {
  if (
    typeof window !== 'undefined' &&
    window.crypto &&
    typeof window.crypto.randomUUID === 'function'
  ) {
    return window.crypto.randomUUID();
  }
  if (
    typeof window !== 'undefined' &&
    window.crypto &&
    typeof window.crypto.getRandomValues === 'function'
  ) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Math.random fallback for non-secure HTTP contexts or legacy environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const api = new ApiClient();
