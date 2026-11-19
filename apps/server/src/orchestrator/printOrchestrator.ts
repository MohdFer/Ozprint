import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { IDatabase } from '../db/database';
import {
  IPrintAdapter,
  PrintJobOptions,
  DiscoveredPrinter,
} from '../adapters/IPrintAdapter';
import { resolvePrintPages } from '../core/pageResolver';
import {
  resolveSafeStoragePath,
  validateSafePrinterName,
} from '../security/sandbox';
import { PdfWorkerService } from '../services/pdfWorkerService';
import { DocumentService } from '../services/documentService';
import { AuditService } from '../services/auditService';
import { AuthUser } from '../security/auth';

export type PrintJobState =
  | 'UPLOADED'
  | 'VALIDATED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface PrintJobRecord {
  jobId: string;
  idempotencyKey: string;
  userId: string;
  documentId: string;
  printerId: string;
  state: PrintJobState;
  options: PrintJobOptions;
  resolvedPages: number[];
  logicalPageCount: number;
  physicalSheets: number;
  cupsJobId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export class PrintOrchestrator {
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(
    private readonly db: IDatabase,
    private readonly storageRoot: string,
    private readonly localAdapter: IPrintAdapter,
    private readonly remoteAdapter: IPrintAdapter,
    private readonly pdfWorker: PdfWorkerService,
    private readonly documentService: DocumentService,
    private readonly audit: AuditService,
    private readonly pollIntervalMs = 2000,
    private readonly cleanupIntervalMs = 60000
  ) {}

  startBackgroundWorkers(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.pollActiveJobs().catch(() => {});
      }, this.pollIntervalMs);
      this.pollTimer.unref?.();
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        this.runTtlCleanup().catch(() => {});
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  stopBackgroundWorkers(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private mapJobRow(row: any): PrintJobRecord {
    return {
      jobId: row.id,
      idempotencyKey: row.idempotency_key,
      userId: row.user_id,
      documentId: row.document_id,
      printerId: row.printer_id,
      state: row.state as PrintJobState,
      options: JSON.parse(row.options_json || '{}'),
      resolvedPages: JSON.parse(row.resolved_pages_json || '[]'),
      logicalPageCount: row.logical_page_count,
      physicalSheets: row.physical_sheets,
      cupsJobId: row.cups_job_id,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  private getAdapter(adapterType: string): IPrintAdapter {
    return adapterType === 'REMOTE_AGENT'
      ? this.remoteAdapter
      : this.localAdapter;
  }

  async discoverLocalPrinters(actorUserId?: string): Promise<any[]> {
    const discovered = await this.localAdapter.discoverPrinters();
    const discoveredNames = new Set(discovered.map((d) => d.systemName));

    // Remove stale LOCAL_CUPS printers that are not present in real lpstat output
    const existingLocal = this.db
      .prepare<any>(
        "SELECT id, system_name FROM printers WHERE adapter_type = 'LOCAL_CUPS'"
      )
      .all();
    for (const row of existingLocal) {
      if (!discoveredNames.has(row.system_name)) {
        try {
          this.db.prepare('DELETE FROM printers WHERE id = ?').run(row.id);
        } catch {
          // If referenced by historical print_jobs, disable it so it no longer appears
          this.db
            .prepare('UPDATE printers SET is_enabled = 0 WHERE id = ?')
            .run(row.id);
        }
      }
    }

    this.upsertDiscoveredPrinters(discovered);
    this.audit.log({
      actorUserId,
      action: 'PRINTER_DISCOVER',
      targetType: 'PRINTER',
      details: { count: discovered.length },
    });
    return this.listPrinters(true);
  }

  deletePrinter(printerId: string, actorUserId?: string): void {
    try {
      this.db.prepare('DELETE FROM printers WHERE id = ?').run(printerId);
    } catch {
      this.db
        .prepare('UPDATE printers SET is_enabled = 0 WHERE id = ?')
        .run(printerId);
    }
    this.audit.log({
      actorUserId,
      action: 'PRINTER_DELETED',
      targetType: 'PRINTER',
      targetId: printerId,
    });
  }

  upsertDiscoveredPrinters(discovered: DiscoveredPrinter[]): void {
    for (const p of discovered) {
      const safeName = validateSafePrinterName(p.systemName);
      const existing = this.db
        .prepare<any>(
          `SELECT id FROM printers
           WHERE adapter_type = ? AND IFNULL(agent_id, '') = IFNULL(?, '') AND system_name = ?`
        )
        .get(p.adapterType, p.agentId ?? null, safeName);

      if (existing) {
        this.db
          .prepare(
            `UPDATE printers
             SET display_name = ?, capabilities_json = ?, operational_state = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(
            p.displayName,
            JSON.stringify(p.capabilities),
            p.operationalState,
            existing.id
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO printers (
              id, system_name, display_name, adapter_type, agent_id,
              capabilities_json, operational_state, is_enabled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
          )
          .run(
            crypto.randomUUID(),
            safeName,
            p.displayName,
            p.adapterType,
            p.agentId ?? null,
            JSON.stringify(p.capabilities),
            p.operationalState
          );
      }
    }
  }

  listPrinters(enabledOnly = true): any[] {
    const sql = enabledOnly
      ? 'SELECT * FROM printers WHERE is_enabled = 1 ORDER BY display_name ASC'
      : 'SELECT * FROM printers ORDER BY display_name ASC';
    const rows = this.db.prepare<any>(sql).all();
    return rows.map((r) => ({
      id: r.id,
      systemName: r.system_name,
      displayName: r.display_name,
      adapterType: r.adapter_type,
      agentId: r.agent_id,
      capabilities: JSON.parse(r.capabilities_json || '{}'),
      operationalState: r.operational_state,
      isEnabled: Boolean(r.is_enabled),
      updatedAt: r.updated_at,
    }));
  }

  /**
   * TRD 4.2 & 5.2 Print Job Submission Pipeline:
   * Enforces idempotency, ownership, page resolution, atomic quota deduction,
   * ephemeral PDF slicing, and adapter dispatch.
   */
  async submitPrintJob(params: {
    requester: AuthUser;
    idempotencyKey: string;
    documentId: string;
    printerId: string;
    options: Partial<PrintJobOptions>;
    ipAddress?: string | null;
  }): Promise<{ job: PrintJobRecord; isDuplicate: boolean }> {
    const cleanIdempotencyKey = (params.idempotencyKey || '').trim();
    if (!cleanIdempotencyKey || cleanIdempotencyKey.length > 128) {
      throw new Error('INVALID_IDEMPOTENCY_KEY');
    }

    // 1. Idempotency Guard: return existing job if idempotencyKey was already submitted
    const existingRow = this.db
      .prepare<any>('SELECT * FROM print_jobs WHERE idempotency_key = ?')
      .get(cleanIdempotencyKey);
    if (existingRow) {
      if (
        params.requester.role !== 'ADMIN' &&
        existingRow.user_id !== params.requester.id
      ) {
        throw new Error('IDEMPOTENCY_KEY_CONFLICT');
      }
      return { job: this.mapJobRow(existingRow), isDuplicate: true };
    }

    // 2. Verify document access & printer availability
    const { doc, filePath: sourcePdfPath } =
      await this.documentService.resolveDocumentFilePath(
        params.documentId,
        params.requester
      );

    const printerRow = this.db
      .prepare<any>('SELECT * FROM printers WHERE id = ?')
      .get(params.printerId);
    if (!printerRow || !printerRow.is_enabled) {
      throw new Error('PRINTER_NOT_FOUND_OR_DISABLED');
    }
    const safePrinterSystemName = validateSafePrinterName(
      printerRow.system_name
    );

    const normalizedOptions: PrintJobOptions = {
      range: params.options.range ?? '',
      subset: params.options.subset ?? 'all',
      reverse: Boolean(params.options.reverse ?? false),
      copies: Number(params.options.copies ?? 1),
      duplex: params.options.duplex ?? 'none',
      colorMode: params.options.colorMode ?? 'monochrome',
      mediaSize: params.options.mediaSize ?? 'A4',
    };

    // 3. Deterministic Page-Range, Odd/Even & Reverse Resolution (TRD 4.1)
    const resolved = resolvePrintPages({
      totalPages: doc.pageCount,
      range: normalizedOptions.range,
      subset: normalizedOptions.subset,
      reverse: normalizedOptions.reverse,
      duplex: normalizedOptions.duplex,
      copies: normalizedOptions.copies,
    });

    const jobId = crypto.randomUUID();
    const tempSliceKey = `tmp/slice_${jobId}.pdf`;
    const tempSlicePath = await resolveSafeStoragePath(
      this.storageRoot,
      tempSliceKey
    );

    // 4. Atomic Quota Verification & Tentative Deduction (UPLOADED -> VALIDATED)
    this.db.transaction(() => {
      const userRow = this.db
        .prepare<any>(
          'SELECT monthly_page_quota, pages_used_current_period FROM users WHERE id = ?'
        )
        .get(params.requester.id);

      if (!userRow) {
        throw new Error('USER_NOT_FOUND');
      }

      if (
        userRow.pages_used_current_period + resolved.physicalSheets >
        userRow.monthly_page_quota
      ) {
        throw new Error(
          `QUOTA_EXCEEDED:Required ${resolved.physicalSheets} sheets, remaining ${Math.max(
            0,
            userRow.monthly_page_quota - userRow.pages_used_current_period
          )}`
        );
      }

      this.db
        .prepare(
          `UPDATE users
           SET pages_used_current_period = pages_used_current_period + ?
           WHERE id = ?`
        )
        .run(resolved.physicalSheets, params.requester.id);

      this.db
        .prepare(
          `INSERT INTO print_jobs (
            id, idempotency_key, user_id, document_id, printer_id,
            state, options_json, resolved_pages_json, logical_page_count,
            physical_sheets, quota_deducted, temp_slice_key
          ) VALUES (?, ?, ?, ?, ?, 'VALIDATED', ?, ?, ?, ?, 1, ?)`
        )
        .run(
          jobId,
          cleanIdempotencyKey,
          params.requester.id,
          doc.id,
          printerRow.id,
          JSON.stringify(normalizedOptions),
          JSON.stringify(resolved.pages),
          resolved.logicalPageCount,
          resolved.physicalSheets,
          tempSliceKey
        );
    });

    // 5. Ephemeral PDF Slicing (VALIDATED -> QUEUED)
    try {
      await this.pdfWorker.slicePdf(
        sourcePdfPath,
        tempSlicePath,
        resolved.pages
      );
      this.db
        .prepare(
          `UPDATE print_jobs
           SET state = 'QUEUED', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(jobId);
    } catch (sliceErr: any) {
      await this.failJobAndRefundQuota(
        jobId,
        `Slicer failed: ${sliceErr?.message || 'UNKNOWN_SLICE_ERROR'}`
      );
      throw sliceErr;
    }

    // 6. Dispatch to IPrintAdapter (QUEUED -> PROCESSING | FAILED | UNKNOWN)
    const adapter = this.getAdapter(printerRow.adapter_type);
    try {
      const submission = await adapter.submitJob({
        jobId,
        printerSystemName: safePrinterSystemName,
        agentId: printerRow.agent_id,
        sliceFilePath: tempSlicePath,
        sliceStorageKey: tempSliceKey,
        options: normalizedOptions,
      });

      this.db
        .prepare(
          `UPDATE print_jobs
           SET state = 'PROCESSING', cups_job_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(submission.cupsJobId, jobId);

      this.audit.log({
        actorUserId: params.requester.id,
        action: 'JOB_DISPATCHED',
        targetType: 'PRINT_JOB',
        targetId: jobId,
        details: {
          documentId: doc.id,
          printerSystemName: safePrinterSystemName,
          cupsJobId: submission.cupsJobId,
          resolvedPages: resolved.pages,
          physicalSheets: resolved.physicalSheets,
        },
        ipAddress: params.ipAddress,
      });
    } catch (dispatchErr: any) {
      const msg = String(dispatchErr?.message || '');
      if (msg.includes('TIMEOUT') || msg.includes('DISCONNECTED')) {
        // TRD 4.2 Safety Guardrail: If CUPS/Agent times out during submission,
        // enter UNKNOWN state and HALT AUTO-RETRY to prevent duplicate physical prints.
        this.db
          .prepare(
            `UPDATE print_jobs
             SET state = 'UNKNOWN', error_message = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(msg, jobId);

        this.audit.log({
          actorUserId: params.requester.id,
          action: 'JOB_UNKNOWN_HALT',
          targetType: 'PRINT_JOB',
          targetId: jobId,
          details: { reason: msg },
          ipAddress: params.ipAddress,
        });
      } else {
        await this.failJobAndRefundQuota(jobId, msg);
      }
    }

    const finalRow = this.db
      .prepare<any>('SELECT * FROM print_jobs WHERE id = ?')
      .get(jobId);
    return { job: this.mapJobRow(finalRow), isDuplicate: false };
  }

  private async unlinkTempSlice(tempSliceKey?: string | null): Promise<void> {
    if (!tempSliceKey) return;
    try {
      const safePath = await resolveSafeStoragePath(
        this.storageRoot,
        tempSliceKey
      );
      await fs.unlink(safePath).catch(() => {});
    } catch {
      // Ignore already unlinked or invalid key
    }
  }

  private async failJobAndRefundQuota(
    jobId: string,
    errorMessage: string
  ): Promise<void> {
    const jobRow = this.db
      .prepare<any>('SELECT * FROM print_jobs WHERE id = ?')
      .get(jobId);
    if (!jobRow) return;

    this.db.transaction(() => {
      if (jobRow.quota_deducted) {
        this.db
          .prepare(
            `UPDATE users
             SET pages_used_current_period = MAX(0, pages_used_current_period - ?)
             WHERE id = ?`
          )
          .run(jobRow.physical_sheets, jobRow.user_id);
      }

      this.db
        .prepare(
          `UPDATE print_jobs
           SET state = 'FAILED', quota_deducted = 0, error_message = ?,
               temp_slice_key = NULL, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(errorMessage, jobId);
    });

    await this.unlinkTempSlice(jobRow.temp_slice_key);
    await this.purgeEphemeralKioskDocumentIfNeeded(jobRow.document_id);

    this.audit.log({
      actorUserId: jobRow.user_id,
      action: 'JOB_FAILED',
      targetType: 'PRINT_JOB',
      targetId: jobId,
      details: { errorMessage },
    });
  }

  private async purgeEphemeralKioskDocumentIfNeeded(
    documentId: string
  ): Promise<void> {
    const docRow = this.db
      .prepare<any>('SELECT * FROM documents WHERE id = ?')
      .get(documentId);
    if (!docRow || !docRow.is_ephemeral_kiosk) return;

    try {
      const safeDocPath = await resolveSafeStoragePath(
        this.storageRoot,
        docRow.storage_key
      );
      await fs.unlink(safeDocPath).catch(() => {});
    } catch {
      // Ignore if already unlinked
    }

    this.db
      .prepare(
        `UPDATE kiosk_sessions
         SET status = 'PURGED'
         WHERE document_id = ?`
      )
      .run(documentId);

    this.audit.log({
      actorUserId: docRow.owner_id,
      action: 'KIOSK_FILE_PURGED',
      targetType: 'DOCUMENT',
      targetId: documentId,
      details: { storageKey: docRow.storage_key },
    });
  }

  /**
   * TRD 4.2 2-Second CUPS / Remote Agent Reconciliation Loop
   */
  async pollActiveJobs(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      const activeRows = this.db
        .prepare<any>(
          `SELECT j.*, p.system_name, p.adapter_type, p.agent_id
           FROM print_jobs j
           JOIN printers p ON p.id = j.printer_id
           WHERE j.state = 'PROCESSING'`
        )
        .all();

      for (const row of activeRows) {
        if (!row.cups_job_id) continue;
        const adapter = this.getAdapter(row.adapter_type);
        const statusRes = await adapter.getJobStatus(
          row.cups_job_id,
          row.system_name,
          row.agent_id
        );

        if (statusRes.state === 'COMPLETED') {
          this.db
            .prepare(
              `UPDATE print_jobs
               SET state = 'COMPLETED', temp_slice_key = NULL,
                   updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
            .run(row.id);

          await this.unlinkTempSlice(row.temp_slice_key);
          await this.purgeEphemeralKioskDocumentIfNeeded(row.document_id);

          this.audit.log({
            actorUserId: row.user_id,
            action: 'JOB_COMPLETE',
            targetType: 'PRINT_JOB',
            targetId: row.id,
            details: {
              cupsJobId: row.cups_job_id,
              physicalSheets: row.physical_sheets,
            },
          });
        } else if (statusRes.state === 'FAILED') {
          await this.failJobAndRefundQuota(
            row.id,
            statusRes.reason || 'CUPS reported print job failure'
          );
        } else if (statusRes.state === 'UNKNOWN') {
          // TRD 4.2: HALT AUTO-RETRY on UNKNOWN state!
          this.db
            .prepare(
              `UPDATE print_jobs
               SET state = 'UNKNOWN', error_message = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
            .run(
              statusRes.reason ||
                'Communication lost with CUPS/Agent; auto-retry halted',
              row.id
            );

          this.audit.log({
            actorUserId: row.user_id,
            action: 'JOB_UNKNOWN_HALT',
            targetType: 'PRINT_JOB',
            targetId: row.id,
            details: {
              cupsJobId: row.cups_job_id,
              reason: statusRes.reason,
            },
          });
        }
      }
    } finally {
      this.isPolling = false;
    }
  }

  getPrintJob(jobId: string, requester: AuthUser): PrintJobRecord {
    const row = this.db
      .prepare<any>('SELECT * FROM print_jobs WHERE id = ?')
      .get(jobId);
    if (!row) {
      throw new Error('PRINT_JOB_NOT_FOUND');
    }
    if (requester.role !== 'ADMIN' && row.user_id !== requester.id) {
      throw new Error('FORBIDDEN_JOB_ACCESS');
    }
    return this.mapJobRow(row);
  }

  listPrintJobs(requester: AuthUser, limit = 50): any[] {
    const sql =
      requester.role === 'ADMIN'
        ? `SELECT j.*, d.original_filename, p.display_name as printer_name, u.username
           FROM print_jobs j
           LEFT JOIN documents d ON d.id = j.document_id
           LEFT JOIN printers p ON p.id = j.printer_id
           LEFT JOIN users u ON u.id = j.user_id
           ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`
        : `SELECT j.*, d.original_filename, p.display_name as printer_name, u.username
           FROM print_jobs j
           LEFT JOIN documents d ON d.id = j.document_id
           LEFT JOIN printers p ON p.id = j.printer_id
           LEFT JOIN users u ON u.id = j.user_id
           WHERE j.user_id = ?
           ORDER BY j.created_at DESC, j.rowid DESC LIMIT ?`;

    const rows =
      requester.role === 'ADMIN'
        ? this.db.prepare<any>(sql).all(limit)
        : this.db.prepare<any>(sql).all(requester.id, limit);

    return rows.map((r) => ({
      ...this.mapJobRow(r),
      documentFilename: r.original_filename || 'Deleted Document',
      printerName: r.printer_name || 'Unknown Printer',
      username: r.username || 'guest',
    }));
  }

  async cancelPrintJob(
    jobId: string,
    requester: AuthUser,
    ipAddress?: string | null
  ): Promise<PrintJobRecord> {
    const row = this.db
      .prepare<any>(
        `SELECT j.*, p.adapter_type, p.agent_id
         FROM print_jobs j
         JOIN printers p ON p.id = j.printer_id
         WHERE j.id = ?`
      )
      .get(jobId);

    if (!row) throw new Error('PRINT_JOB_NOT_FOUND');
    if (requester.role !== 'ADMIN' && row.user_id !== requester.id) {
      throw new Error('FORBIDDEN_JOB_ACCESS');
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.state)) {
      return this.mapJobRow(row);
    }

    if (row.cups_job_id) {
      const adapter = this.getAdapter(row.adapter_type);
      await adapter.cancelJob(row.cups_job_id, row.agent_id).catch(() => {});
    }

    this.db.transaction(() => {
      if (row.quota_deducted) {
        this.db
          .prepare(
            `UPDATE users
             SET pages_used_current_period = MAX(0, pages_used_current_period - ?)
             WHERE id = ?`
          )
          .run(row.physical_sheets, row.user_id);
      }

      this.db
        .prepare(
          `UPDATE print_jobs
           SET state = 'CANCELLED', quota_deducted = 0, temp_slice_key = NULL,
               updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(jobId);
    });

    await this.unlinkTempSlice(row.temp_slice_key);
    await this.purgeEphemeralKioskDocumentIfNeeded(row.document_id);

    this.audit.log({
      actorUserId: requester.id,
      action: 'JOB_CANCELLED',
      targetType: 'PRINT_JOB',
      targetId: jobId,
      details: { cupsJobId: row.cups_job_id },
      ipAddress,
    });

    return this.getPrintJob(jobId, requester);
  }

  /**
   * Explicit User/Admin Confirmation for UNKNOWN state jobs.
   * Ensures jobs in UNKNOWN never auto-retry without human confirmation.
   */
  async resolveUnknownJob(params: {
    jobId: string;
    requester: AuthUser;
    resolution: 'CONFIRM_COMPLETED' | 'EXPLICIT_RETRY' | 'CANCEL';
    ipAddress?: string | null;
  }): Promise<PrintJobRecord> {
    const row = this.db
      .prepare<any>(
        `SELECT j.*, p.system_name, p.adapter_type, p.agent_id
         FROM print_jobs j
         JOIN printers p ON p.id = j.printer_id
         WHERE j.id = ?`
      )
      .get(params.jobId);

    if (!row) throw new Error('PRINT_JOB_NOT_FOUND');
    if (
      params.requester.role !== 'ADMIN' &&
      row.user_id !== params.requester.id
    ) {
      throw new Error('FORBIDDEN_JOB_ACCESS');
    }
    if (row.state !== 'UNKNOWN') {
      throw new Error('JOB_NOT_IN_UNKNOWN_STATE');
    }

    if (params.resolution === 'CANCEL') {
      return this.cancelPrintJob(params.jobId, params.requester, params.ipAddress);
    }

    if (params.resolution === 'CONFIRM_COMPLETED') {
      this.db
        .prepare(
          `UPDATE print_jobs
           SET state = 'COMPLETED', temp_slice_key = NULL, error_message = NULL,
               updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(row.id);

      await this.unlinkTempSlice(row.temp_slice_key);
      await this.purgeEphemeralKioskDocumentIfNeeded(row.document_id);

      this.audit.log({
        actorUserId: params.requester.id,
        action: 'JOB_UNKNOWN_CONFIRMED_COMPLETE',
        targetType: 'PRINT_JOB',
        targetId: row.id,
        ipAddress: params.ipAddress,
      });

      return this.getPrintJob(row.id, params.requester);
    }

    // EXPLICIT_RETRY: User explicitly confirmed physical print did NOT occur and requested retry
    const tempSliceKey = row.temp_slice_key || `tmp/slice_${row.id}.pdf`;
    const tempSlicePath = await resolveSafeStoragePath(
      this.storageRoot,
      tempSliceKey
    );

    const { filePath: sourcePdfPath } =
      await this.documentService.resolveDocumentFilePath(
        row.document_id,
        params.requester
      );
    const resolvedPages: number[] = JSON.parse(row.resolved_pages_json);
    await this.pdfWorker.slicePdf(sourcePdfPath, tempSlicePath, resolvedPages);

    const adapter = this.getAdapter(row.adapter_type);
    const submission = await adapter.submitJob({
      jobId: row.id,
      printerSystemName: row.system_name,
      agentId: row.agent_id,
      sliceFilePath: tempSlicePath,
      sliceStorageKey: tempSliceKey,
      options: JSON.parse(row.options_json),
    });

    this.db
      .prepare(
        `UPDATE print_jobs
         SET state = 'PROCESSING', cups_job_id = ?, temp_slice_key = ?, error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(submission.cupsJobId, tempSliceKey, row.id);

    this.audit.log({
      actorUserId: params.requester.id,
      action: 'JOB_UNKNOWN_EXPLICIT_RETRY',
      targetType: 'PRINT_JOB',
      targetId: row.id,
      details: { newCupsJobId: submission.cupsJobId },
      ipAddress: params.ipAddress,
    });

    return this.getPrintJob(row.id, params.requester);
  }

  /**
   * FR-08 Automated TTL Retention & Ephemeral File Sweeper
   */
  async runTtlCleanup(): Promise<{
    purgedDocuments: number;
    expiredKioskSessions: number;
  }> {
    const nowIso = new Date().toISOString();

    // 1. Purge expired documents
    const expiredDocs = this.db
      .prepare<any>(
        'SELECT id, storage_key FROM documents WHERE expires_at IS NOT NULL AND expires_at < ?'
      )
      .all(nowIso);

    for (const doc of expiredDocs) {
      try {
        const safePath = await resolveSafeStoragePath(
          this.storageRoot,
          doc.storage_key
        );
        await fs.unlink(safePath).catch(() => {});
      } catch {
        // Ignore
      }
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    }

    // 2. Expire old kiosk sessions
    const expiredSessions = this.db
      .prepare<any>(
        `SELECT id, document_id FROM kiosk_sessions
         WHERE status NOT IN ('PURGED', 'EXPIRED') AND expires_at < ?`
      )
      .all(nowIso);

    for (const sess of expiredSessions) {
      if (sess.document_id) {
        await this.purgeEphemeralKioskDocumentIfNeeded(sess.document_id);
      }
      this.db
        .prepare("UPDATE kiosk_sessions SET status = 'EXPIRED' WHERE id = ?")
        .run(sess.id);
    }

    return {
      purgedDocuments: expiredDocs.length,
      expiredKioskSessions: expiredSessions.length,
    };
  }
}
