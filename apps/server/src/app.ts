import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { AppConfig, loadConfig } from './config/env';
import { initializeDatabase, IDatabase } from './db/database';
import { IPrintAdapter } from './adapters/IPrintAdapter';
import { LocalCupsAdapter } from './adapters/LocalCupsAdapter';
import { RemoteAgentAdapter } from './adapters/RemoteAgentAdapter';
import { PdfWorkerService } from './services/pdfWorkerService';
import { AuditService } from './services/auditService';
import { DocumentService } from './services/documentService';
import { KioskService } from './services/kioskService';
import { PrintOrchestrator } from './orchestrator/printOrchestrator';
import { AgentHub } from './ws/agentHub';
import { createApiRouter } from './routes/apiRouter';

export interface OzPrintApplication {
  app: Express;
  server: http.Server;
  config: AppConfig;
  db: IDatabase;
  localAdapter: IPrintAdapter;
  remoteAdapter: RemoteAgentAdapter;
  agentHub: AgentHub;
  pdfWorker: PdfWorkerService;
  auditService: AuditService;
  documentService: DocumentService;
  kioskService: KioskService;
  orchestrator: PrintOrchestrator;
  close: () => Promise<void>;
}

export function createOzPrintApp(
  configOverrides: Partial<AppConfig> = {},
  customLocalAdapter?: IPrintAdapter
): OzPrintApplication {
  const config = loadConfig(configOverrides);
  fs.mkdirSync(config.storageRoot, { recursive: true });

  const db = initializeDatabase(config);
  const auditService = new AuditService(db);
  const agentHub = new AgentHub(db, auditService);
  const remoteAdapter = new RemoteAgentAdapter(agentHub);

  const localAdapter: IPrintAdapter =
    customLocalAdapter || new LocalCupsAdapter(config.cupsTimeoutMs);

  const pdfWorker = new PdfWorkerService(config.pythonBinary);
  const documentService = new DocumentService(
    db,
    config.storageRoot,
    pdfWorker,
    auditService,
    config.documentTtlHours
  );
  const kioskService = new KioskService(
    db,
    config.storageRoot,
    config.jwtSecret,
    auditService,
    config.kioskSessionTtlMinutes
  );

  const orchestrator = new PrintOrchestrator(
    db,
    config.storageRoot,
    localAdapter,
    remoteAdapter,
    pdfWorker,
    documentService,
    auditService,
    config.cupsPollIntervalMs,
    config.cleanupIntervalMs
  );

  const app = express();
  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    '/api',
    createApiRouter({
      config,
      db,
      documentService,
      pdfWorker,
      auditService,
      kioskService,
      orchestrator,
      agentHub,
    })
  );

  // Serve built React SPA static assets in production
  const webDistDir = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  agentHub.attachToServer(server);

  const close = async () => {
    orchestrator.stopBackgroundWorkers();
    await new Promise<void>((resolve) => {
      if (server.listening) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
    db.close();
  };

  return {
    app,
    server,
    config,
    db,
    localAdapter,
    remoteAdapter,
    agentHub,
    pdfWorker,
    auditService,
    documentService,
    kioskService,
    orchestrator,
    close,
  };
}
