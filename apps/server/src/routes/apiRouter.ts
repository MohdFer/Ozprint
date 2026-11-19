import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import archiver from 'archiver';
import { AppConfig } from '../config/env';
import {
  IDatabase,
  verifyPassword,
  hashPassword,
  hashToken,
} from '../db/database';
import {
  createAuthMiddleware,
  requireRole,
  signAuthToken,
} from '../security/auth';
import {
  runSafeBinary,
  resolveSafeStoragePath,
  validateSafePrinterName,
} from '../security/sandbox';
import { resolvePrintPages } from '../core/pageResolver';
import { DocumentService } from '../services/documentService';
import { PdfWorkerService } from '../services/pdfWorkerService';
import { AuditService } from '../services/auditService';
import { KioskService } from '../services/kioskService';
import { PrintOrchestrator } from '../orchestrator/printOrchestrator';
import { AgentHub } from '../ws/agentHub';

export interface ApiRouterDeps {
  config: AppConfig;
  db: IDatabase;
  documentService: DocumentService;
  pdfWorker: PdfWorkerService;
  auditService: AuditService;
  kioskService: KioskService;
  orchestrator: PrintOrchestrator;
  agentHub: AgentHub;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const {
    config,
    db,
    documentService,
    pdfWorker,
    auditService,
    kioskService,
    orchestrator,
    agentHub,
  } = deps;

  const router = Router();
  const requireAuth = createAuthMiddleware(db, config.jwtSecret);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 50 * 1024 * 1024, // 50 MB max upload cap
      files: 20,
    },
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many login attempts' },
  });

  // =========================================================================
  // 1. PUBLIC HEALTH & AUTHENTICATION
  // =========================================================================

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'ozprint-server',
      version: '3.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/auth/login', loginLimiter, (req: Request, res: Response) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({
        error: 'MISSING_CREDENTIALS',
        message: 'Username and password are required',
      });
    }

    const userRow = db
      .prepare<any>(
        'SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = 1'
      )
      .get(String(username).trim(), String(username).trim());

    if (!userRow || !verifyPassword(String(password), userRow.password_hash)) {
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
    }

    const token = signAuthToken(
      {
        id: userRow.id,
        username: userRow.username,
        role: userRow.role,
      },
      config.jwtSecret
    );

    res.cookie('ozprint_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: 24 * 3600 * 1000,
    });

    auditService.log({
      actorUserId: userRow.id,
      action: 'USER_LOGIN',
      targetType: 'USER',
      targetId: userRow.id,
      ipAddress: req.ip,
    });

    return res.json({
      token,
      user: {
        id: userRow.id,
        username: userRow.username,
        email: userRow.email,
        role: userRow.role,
        monthlyPageQuota: userRow.monthly_page_quota,
        pagesUsedCurrentPeriod: userRow.pages_used_current_period,
      },
    });
  });

  router.post('/auth/logout', (_req: Request, res: Response) => {
    res.clearCookie('ozprint_token');
    return res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: Request, res: Response) => {
    return res.json({ user: req.user });
  });

  // =========================================================================
  // 2. DIAGNOSTICS & DEPENDENCY HEALTH (Admin)
  // =========================================================================

  router.get(
    '/health/dependencies',
    requireAuth,
    requireRole(['ADMIN']),
    async (_req: Request, res: Response) => {
      let cupsAvailable = false;
      let cupsOutput = '';
      try {
        const lpRes = await runSafeBinary('/usr/bin/lpstat', ['-r'], 3000);
        cupsAvailable = true;
        cupsOutput = lpRes.stdout.trim();
      } catch (err: any) {
        cupsOutput = err?.message || 'Local CUPS binary not available';
      }

      let popplerAvailable = false;
      try {
        await runSafeBinary('/usr/bin/pdfinfo', ['-v'], 3000);
        popplerAvailable = true;
      } catch {
        popplerAvailable = false;
      }

      const pythonCheck = await pdfWorker.checkPythonDependencies();

      return res.json({
        status: 'ok',
        databaseDriver: db.driver,
        dependencies: {
          cups: {
            available: cupsAvailable,
            detail: cupsOutput,
          },
          popplerUtils: {
            available: popplerAvailable,
          },
          pythonWorker: pythonCheck,
        },
      });
    }
  );

  // =========================================================================
  // 3. USER & QUOTA MANAGEMENT (Admin)
  // =========================================================================

  router.get(
    '/users',
    requireAuth,
    requireRole(['ADMIN']),
    (_req: Request, res: Response) => {
      const rows = db
        .prepare<any>(
          `SELECT id, username, email, role, monthly_page_quota,
                  pages_used_current_period, is_active, created_at
           FROM users
           WHERE role != 'KIOSK_GUEST'
           ORDER BY created_at DESC`
        )
        .all();

      return res.json({
        users: rows.map((r) => ({
          id: r.id,
          username: r.username,
          email: r.email,
          role: r.role,
          monthlyPageQuota: r.monthly_page_quota,
          pagesUsedCurrentPeriod: r.pages_used_current_period,
          isActive: Boolean(r.is_active),
          createdAt: r.created_at,
        })),
      });
    }
  );

  router.post(
    '/users',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      const { username, email, password, role, monthlyPageQuota } =
        req.body || {};
      if (!username || !email || !password) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'username, email, and password are required',
        });
      }

      const validRole = role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
      const quota = Math.max(0, Number(monthlyPageQuota ?? 500));
      const newUserId = crypto.randomUUID();

      try {
        db.prepare(
          `INSERT INTO users (id, username, email, password_hash, role, monthly_page_quota, pages_used_current_period, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1)`
        ).run(
          newUserId,
          String(username).trim(),
          String(email).trim(),
          hashPassword(String(password)),
          validRole,
          quota
        );

        auditService.log({
          actorUserId: req.user!.id,
          action: 'USER_CREATED',
          targetType: 'USER',
          targetId: newUserId,
          details: { username, role: validRole, monthlyPageQuota: quota },
          ipAddress: req.ip,
        });

        return res.status(201).json({
          id: newUserId,
          username: String(username).trim(),
          email: String(email).trim(),
          role: validRole,
          monthlyPageQuota: quota,
          pagesUsedCurrentPeriod: 0,
        });
      } catch (err: any) {
        return res.status(409).json({
          error: 'USER_EXISTS',
          message: err?.message || 'Username or email already exists',
        });
      }
    }
  );

  router.patch(
    '/users/:userId',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      const { userId } = req.params;
      const { monthlyPageQuota, resetQuotaUsed, isActive, role } =
        req.body || {};

      const existing = db
        .prepare<any>('SELECT * FROM users WHERE id = ?')
        .get(userId);
      if (!existing) {
        return res.status(404).json({ error: 'USER_NOT_FOUND' });
      }

      const nextQuota =
        monthlyPageQuota !== undefined
          ? Math.max(0, Number(monthlyPageQuota))
          : existing.monthly_page_quota;
      const nextUsed = resetQuotaUsed
        ? 0
        : existing.pages_used_current_period;
      const nextActive =
        isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active;
      const nextRole =
        role && ['ADMIN', 'MEMBER'].includes(role) ? role : existing.role;

      db.prepare(
        `UPDATE users
         SET monthly_page_quota = ?, pages_used_current_period = ?, is_active = ?, role = ?
         WHERE id = ?`
      ).run(nextQuota, nextUsed, nextActive, nextRole, userId);

      auditService.log({
        actorUserId: req.user!.id,
        action: 'USER_UPDATED',
        targetType: 'USER',
        targetId: userId,
        details: { monthlyPageQuota: nextQuota, resetQuotaUsed, isActive: nextActive, role: nextRole },
        ipAddress: req.ip,
      });

      return res.json({ ok: true });
    }
  );

  // =========================================================================
  // 4. PRINTERS & REMOTE AGENTS
  // =========================================================================

  router.get('/printers', requireAuth, (_req: Request, res: Response) => {
    const printers = orchestrator.listPrinters(true);
    return res.json({ printers });
  });

  router.delete(
    '/printers/:printerId',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      orchestrator.deletePrinter(req.params.printerId, req.user!.id);
      return res.json({ ok: true, printers: orchestrator.listPrinters(true) });
    }
  );

  router.post(
    '/printers/discover',
    requireAuth,
    requireRole(['ADMIN']),
    async (req: Request, res: Response) => {
      try {
        const printers = await orchestrator.discoverLocalPrinters(req.user!.id);
        return res.json({ printers });
      } catch (err: any) {
        return res.status(400).json({
          error: 'PRINTER_DISCOVERY_FAILED',
          message: err?.message,
        });
      }
    }
  );

  router.post(
    '/printers',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      try {
        const { systemName, displayName, capabilities } = req.body || {};
        const safeSystemName = validateSafePrinterName(systemName);
        orchestrator.upsertDiscoveredPrinters([
          {
            systemName: safeSystemName,
            displayName: displayName || safeSystemName,
            adapterType: 'LOCAL_CUPS',
            agentId: null,
            capabilities: capabilities || {
              color: false,
              duplex: true,
              media: ['A4', 'Letter'],
            },
            operationalState: 'IDLE',
          },
        ]);
        return res.status(201).json({
          printers: orchestrator.listPrinters(false),
        });
      } catch (err: any) {
        return res.status(400).json({
          error: 'INVALID_PRINTER_CONFIGURATION',
          message: err?.message,
        });
      }
    }
  );

  router.get(
    '/agents',
    requireAuth,
    requireRole(['ADMIN']),
    (_req: Request, res: Response) => {
      return res.json({ agents: agentHub.listAgents() });
    }
  );

  router.post(
    '/agents/enroll',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      const { name } = req.body || {};
      const enrolled = agentHub.enrollAgent(
        String(name || 'Remote Branch Agent'),
        req.user!.id
      );
      return res.status(201).json(enrolled);
    }
  );

  router.post(
    '/agents/:agentId/revoke',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      agentHub.revokeAgent(req.params.agentId, req.user!.id);
      return res.json({ ok: true });
    }
  );

  // =========================================================================
  // 5. MANAGED DOCUMENT LIBRARY, FOLDERS, MARKUP, REDACTION & CONVERSIONS
  // =========================================================================

  router.get('/folders', requireAuth, (req: Request, res: Response) => {
    return res.json({ folders: documentService.listFolders(req.user!) });
  });

  router.post('/folders', requireAuth, (req: Request, res: Response) => {
    const { name, parentFolderId } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'FOLDER_NAME_REQUIRED' });
    }
    const folder = documentService.createFolder(
      req.user!,
      String(name),
      parentFolderId || null
    );
    return res.status(201).json({ folder });
  });

  router.delete(
    '/folders/:folderId',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        documentService.deleteFolder(req.params.folderId, req.user!);
        return res.json({ ok: true });
      } catch (err: any) {
        const status = err?.message === 'FORBIDDEN' ? 403 : 404;
        return res.status(status).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/documents',
    requireAuth,
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({
            error: 'FILE_REQUIRED',
            message: 'Multipart field "file" is required',
          });
        }

        let tags: string[] = [];
        if (req.body?.tags) {
          tags = Array.isArray(req.body.tags)
            ? req.body.tags
            : JSON.parse(req.body.tags);
        }

        const doc = await documentService.uploadDocument({
          owner: req.user!,
          originalFilename: req.file.originalname,
          buffer: req.file.buffer,
          folderId: req.body?.folderId || null,
          tags,
          isEphemeralKiosk: req.user!.role === 'KIOSK_GUEST',
          ipAddress: req.ip,
        });

        return res.status(201).json({ document: doc });
      } catch (err: any) {
        return res.status(400).json({
          error: err?.message || 'DOCUMENT_UPLOAD_FAILED',
        });
      }
    }
  );

  router.get('/documents', requireAuth, (req: Request, res: Response) => {
    const docs = documentService.listDocuments(req.user!, {
      folderId: req.query.folderId as string | undefined,
      tag: req.query.tag as string | undefined,
      search: req.query.search as string | undefined,
    });
    return res.json({ documents: docs });
  });

  // Explicit Path Traversal Guard Route if someone queries raw storage keys
  router.get('/documents/raw', requireAuth, async (req: Request, res: Response) => {
    const storageKey = String(req.query.storageKey || '');
    try {
      await resolveSafeStoragePath(config.storageRoot, storageKey);
      return res.status(403).json({
        error: 'DIRECT_STORAGE_KEY_ACCESS_FORBIDDEN',
        message: 'Must address documents exclusively by opaque UUIDv4 docId',
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message });
    }
  });

  router.get(
    '/documents/:docId',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const doc = documentService.getDocumentById(
          req.params.docId,
          req.user!
        );
        return res.json({ document: doc });
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.patch(
    '/documents/:docId',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const doc = documentService.updateDocumentMetadata(
          req.params.docId,
          req.user!,
          {
            originalFilename: req.body?.originalFilename,
            folderId: req.body?.folderId,
            tags: req.body?.tags,
          }
        );
        return res.json({ document: doc });
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_DOCUMENT_ACCESS' ? 403 : 404;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.delete(
    '/documents/:docId',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        await documentService.deleteDocument(req.params.docId, req.user!);
        return res.json({ ok: true });
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_DOCUMENT_ACCESS' ? 403 : 404;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.get(
    '/documents/:docId/revisions',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const revisions = documentService.getDocumentRevisions(
          req.params.docId,
          req.user!
        );
        return res.json({ revisions });
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_DOCUMENT_ACCESS' ? 403 : 404;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.get(
    '/documents/:docId/stream',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { doc, filePath } =
          await documentService.resolveDocumentFilePath(
            req.params.docId,
            req.user!
          );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${encodeURIComponent(doc.originalFilename)}"`
        );
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
          if (!res.headersSent) {
            res.status(404).json({ error: 'DOCUMENT_BINARY_MISSING' });
          }
        });
        stream.pipe(res);
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/documents/:docId/annotate',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { annotations, revisionNote } = req.body || {};
        if (!Array.isArray(annotations) || annotations.length === 0) {
          return res.status(400).json({
            error: 'ANNOTATIONS_REQUIRED',
            message: 'Non-empty annotations array is required',
          });
        }

        const newRevision = await documentService.createAnnotatedRevision({
          docId: req.params.docId,
          requester: req.user!,
          annotations,
          revisionNote,
          ipAddress: req.ip,
        });

        return res.status(201).json({ document: newRevision });
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/documents/:docId/redact',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { redactions, revisionNote } = req.body || {};
        if (!Array.isArray(redactions) || redactions.length === 0) {
          return res.status(400).json({
            error: 'REDACTIONS_REQUIRED',
            message: 'Non-empty redactions specification is required',
          });
        }

        const newRevision = await documentService.createRedactedRevision({
          docId: req.params.docId,
          requester: req.user!,
          redactions,
          revisionNote,
          ipAddress: req.ip,
        });

        return res.status(201).json({ document: newRevision });
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/documents/:docId/nup-layout',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const {
          pagesPerSheet,
          withBorder,
          readingDirection,
          horizontalOrder,
          pageSize,
          orientation,
          outerMarginTopMm,
          outerMarginBottomMm,
          outerMarginLeftMm,
          outerMarginRightMm,
          innerMarginMm,
          outputFilename,
        } = req.body || {};

        const newRevision = await documentService.createNupLayoutRevision({
          docId: req.params.docId,
          requester: req.user!,
          outputFilename,
          options: {
            pagesPerSheet: Number(pagesPerSheet || 4) as any,
            withBorder: Boolean(withBorder ?? true),
            readingDirection:
              readingDirection === 'column' ? 'column' : 'row',
            horizontalOrder: horizontalOrder === 'rtl' ? 'rtl' : 'ltr',
            pageSize: pageSize || 'A4',
            orientation: orientation || 'auto',
            outerMarginTopMm: Number(outerMarginTopMm ?? 0),
            outerMarginBottomMm: Number(outerMarginBottomMm ?? 0),
            outerMarginLeftMm: Number(outerMarginLeftMm ?? 0),
            outerMarginRightMm: Number(outerMarginRightMm ?? 0),
            innerMarginMm: Number(innerMarginMm ?? 5),
          },
          ipAddress: req.ip,
        });

        return res.status(201).json({ document: newRevision });
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/documents/:docId/convert',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { doc, filePath } =
          await documentService.resolveDocumentFilePath(
            req.params.docId,
            req.user!
          );

        const format = req.body?.format === 'jpeg' ? 'jpeg' : 'png';
        const range = req.body?.range || '';
        const subset = req.body?.subset || 'all';
        const dpi = Math.max(72, Math.min(300, Number(req.body?.dpi || 200)));

        const resolved = resolvePrintPages({
          totalPages: doc.pageCount,
          range,
          subset,
        });

        const tempOutDirKey = `tmp/pdf2img_${crypto.randomUUID()}`;
        const safeOutDir = await resolveSafeStoragePath(
          config.storageRoot,
          tempOutDirKey
        );

        const imageFiles = await pdfWorker.convertPdfToImages(
          filePath,
          safeOutDir,
          resolved.pages,
          format,
          dpi
        );

        auditService.log({
          actorUserId: req.user!.id,
          action: 'DOCUMENT_CONVERT_PDF2IMG',
          targetType: 'DOCUMENT',
          targetId: doc.id,
          details: { format, pages: resolved.pages, dpi },
          ipAddress: req.ip,
        });

        const baseName = doc.originalFilename.replace(/\.pdf$/i, '');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(baseName)}_${format}.zip"`
        );

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('end', async () => {
          await fsp.rm(safeOutDir, { recursive: true, force: true }).catch(() => {});
        });
        archive.on('error', async () => {
          await fsp.rm(safeOutDir, { recursive: true, force: true }).catch(() => {});
        });

        archive.pipe(res);
        for (const imgPath of imageFiles) {
          archive.file(imgPath, { name: path.basename(imgPath) });
        }
        await archive.finalize();
      } catch (err: any) {
        const code =
          err?.message === 'FORBIDDEN_DOCUMENT_ACCESS'
            ? 403
            : err?.message === 'DOCUMENT_NOT_FOUND'
              ? 404
              : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/conversions/images-to-pdf',
    requireAuth,
    upload.array('files', 20),
    async (req: Request, res: Response) => {
      try {
        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) {
          return res.status(400).json({
            error: 'NO_IMAGES_PROVIDED',
            message: 'Upload one or more PNG/JPEG files in "files"',
          });
        }

        const doc = await documentService.compileImagesToDocument({
          owner: req.user!,
          files,
          title: req.body?.title,
          folderId: req.body?.folderId || null,
          ipAddress: req.ip,
        });

        return res.status(201).json({ document: doc });
      } catch (err: any) {
        return res.status(400).json({ error: err?.message });
      }
    }
  );

  // =========================================================================
  // 6. PRINT ORCHESTRATION & JOB LIFECYCLE
  // =========================================================================

  router.post(
    '/print-jobs/preview-pages',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const result = resolvePrintPages(req.body || {});
        return res.json(result);
      } catch (err: any) {
        return res.status(400).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/print-jobs',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { idempotencyKey, documentId, printerId, options } =
          req.body || {};
        if (!idempotencyKey || !documentId || !printerId) {
          return res.status(400).json({
            error: 'MISSING_REQUIRED_FIELDS',
            message: 'idempotencyKey, documentId, and printerId are required',
          });
        }

        const { job } = await orchestrator.submitPrintJob({
          requester: req.user!,
          idempotencyKey: String(idempotencyKey),
          documentId: String(documentId),
          printerId: String(printerId),
          options: options || {},
          ipAddress: req.ip,
        });

        // TRD Section 5.2 Response Contract (202 Accepted)
        return res.status(202).json({
          jobId: job.jobId,
          state: job.state,
          resolvedPages: job.resolvedPages,
          logicalPageCount: job.logicalPageCount,
          physicalSheets: job.physicalSheets,
          cupsJobId: job.cupsJobId,
          createdAt: job.createdAt,
        });
      } catch (err: any) {
        const msg = String(err?.message || 'PRINT_SUBMISSION_FAILED');
        const code = msg.startsWith('FORBIDDEN')
          ? 403
          : msg.startsWith('DOCUMENT_NOT_FOUND') ||
              msg.startsWith('PRINTER_NOT_FOUND')
            ? 404
            : msg.startsWith('QUOTA_EXCEEDED')
              ? 429
              : 400;
        return res.status(code).json({ error: msg });
      }
    }
  );

  router.get('/print-jobs', requireAuth, (req: Request, res: Response) => {
    const jobs = orchestrator.listPrintJobs(req.user!);
    return res.json({ jobs });
  });

  router.get(
    '/print-jobs/:jobId',
    requireAuth,
    (req: Request, res: Response) => {
      try {
        const job = orchestrator.getPrintJob(req.params.jobId, req.user!);
        return res.json(job);
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_JOB_ACCESS' ? 403 : 404;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/print-jobs/:jobId/cancel',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const job = await orchestrator.cancelPrintJob(
          req.params.jobId,
          req.user!,
          req.ip
        );
        return res.json(job);
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_JOB_ACCESS' ? 403 : 404;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/print-jobs/:jobId/resolve-unknown',
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const { resolution } = req.body || {};
        if (
          !['CONFIRM_COMPLETED', 'EXPLICIT_RETRY', 'CANCEL'].includes(
            resolution
          )
        ) {
          return res.status(400).json({
            error: 'INVALID_RESOLUTION_ACTION',
            message:
              'resolution must be CONFIRM_COMPLETED, EXPLICIT_RETRY, or CANCEL',
          });
        }

        const job = await orchestrator.resolveUnknownJob({
          jobId: req.params.jobId,
          requester: req.user!,
          resolution,
          ipAddress: req.ip,
        });
        return res.json(job);
      } catch (err: any) {
        const code = err?.message === 'FORBIDDEN_JOB_ACCESS' ? 403 : 400;
        return res.status(code).json({ error: err?.message });
      }
    }
  );

  // Remote Agent Slice Download Endpoint (authenticated via Agent Bearer Token)
  router.get(
    '/print-jobs/:jobId/agent-slice',
    async (req: Request, res: Response) => {
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'AGENT_TOKEN_REQUIRED' });
      }
      const tokenHash = hashToken(authHeader.slice(7).trim());
      const agentRow = db
        .prepare<any>(
          "SELECT * FROM agents WHERE token_hash = ? AND status != 'REVOKED'"
        )
        .get(tokenHash);
      if (!agentRow) {
        return res.status(403).json({ error: 'INVALID_AGENT_TOKEN' });
      }

      const jobRow = db
        .prepare<any>('SELECT * FROM print_jobs WHERE id = ?')
        .get(req.params.jobId);
      if (!jobRow || !jobRow.temp_slice_key) {
        return res.status(404).json({ error: 'SLICE_NOT_FOUND' });
      }

      try {
        const safePath = await resolveSafeStoragePath(
          config.storageRoot,
          jobRow.temp_slice_key
        );
        res.setHeader('Content-Type', 'application/pdf');
        fs.createReadStream(safePath).pipe(res);
      } catch {
        return res.status(404).json({ error: 'SLICE_UNAVAILABLE' });
      }
    }
  );

  // =========================================================================
  // 7. PERSONAL WALK-UP QR KIOSK MODE (Layer 3 M8)
  // =========================================================================

  router.post('/kiosk/sessions', (req: Request, res: Response) => {
    const { printerId, maxSheetsAllowed } = req.body || {};
    const session = kioskService.createWalkUpSession({
      printerId,
      maxSheetsAllowed,
      ipAddress: req.ip,
    });
    return res.status(201).json(session);
  });

  router.get('/kiosk/sessions/:token', (req: Request, res: Response) => {
    try {
      const session = kioskService.getSessionByToken(req.params.token);
      const printers = orchestrator.listPrinters(true);
      return res.json({ session, printers });
    } catch (err: any) {
      return res.status(404).json({ error: err?.message });
    }
  });

  router.post(
    '/kiosk/sessions/:token/upload',
    upload.single('file'),
    async (req: Request, res: Response) => {
      try {
        const session = kioskService.getSessionByToken(req.params.token);
        if (session.status === 'EXPIRED' || session.status === 'PURGED') {
          return res.status(410).json({ error: 'KIOSK_SESSION_EXPIRED' });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'FILE_REQUIRED' });
        }

        const guestUserRow = db
          .prepare<any>('SELECT * FROM users WHERE id = ?')
          .get(session.guestUserId);

        const doc = await documentService.uploadDocument({
          owner: {
            id: guestUserRow.id,
            username: guestUserRow.username,
            email: guestUserRow.email,
            role: 'KIOSK_GUEST',
            monthlyPageQuota: guestUserRow.monthly_page_quota,
            pagesUsedCurrentPeriod: guestUserRow.pages_used_current_period,
          },
          originalFilename: req.file.originalname,
          buffer: req.file.buffer,
          isEphemeralKiosk: true,
          ttlHours: 1,
          ipAddress: req.ip,
        });

        kioskService.linkDocumentToSession(req.params.token, doc.id);
        return res.status(201).json({
          document: doc,
          session: kioskService.getSessionByToken(req.params.token),
        });
      } catch (err: any) {
        return res.status(400).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/kiosk/sessions/:token/print',
    async (req: Request, res: Response) => {
      try {
        const session = kioskService.getSessionByToken(req.params.token);
        if (!session.documentId) {
          return res
            .status(400)
            .json({ error: 'NO_DOCUMENT_UPLOADED_TO_SESSION' });
        }

        const printers = orchestrator.listPrinters(true);
        const targetPrinterId =
          req.body?.printerId || session.printerId || printers[0]?.id;
        if (!targetPrinterId) {
          return res.status(400).json({ error: 'NO_PRINTER_AVAILABLE' });
        }

        const guestUserRow = db
          .prepare<any>('SELECT * FROM users WHERE id = ?')
          .get(session.guestUserId);

        const { job } = await orchestrator.submitPrintJob({
          requester: {
            id: guestUserRow.id,
            username: guestUserRow.username,
            email: guestUserRow.email,
            role: 'KIOSK_GUEST',
            monthlyPageQuota: guestUserRow.monthly_page_quota,
            pagesUsedCurrentPeriod: guestUserRow.pages_used_current_period,
          },
          idempotencyKey:
            req.body?.idempotencyKey || `kiosk_job_${session.sessionId}`,
          documentId: session.documentId,
          printerId: targetPrinterId,
          options: req.body?.options || {},
          ipAddress: req.ip,
        });

        kioskService.linkJobToSession(req.params.token, job.jobId);
        return res.status(202).json({
          job,
          session: kioskService.getSessionByToken(req.params.token),
        });
      } catch (err: any) {
        return res.status(400).json({ error: err?.message });
      }
    }
  );

  router.post(
    '/kiosk/sessions/:token/purge',
    async (req: Request, res: Response) => {
      try {
        const session = await kioskService.purgeSessionFiles(req.params.token);
        return res.json({ session });
      } catch (err: any) {
        return res.status(404).json({ error: err?.message });
      }
    }
  );

  // =========================================================================
  // 8. IMMUTABLE AUDIT LOGS (Admin)
  // =========================================================================

  router.get(
    '/audit-logs',
    requireAuth,
    requireRole(['ADMIN']),
    (req: Request, res: Response) => {
      const limit = Math.min(500, Number(req.query.limit || 100));
      return res.json({ logs: auditService.listRecent(limit) });
    }
  );

  return router;
}
