import pino from 'pino';
import { createOzPrintApp } from './app';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

async function main() {
  const oz = createOzPrintApp();
  oz.orchestrator.startBackgroundWorkers();

  // Auto-discover printers on startup
  try {
    const printers = await oz.orchestrator.discoverLocalPrinters();
    logger.info({ printerCount: printers.length }, 'Discovered local printers');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Initial printer discovery skipped');
  }

  oz.server.listen(oz.config.port, '0.0.0.0', () => {
    logger.info(
      {
        port: oz.config.port,
        env: oz.config.nodeEnv,
        dbDriver: oz.db.driver,
        storageRoot: oz.config.storageRoot,
      },
      'OzPrint Modular Monolith Server listening'
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down OzPrint server');
    await oz.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});
