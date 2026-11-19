import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { IDatabase, hashPassword } from '../db/database';
import { signAuthToken, AuthUser } from '../security/auth';
import { resolveSafeStoragePath } from '../security/sandbox';
import { AuditService } from './auditService';

export class KioskService {
  constructor(
    private readonly db: IDatabase,
    private readonly storageRoot: string,
    private readonly jwtSecret: string,
    private readonly audit: AuditService,
    private readonly defaultTtlMinutes = 30
  ) {}

  createWalkUpSession(params?: {
    printerId?: string | null;
    maxSheetsAllowed?: number;
    ttlMinutes?: number;
    ipAddress?: string | null;
  }): {
    sessionId: string;
    sessionToken: string;
    guestJwt: string;
    guestUser: AuthUser;
    maxSheetsAllowed: number;
    expiresAt: string;
  } {
    const sessionId = crypto.randomUUID();
    const sessionToken = `kiosk_${crypto.randomBytes(16).toString('hex')}`;
    const guestUserId = crypto.randomUUID();
    const guestUsername = `kiosk_guest_${sessionId.slice(0, 8)}`;
    const maxSheets = Math.max(1, Math.min(200, params?.maxSheetsAllowed ?? 50));
    const ttlMins = params?.ttlMinutes ?? this.defaultTtlMinutes;
    const expiresAt = new Date(Date.now() + ttlMins * 60 * 1000).toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO users (
            id, username, email, password_hash, role,
            monthly_page_quota, pages_used_current_period, is_active
          ) VALUES (?, ?, ?, ?, 'KIOSK_GUEST', ?, 0, 1)`
        )
        .run(
          guestUserId,
          guestUsername,
          `${guestUsername}@kiosk.ozprint.local`,
          hashPassword(crypto.randomUUID()),
          maxSheets
        );

      this.db
        .prepare(
          `INSERT INTO kiosk_sessions (
            id, session_token, guest_user_id, printer_id, status,
            max_sheets_allowed, expires_at
          ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`
        )
        .run(
          sessionId,
          sessionToken,
          guestUserId,
          params?.printerId || null,
          maxSheets,
          expiresAt
        );
    });

    const guestJwt = signAuthToken(
      { id: guestUserId, username: guestUsername, role: 'KIOSK_GUEST' },
      this.jwtSecret,
      `${ttlMins}m`
    );

    this.audit.log({
      actorUserId: guestUserId,
      action: 'KIOSK_SESSION_CREATED',
      targetType: 'KIOSK_SESSION',
      targetId: sessionId,
      details: { maxSheetsAllowed: maxSheets, expiresAt },
      ipAddress: params?.ipAddress,
    });

    return {
      sessionId,
      sessionToken,
      guestJwt,
      guestUser: {
        id: guestUserId,
        username: guestUsername,
        email: `${guestUsername}@kiosk.ozprint.local`,
        role: 'KIOSK_GUEST',
        monthlyPageQuota: maxSheets,
        pagesUsedCurrentPeriod: 0,
      },
      maxSheetsAllowed: maxSheets,
      expiresAt,
    };
  }

  getSessionByToken(sessionToken: string): any {
    const row = this.db
      .prepare<any>(
        `SELECT s.*, d.original_filename, d.page_count, j.state as job_state, j.physical_sheets
         FROM kiosk_sessions s
         LEFT JOIN documents d ON d.id = s.document_id
         LEFT JOIN print_jobs j ON j.id = s.print_job_id
         WHERE s.session_token = ?`
      )
      .get(sessionToken);

    if (!row) {
      throw new Error('KIOSK_SESSION_NOT_FOUND');
    }

    if (
      row.status !== 'PURGED' &&
      row.status !== 'EXPIRED' &&
      new Date(row.expires_at).getTime() < Date.now()
    ) {
      this.db
        .prepare("UPDATE kiosk_sessions SET status = 'EXPIRED' WHERE id = ?")
        .run(row.id);
      row.status = 'EXPIRED';
    }

    return {
      sessionId: row.id,
      sessionToken: row.session_token,
      guestUserId: row.guest_user_id,
      printerId: row.printer_id,
      documentId: row.document_id,
      documentFilename: row.original_filename || null,
      documentPageCount: row.page_count || null,
      printJobId: row.print_job_id,
      printJobState: row.job_state || null,
      physicalSheets: row.physical_sheets || null,
      status: row.status,
      maxSheetsAllowed: row.max_sheets_allowed,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  linkDocumentToSession(sessionToken: string, documentId: string): void {
    this.db
      .prepare(
        `UPDATE kiosk_sessions
         SET document_id = ?, status = 'UPLOADED'
         WHERE session_token = ?`
      )
      .run(documentId, sessionToken);
  }

  linkJobToSession(sessionToken: string, printJobId: string): void {
    this.db
      .prepare(
        `UPDATE kiosk_sessions
         SET print_job_id = ?, status = 'PRINTING'
         WHERE session_token = ?`
      )
      .run(printJobId, sessionToken);
  }

  async purgeSessionFiles(sessionToken: string): Promise<any> {
    const row = this.db
      .prepare<any>('SELECT * FROM kiosk_sessions WHERE session_token = ?')
      .get(sessionToken);
    if (!row) {
      throw new Error('KIOSK_SESSION_NOT_FOUND');
    }

    if (row.document_id) {
      const docRow = this.db
        .prepare<any>('SELECT * FROM documents WHERE id = ?')
        .get(row.document_id);
      if (docRow) {
        try {
          const safePath = await resolveSafeStoragePath(
            this.storageRoot,
            docRow.storage_key
          );
          await fs.unlink(safePath).catch(() => {});
        } catch {
          // Ignore
        }
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(docRow.id);
      }
    }

    this.db
      .prepare(
        `UPDATE kiosk_sessions
         SET status = 'PURGED', document_id = NULL
         WHERE id = ?`
      )
      .run(row.id);

    this.audit.log({
      actorUserId: row.guest_user_id,
      action: 'KIOSK_MANUAL_PURGE',
      targetType: 'KIOSK_SESSION',
      targetId: row.id,
    });

    return this.getSessionByToken(sessionToken);
  }
}
