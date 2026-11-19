import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IDatabase } from '../db/database';
import { resolveSafeStoragePath } from '../security/sandbox';
import { inspectMagicBytes } from '../core/magicBytes';
import {
  PdfWorkerService,
  AnnotationObject,
  RedactionPageSpec,
  NupLayoutOptions,
} from './pdfWorkerService';
import { AuditService } from './auditService';
import { AuthUser } from '../security/auth';

export interface DocumentRecord {
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
  isEphemeralKiosk: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export class DocumentService {
  constructor(
    private readonly db: IDatabase,
    private readonly storageRoot: string,
    private readonly pdfWorker: PdfWorkerService,
    private readonly audit: AuditService,
    private readonly defaultTtlHours = 168
  ) {}

  private mapRow(row: any): DocumentRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      parentDocId: row.parent_doc_id,
      folderId: row.folder_id,
      originalFilename: row.original_filename,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      fileSizeBytes: row.file_size_bytes,
      pageCount: row.page_count,
      sha256Checksum: row.sha256_checksum,
      tags: JSON.parse(row.tags_json || '[]'),
      revisionNumber: row.revision_number || 1,
      revisionNote: row.revision_note || null,
      isEphemeralKiosk: Boolean(row.is_ephemeral_kiosk),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private buildOpaqueStorageKey(ext = 'pdf'): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const randUuid = crypto.randomUUID();
    return `objects/${yyyy}/${mm}/${randUuid}.${ext}`;
  }

  /**
   * FR-01 Opaque Document Upload & Validation:
   * Inspects magic bytes, converts standalone images to standardized PDFs if needed,
   * verifies page count, computes SHA-256, and stores under non-guessable UUIDv4 keys.
   */
  async uploadDocument(params: {
    owner: AuthUser;
    originalFilename: string;
    buffer: Buffer;
    folderId?: string | null;
    tags?: string[];
    isEphemeralKiosk?: boolean;
    ttlHours?: number;
    ipAddress?: string | null;
  }): Promise<DocumentRecord> {
    const detected = inspectMagicBytes(params.buffer);
    const docId = crypto.randomUUID();
    const storageKey = this.buildOpaqueStorageKey('pdf');
    const safeDestPath = await resolveSafeStoragePath(this.storageRoot, storageKey);
    await fs.mkdir(path.dirname(safeDestPath), { recursive: true });

    if (detected.mimeType === 'application/pdf') {
      await fs.writeFile(safeDestPath, params.buffer);
    } else {
      // Single image uploaded -> automatically compile into a 1-page standardized PDF
      const tempImgKey = `tmp/upload_${crypto.randomUUID()}.${detected.extension}`;
      const safeTempImgPath = await resolveSafeStoragePath(
        this.storageRoot,
        tempImgKey
      );
      await fs.mkdir(path.dirname(safeTempImgPath), { recursive: true });
      await fs.writeFile(safeTempImgPath, params.buffer);
      try {
        await this.pdfWorker.compileImagesToPdf(
          [{ path: safeTempImgPath, mimeType: detected.mimeType }],
          safeDestPath
        );
      } finally {
        await fs.unlink(safeTempImgPath).catch(() => {});
      }
    }

    let inspectRes;
    try {
      inspectRes = await this.pdfWorker.inspectPdf(safeDestPath);
    } catch (err) {
      await fs.unlink(safeDestPath).catch(() => {});
      throw new Error('CORRUPT_OR_ENCRYPTED_PDF');
    }

    const finalBytes = await fs.readFile(safeDestPath);
    const sha256Checksum = crypto
      .createHash('sha256')
      .update(finalBytes)
      .digest('hex');

    const ttl = params.ttlHours ?? this.defaultTtlHours;
    const expiresAt =
      ttl > 0
        ? new Date(Date.now() + ttl * 3600 * 1000).toISOString()
        : null;

    const cleanDisplayFilename =
      path.basename(params.originalFilename || 'document.pdf').slice(0, 240) ||
      'document.pdf';

    this.db
      .prepare(
        `INSERT INTO documents (
          id, owner_id, parent_doc_id, folder_id, original_filename,
          storage_key, mime_type, file_size_bytes, page_count, sha256_checksum,
          tags_json, revision_number, revision_note, is_ephemeral_kiosk, expires_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, 1, 'Initial upload', ?, ?)`
      )
      .run(
        docId,
        params.owner.id,
        params.folderId || null,
        cleanDisplayFilename,
        storageKey,
        finalBytes.length,
        inspectRes.pageCount,
        sha256Checksum,
        JSON.stringify(params.tags || []),
        params.isEphemeralKiosk ? 1 : 0,
        expiresAt
      );

    this.audit.log({
      actorUserId: params.owner.id,
      action: 'DOCUMENT_UPLOAD',
      targetType: 'DOCUMENT',
      targetId: docId,
      details: {
        originalFilename: cleanDisplayFilename,
        pageCount: inspectRes.pageCount,
        fileSizeBytes: finalBytes.length,
        sha256Checksum,
      },
      ipAddress: params.ipAddress,
    });

    return this.getDocumentById(docId, params.owner);
  }

  getDocumentById(docId: string, requester: AuthUser): DocumentRecord {
    const row = this.db
      .prepare<any>('SELECT * FROM documents WHERE id = ?')
      .get(docId);

    if (!row) {
      throw new Error('DOCUMENT_NOT_FOUND');
    }

    if (requester.role !== 'ADMIN' && row.owner_id !== requester.id) {
      throw new Error('FORBIDDEN_DOCUMENT_ACCESS');
    }

    return this.mapRow(row);
  }

  async resolveDocumentFilePath(
    docId: string,
    requester: AuthUser
  ): Promise<{ doc: DocumentRecord; filePath: string }> {
    const doc = this.getDocumentById(docId, requester);
    const filePath = await resolveSafeStoragePath(
      this.storageRoot,
      doc.storageKey
    );
    return { doc, filePath };
  }

  listDocuments(
    requester: AuthUser,
    filters?: {
      folderId?: string;
      tag?: string;
      search?: string;
    }
  ): DocumentRecord[] {
    let sql = 'SELECT * FROM documents WHERE is_ephemeral_kiosk = 0';
    const params: any[] = [];

    if (requester.role !== 'ADMIN') {
      sql += ' AND owner_id = ?';
      params.push(requester.id);
    }

    if (filters?.folderId) {
      sql += ' AND folder_id = ?';
      params.push(filters.folderId);
    }

    if (filters?.search) {
      sql += ' AND LOWER(original_filename) LIKE ?';
      params.push(`%${filters.search.toLowerCase()}%`);
    }

    sql += ' ORDER BY created_at DESC, rowid DESC';
    const rows = this.db.prepare<any>(sql).all(...params);
    let docs = rows.map((r) => this.mapRow(r));

    if (filters?.tag) {
      const targetTag = filters.tag.toLowerCase();
      docs = docs.filter((d) =>
        d.tags.some((t) => t.toLowerCase() === targetTag)
      );
    }

    return docs;
  }

  updateDocumentMetadata(
    docId: string,
    requester: AuthUser,
    updates: {
      originalFilename?: string;
      folderId?: string | null;
      tags?: string[];
    }
  ): DocumentRecord {
    const doc = this.getDocumentById(docId, requester);
    const nextFilename = updates.originalFilename
      ? path.basename(updates.originalFilename).slice(0, 240)
      : doc.originalFilename;
    const nextFolderId =
      updates.folderId !== undefined ? updates.folderId : doc.folderId;
    const nextTags = updates.tags !== undefined ? updates.tags : doc.tags;

    this.db
      .prepare(
        `UPDATE documents
         SET original_filename = ?, folder_id = ?, tags_json = ?
         WHERE id = ?`
      )
      .run(nextFilename, nextFolderId, JSON.stringify(nextTags), doc.id);

    return this.getDocumentById(doc.id, requester);
  }

  getDocumentRevisions(docId: string, requester: AuthUser): DocumentRecord[] {
    const current = this.getDocumentById(docId, requester);
    // Find root document by walking up parent_doc_id
    let rootId = current.id;
    let cursor: DocumentRecord | undefined = current;
    const visited = new Set<string>();
    while (cursor && cursor.parentDocId && !visited.has(cursor.parentDocId)) {
      visited.add(cursor.id);
      const parentRow = this.db
        .prepare<any>('SELECT * FROM documents WHERE id = ?')
        .get(cursor.parentDocId);
      if (!parentRow) break;
      rootId = parentRow.id;
      cursor = this.mapRow(parentRow);
    }

    // Collect all revisions sharing the lineage
    const allUserDocs = this.listDocuments(requester);
    const lineageIds = new Set<string>([rootId]);
    let added = true;
    while (added) {
      added = false;
      for (const d of allUserDocs) {
        if (d.parentDocId && lineageIds.has(d.parentDocId) && !lineageIds.has(d.id)) {
          lineageIds.add(d.id);
          added = true;
        }
      }
    }

    return allUserDocs
      .filter((d) => lineageIds.has(d.id))
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
  }

  /**
   * FR-05 Non-Destructive PDF Markup & Annotation Export:
   * Flattens Fabric.js annotations into a new revision without mutating the source document.
   */
  async createAnnotatedRevision(params: {
    docId: string;
    requester: AuthUser;
    annotations: AnnotationObject[];
    revisionNote?: string;
    ipAddress?: string | null;
  }): Promise<DocumentRecord> {
    const { doc, filePath } = await this.resolveDocumentFilePath(
      params.docId,
      params.requester
    );
    const newDocId = crypto.randomUUID();
    const newStorageKey = this.buildOpaqueStorageKey('pdf');
    const newFilePath = await resolveSafeStoragePath(
      this.storageRoot,
      newStorageKey
    );

    const { pageCount } = await this.pdfWorker.flattenAnnotations(
      filePath,
      newFilePath,
      params.annotations
    );

    const newBytes = await fs.readFile(newFilePath);
    const sha256Checksum = crypto
      .createHash('sha256')
      .update(newBytes)
      .digest('hex');

    const nextRevNumber = doc.revisionNumber + 1;
    const baseName = doc.originalFilename.replace(/\.pdf$/i, '');
    const revFilename = `${baseName} (v${nextRevNumber}).pdf`;

    this.db
      .prepare(
        `INSERT INTO documents (
          id, owner_id, parent_doc_id, folder_id, original_filename,
          storage_key, mime_type, file_size_bytes, page_count, sha256_checksum,
          tags_json, revision_number, revision_note, is_ephemeral_kiosk, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        newDocId,
        doc.ownerId,
        doc.id,
        doc.folderId,
        revFilename,
        newStorageKey,
        newBytes.length,
        pageCount,
        sha256Checksum,
        JSON.stringify(doc.tags),
        nextRevNumber,
        params.revisionNote || 'Annotated revision (Visual Markup)',
        doc.expiresAt
      );

    this.audit.log({
      actorUserId: params.requester.id,
      action: 'DOCUMENT_ANNOTATE',
      targetType: 'DOCUMENT',
      targetId: newDocId,
      details: {
        parentDocId: doc.id,
        annotationCount: params.annotations.length,
        revisionNumber: nextRevNumber,
      },
      ipAddress: params.ipAddress,
    });

    return this.getDocumentById(newDocId, params.requester);
  }

  /**
   * Section 3.2 True Redaction:
   * Strips underlying text & vectors and rasterizes redacted pages into a new revision.
   */
  async createRedactedRevision(params: {
    docId: string;
    requester: AuthUser;
    redactions: RedactionPageSpec[];
    revisionNote?: string;
    ipAddress?: string | null;
  }): Promise<DocumentRecord> {
    const { doc, filePath } = await this.resolveDocumentFilePath(
      params.docId,
      params.requester
    );
    const newDocId = crypto.randomUUID();
    const newStorageKey = this.buildOpaqueStorageKey('pdf');
    const newFilePath = await resolveSafeStoragePath(
      this.storageRoot,
      newStorageKey
    );

    const { redactedPages, totalPages } = await this.pdfWorker.trueRedactPdf(
      filePath,
      newFilePath,
      params.redactions
    );

    const newBytes = await fs.readFile(newFilePath);
    const sha256Checksum = crypto
      .createHash('sha256')
      .update(newBytes)
      .digest('hex');

    const nextRevNumber = doc.revisionNumber + 1;
    const baseName = doc.originalFilename.replace(/\.pdf$/i, '');
    const revFilename = `${baseName} (Redacted v${nextRevNumber}).pdf`;

    this.db
      .prepare(
        `INSERT INTO documents (
          id, owner_id, parent_doc_id, folder_id, original_filename,
          storage_key, mime_type, file_size_bytes, page_count, sha256_checksum,
          tags_json, revision_number, revision_note, is_ephemeral_kiosk, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        newDocId,
        doc.ownerId,
        doc.id,
        doc.folderId,
        revFilename,
        newStorageKey,
        newBytes.length,
        totalPages,
        sha256Checksum,
        JSON.stringify([...new Set([...doc.tags, 'redacted'])]),
        nextRevNumber,
        params.revisionNote ||
          `True Redaction applied to pages: ${redactedPages.join(', ')}`,
        doc.expiresAt
      );

    this.audit.log({
      actorUserId: params.requester.id,
      action: 'DOCUMENT_TRUE_REDACT',
      targetType: 'DOCUMENT',
      targetId: newDocId,
      details: {
        parentDocId: doc.id,
        redactedPages,
        revisionNumber: nextRevNumber,
      },
      ipAddress: params.ipAddress,
    });

    return this.getDocumentById(newDocId, params.requester);
  }

  /**
   * Multiple Pages Per Sheet (N-Up PDF Layout Revision):
   * Generates a new PDF revision with 2, 4, 6, 8, 9, or 16 pages per sheet,
   * custom reading direction, margins (mm), paper size, border, and output filename.
   */
  async createNupLayoutRevision(params: {
    docId: string;
    requester: AuthUser;
    options: NupLayoutOptions;
    outputFilename?: string;
    ipAddress?: string | null;
  }): Promise<DocumentRecord> {
    const { doc, filePath } = await this.resolveDocumentFilePath(
      params.docId,
      params.requester
    );
    const newDocId = crypto.randomUUID();
    const newStorageKey = this.buildOpaqueStorageKey('pdf');
    const newFilePath = await resolveSafeStoragePath(
      this.storageRoot,
      newStorageKey
    );

    const { outputPageCount, sourcePageCount } =
      await this.pdfWorker.generateNupPdf(filePath, newFilePath, params.options);

    const newBytes = await fs.readFile(newFilePath);
    const sha256Checksum = crypto
      .createHash('sha256')
      .update(newBytes)
      .digest('hex');

    const nextRevNumber = doc.revisionNumber + 1;
    const baseName = doc.originalFilename.replace(/\.pdf$/i, '');
    let finalFilename = (params.outputFilename || '').trim();
    if (!finalFilename) {
      finalFilename = `${baseName} - converted.pdf`;
    } else if (!finalFilename.toLowerCase().endsWith('.pdf')) {
      finalFilename = `${finalFilename}.pdf`;
    }
    finalFilename = path.basename(finalFilename).slice(0, 240);

    const nupCount = params.options.pagesPerSheet || 4;
    const revisionNote = `${nupCount} pages/sheet (${params.options.pageSize || 'A4'}, ${
      params.options.readingDirection === 'column' ? 'Col-by-col' : 'Row-by-row'
    })`;

    this.db
      .prepare(
        `INSERT INTO documents (
          id, owner_id, parent_doc_id, folder_id, original_filename,
          storage_key, mime_type, file_size_bytes, page_count, sha256_checksum,
          tags_json, revision_number, revision_note, is_ephemeral_kiosk, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        newDocId,
        doc.ownerId,
        doc.id,
        doc.folderId,
        finalFilename,
        newStorageKey,
        newBytes.length,
        outputPageCount,
        sha256Checksum,
        JSON.stringify([...new Set([...doc.tags, `${nupCount}-up`])]),
        nextRevNumber,
        revisionNote,
        doc.expiresAt
      );

    this.audit.log({
      actorUserId: params.requester.id,
      action: 'DOCUMENT_NUP_LAYOUT',
      targetType: 'DOCUMENT',
      targetId: newDocId,
      details: {
        parentDocId: doc.id,
        pagesPerSheet: nupCount,
        sourcePageCount,
        outputPageCount,
        outputFilename: finalFilename,
      },
      ipAddress: params.ipAddress,
    });

    return this.getDocumentById(newDocId, params.requester);
  }

  /**
   * FR-06 Compile multiple uploaded images (PNG/JPEG) into a standardized multi-page PDF.
   */
  async compileImagesToDocument(params: {
    owner: AuthUser;
    files: Array<{ originalname: string; buffer: Buffer }>;
    title?: string;
    folderId?: string | null;
    tags?: string[];
    ipAddress?: string | null;
  }): Promise<DocumentRecord> {
    if (!params.files || params.files.length === 0) {
      throw new Error('NO_IMAGES_PROVIDED');
    }

    const tempPaths: Array<{ path: string; mimeType: string }> = [];
    try {
      for (const file of params.files) {
        const sig = inspectMagicBytes(file.buffer);
        if (sig.mimeType !== 'image/png' && sig.mimeType !== 'image/jpeg') {
          throw new Error('ONLY_PNG_AND_JPEG_SUPPORTED_FOR_COMPILATION');
        }
        const tempKey = `tmp/img2pdf_${crypto.randomUUID()}.${sig.extension}`;
        const safeTempPath = await resolveSafeStoragePath(
          this.storageRoot,
          tempKey
        );
        await fs.mkdir(path.dirname(safeTempPath), { recursive: true });
        await fs.writeFile(safeTempPath, file.buffer);
        tempPaths.push({ path: safeTempPath, mimeType: sig.mimeType });
      }

      const newDocId = crypto.randomUUID();
      const storageKey = this.buildOpaqueStorageKey('pdf');
      const safeOutPath = await resolveSafeStoragePath(
        this.storageRoot,
        storageKey
      );
      const { pageCount } = await this.pdfWorker.compileImagesToPdf(
        tempPaths,
        safeOutPath
      );

      const finalBytes = await fs.readFile(safeOutPath);
      const sha256Checksum = crypto
        .createHash('sha256')
        .update(finalBytes)
        .digest('hex');

      const displayTitle =
        params.title?.trim() ||
        `${path.basename(params.files[0].originalname, path.extname(params.files[0].originalname))}_compiled.pdf`;

      const expiresAt =
        this.defaultTtlHours > 0
          ? new Date(
              Date.now() + this.defaultTtlHours * 3600 * 1000
            ).toISOString()
          : null;

      this.db
        .prepare(
          `INSERT INTO documents (
            id, owner_id, parent_doc_id, folder_id, original_filename,
            storage_key, mime_type, file_size_bytes, page_count, sha256_checksum,
            tags_json, revision_number, revision_note, is_ephemeral_kiosk, expires_at
          ) VALUES (?, ?, NULL, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, 1, 'Compiled from images', 0, ?)`
        )
        .run(
          newDocId,
          params.owner.id,
          params.folderId || null,
          displayTitle.endsWith('.pdf') ? displayTitle : `${displayTitle}.pdf`,
          storageKey,
          finalBytes.length,
          pageCount,
          sha256Checksum,
          JSON.stringify(params.tags || ['compiled']),
          expiresAt
        );

      this.audit.log({
        actorUserId: params.owner.id,
        action: 'DOCUMENT_CONVERT_IMG2PDF',
        targetType: 'DOCUMENT',
        targetId: newDocId,
        details: { imageCount: params.files.length, pageCount },
        ipAddress: params.ipAddress,
      });

      return this.getDocumentById(newDocId, params.owner);
    } finally {
      for (const item of tempPaths) {
        await fs.unlink(item.path).catch(() => {});
      }
    }
  }

  async deleteDocument(docId: string, requester: AuthUser): Promise<void> {
    const { doc, filePath } = await this.resolveDocumentFilePath(
      docId,
      requester
    );
    await fs.unlink(filePath).catch(() => {});
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    this.audit.log({
      actorUserId: requester.id,
      action: 'DOCUMENT_DELETE',
      targetType: 'DOCUMENT',
      targetId: doc.id,
      details: { originalFilename: doc.originalFilename },
    });
  }

  // Folder Management (Layer 2 M5)
  createFolder(
    owner: AuthUser,
    name: string,
    parentFolderId?: string | null
  ): { id: string; name: string; parentFolderId: string | null; createdAt: string } {
    const id = crypto.randomUUID();
    const cleanName = name.trim().slice(0, 120) || 'Untitled Folder';
    this.db
      .prepare(
        `INSERT INTO folders (id, owner_id, parent_folder_id, name)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, owner.id, parentFolderId || null, cleanName);

    const row = this.db
      .prepare<any>('SELECT * FROM folders WHERE id = ?')
      .get(id);
    return {
      id: row.id,
      name: row.name,
      parentFolderId: row.parent_folder_id,
      createdAt: row.created_at,
    };
  }

  listFolders(requester: AuthUser): any[] {
    const rows =
      requester.role === 'ADMIN'
        ? this.db
            .prepare('SELECT * FROM folders ORDER BY name ASC')
            .all()
        : this.db
            .prepare('SELECT * FROM folders WHERE owner_id = ? ORDER BY name ASC')
            .all(requester.id);

    return rows.map((r: any) => ({
      id: r.id,
      ownerId: r.owner_id,
      parentFolderId: r.parent_folder_id,
      name: r.name,
      createdAt: r.created_at,
    }));
  }

  deleteFolder(folderId: string, requester: AuthUser): void {
    const row = this.db
      .prepare<any>('SELECT * FROM folders WHERE id = ?')
      .get(folderId);
    if (!row) throw new Error('FOLDER_NOT_FOUND');
    if (requester.role !== 'ADMIN' && row.owner_id !== requester.id) {
      throw new Error('FORBIDDEN');
    }
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }
}
