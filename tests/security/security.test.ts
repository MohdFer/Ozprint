import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import {
  resolveSafeStoragePath,
  validateSafePrinterName,
  runSafeBinary,
} from '../../apps/server/src/security/sandbox';
import {
  createOzPrintApp,
  OzPrintApplication,
} from '../../apps/server/src/app';
import { MockCupsAdapter } from '../helpers/MockCupsAdapter';

async function createSamplePdfBuffer(pageCount = 3): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`OzPrint Security Test Page ${i}`, { x: 50, y: 750, size: 18 });
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

describe('TRD Section 6 & 7 — Security, Sandbox & Fuzzing Tests', () => {
  let tempDir: string;
  let oz: OzPrintApplication;
  let adminToken: string;
  let userAToken: string;
  let userBToken: string;
  let userADocId: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozprint-sec-test-'));
    oz = createOzPrintApp(
      {
        storageRoot: tempDir,
        sqlitePath: path.join(tempDir, 'sec.db'),
        defaultAdminUsername: 'admin',
        defaultAdminPassword: 'admin-password',
      },
      new MockCupsAdapter()
    );

    // Login as Admin
    const adminLogin = await request(oz.app).post('/api/auth/login').send({
      username: 'admin',
      password: 'admin-password',
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.token;

    // Create User A and User B
    await request(oz.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'alice',
        email: 'alice@ozprint.local',
        password: 'alice-password',
        role: 'MEMBER',
        monthlyPageQuota: 100,
      });

    await request(oz.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username: 'bob',
        email: 'bob@ozprint.local',
        password: 'bob-password',
        role: 'MEMBER',
        monthlyPageQuota: 100,
      });

    const aliceLogin = await request(oz.app).post('/api/auth/login').send({
      username: 'alice',
      password: 'alice-password',
    });
    userAToken = aliceLogin.body.token;

    const bobLogin = await request(oz.app).post('/api/auth/login').send({
      username: 'bob',
      password: 'bob-password',
    });
    userBToken = bobLogin.body.token;

    // Alice uploads a confidential 3-page PDF
    const pdfBuf = await createSamplePdfBuffer(3);
    const uploadRes = await request(oz.app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userAToken}`)
      .attach('file', pdfBuf, 'alice_secret.pdf');
    expect(uploadRes.status).toBe(201);
    userADocId = uploadRes.body.document.id;
  });

  afterAll(async () => {
    await oz.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('blocks "../../etc/passwd" and path traversal payloads in resolveSafeStoragePath and HTTP API', async () => {
    const traversalPayloads = [
      '../../etc/passwd',
      '../../../etc/shadow',
      '..\\..\\Windows\\win.ini',
      '/etc/passwd',
      'C:\\Windows\\System32\\cmd.exe',
      'objects/2026/11/../../../../etc/passwd',
      'objects/2026/11/test\0.pdf',
    ];

    for (const payload of traversalPayloads) {
      await expect(
        resolveSafeStoragePath(tempDir, payload)
      ).rejects.toThrow('SECURITY_PATH_TRAVERSAL_BLOCKED');

      const res = await request(oz.app)
        .get('/api/documents/raw')
        .set('Authorization', `Bearer ${userAToken}`)
        .query({ storageKey: payload });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('SECURITY_PATH_TRAVERSAL_BLOCKED');
    }
  });

  it('enforces strict RBAC & cross-user document isolation (403 Forbidden)', async () => {
    // Bob attempts to view Alice's document metadata
    const getMeta = await request(oz.app)
      .get(`/api/documents/${userADocId}`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(getMeta.status).toBe(403);

    // Bob attempts to stream Alice's PDF binary
    const getStream = await request(oz.app)
      .get(`/api/documents/${userADocId}/stream`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(getStream.status).toBe(403);

    // Bob attempts to annotate Alice's PDF
    const postAnnotate = await request(oz.app)
      .post(`/api/documents/${userADocId}/annotate`)
      .set('Authorization', `Bearer ${userBToken}`)
      .send({
        annotations: [{ page: 1, type: 'text', x: 0.1, y: 0.1, text: 'hacked' }],
      });
    expect(postAnnotate.status).toBe(403);

    // Bob attempts to delete Alice's PDF
    const delRes = await request(oz.app)
      .delete(`/api/documents/${userADocId}`)
      .set('Authorization', `Bearer ${userBToken}`);
    expect(delRes.status).toBe(403);

    // Bob attempts to access Admin dependency diagnostics
    const adminRoute = await request(oz.app)
      .get('/api/health/dependencies')
      .set('Authorization', `Bearer ${userBToken}`);
    expect(adminRoute.status).toBe(403);
  });

  it('rejects shell metacharacters and argument flags in printer names with 400 and zero shell execution', async () => {
    const maliciousPrinterNames = [
      'HP_LaserJet; rm -rf /',
      '$(whoami)',
      '`id`',
      'Printer | cat /etc/passwd',
      '-oProxyCommand=evil',
      '--help',
      '../printer',
    ];

    for (const badName of maliciousPrinterNames) {
      expect(() => validateSafePrinterName(badName)).toThrow(
        /SECURITY_INVALID_PRINTER_NAME/
      );

      const res = await request(oz.app)
        .post('/api/printers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ systemName: badName, displayName: 'Injected Printer' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PRINTER_CONFIGURATION');
    }
  });

  it('rejects non-allowlisted binaries in runSafeBinary', async () => {
    await expect(
      runSafeBinary('/bin/sh' as any, ['-c', 'echo pwned'])
    ).rejects.toThrow(/SECURITY_DISALLOWED_BINARY/);
  });

  it('enforces immutable audit_logs table against SQL UPDATE and DELETE', () => {
    expect(() => {
      oz.db.prepare("UPDATE audit_logs SET action = 'TAMPERED'").run();
    }).toThrow(/AUDIT_LOGS_IMMUTABLE/);

    expect(() => {
      oz.db.prepare('DELETE FROM audit_logs').run();
    }).toThrow(/AUDIT_LOGS_IMMUTABLE/);
  });
});
