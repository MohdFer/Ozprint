import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import {
  createOzPrintApp,
  OzPrintApplication,
} from '../../apps/server/src/app';
import { MockCupsAdapter } from '../helpers/MockCupsAdapter';

async function buildMultiPagePdf(pageCount = 10): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`OzPrint Integration Test — Page ${i} of ${pageCount}`, {
      x: 50,
      y: 760,
      size: 16,
    });
  }
  return Buffer.from(await doc.save());
}

describe('TRD Section 4.2, 5.2 & 7 — Orchestration, Idempotency & Layer 1–3 Integration Tests', () => {
  let tempDir: string;
  let simAdapter: MockCupsAdapter;
  let oz: OzPrintApplication;
  let authToken: string;
  let printerId: string;
  let docId: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozprint-int-test-'));
    simAdapter = new MockCupsAdapter({ autoCompleteDelayMs: 50 });

    oz = createOzPrintApp(
      {
        storageRoot: tempDir,
        sqlitePath: path.join(tempDir, 'int.db'),
        defaultAdminUsername: 'admin',
        defaultAdminPassword: 'ozprint-admin',
      },
      simAdapter
    );

    const loginRes = await request(oz.app).post('/api/auth/login').send({
      username: 'admin',
      password: 'ozprint-admin',
    });
    expect(loginRes.status).toBe(200);
    authToken = loginRes.body.token;

    const discoverRes = await request(oz.app)
      .post('/api/printers/discover')
      .set('Authorization', `Bearer ${authToken}`);
    expect(discoverRes.status).toBe(200);
    expect(discoverRes.body.printers.length).toBeGreaterThanOrEqual(1);
    printerId = discoverRes.body.printers[0].id;

    // Upload a 10-page PDF
    const pdfBuffer = await buildMultiPagePdf(10);
    const uploadRes = await request(oz.app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', pdfBuffer, 'manual_10pages.pdf');
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.document.pageCount).toBe(10);
    docId = uploadRes.body.document.id;
  });

  afterAll(async () => {
    await oz.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects spoofed PDF upload that fails magic-byte inspection', async () => {
    const fakePdf = Buffer.from('This is plain text pretending to be a PDF');
    const res = await request(oz.app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('file', fakePdf, 'spoofed.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/INVALID_FILE_MAGIC_BYTES/);
  });

  it('enforces idempotency on duplicate POST /api/print-jobs and deducts quota only once', async () => {
    const meBefore = await request(oz.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);
    const usedBefore = meBefore.body.user.pagesUsedCurrentPeriod;

    const idempotencyKey = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
    const payload = {
      idempotencyKey,
      documentId: docId,
      printerId,
      options: {
        range: '1-10',
        subset: 'odd',
        reverse: true,
        copies: 1,
        duplex: 'none',
        colorMode: 'monochrome',
        mediaSize: 'A4',
      },
    };

    const firstRes = await request(oz.app)
      .post('/api/print-jobs')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);
    expect(firstRes.status).toBe(202);
    expect(firstRes.body.resolvedPages).toEqual([9, 7, 5, 3, 1]);
    expect(firstRes.body.physicalSheets).toBe(5);

    // Duplicate POST with the same idempotencyKey
    const secondRes = await request(oz.app)
      .post('/api/print-jobs')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);
    expect(secondRes.status).toBe(202);
    expect(secondRes.body.jobId).toBe(firstRes.body.jobId);
    expect(secondRes.body.cupsJobId).toBe(firstRes.body.cupsJobId);

    // Verify quota was deducted only ONCE (5 sheets, not 10)
    const meAfter = await request(oz.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);
    expect(meAfter.body.user.pagesUsedCurrentPeriod).toBe(usedBefore + 5);

    // Wait 80ms and trigger CUPS poll -> job transitions to COMPLETED and unlinks temp slice
    await new Promise((r) => setTimeout(r, 80));
    await oz.orchestrator.pollActiveJobs();

    const completedJob = await request(oz.app)
      .get(`/api/print-jobs/${firstRes.body.jobId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(completedJob.status).toBe(200);
    expect(completedJob.body.state).toBe('COMPLETED');
  });

  it('transitions to UNKNOWN on CUPS disconnect mid-job and halts auto-retry until explicit user confirmation', async () => {
    // 1. Submit a normal job
    const submitRes = await request(oz.app)
      .post('/api/print-jobs')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        idempotencyKey: 'disconnect-test-key-001',
        documentId: docId,
        printerId,
        options: { range: '1-2', subset: 'all', copies: 1, duplex: 'none' },
      });
    expect(submitRes.status).toBe(202);
    const jobId = submitRes.body.jobId;
    const originalCupsJobId = submitRes.body.cupsJobId;

    // 2. Simulate CUPS daemon communication loss mid-job
    simAdapter.setSimulateDisconnect(true);
    await oz.orchestrator.pollActiveJobs();

    const unknownJob = await request(oz.app)
      .get(`/api/print-jobs/${jobId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(unknownJob.body.state).toBe('UNKNOWN');

    // 3. Even after CUPS reconnects, polling MUST NOT auto-retry an UNKNOWN job
    simAdapter.setSimulateDisconnect(false);
    await oz.orchestrator.pollActiveJobs();

    const stillUnknown = await request(oz.app)
      .get(`/api/print-jobs/${jobId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(stillUnknown.body.state).toBe('UNKNOWN');
    expect(stillUnknown.body.cupsJobId).toBe(originalCupsJobId);

    // 4. User explicitly confirms physical completion
    const resolveRes = await request(oz.app)
      .post(`/api/print-jobs/${jobId}/resolve-unknown`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ resolution: 'CONFIRM_COMPLETED' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.state).toBe('COMPLETED');
  });

  it('supports Layer 2 non-destructive markup, true redaction, and revision lineage', async () => {
    // 1. Annotate (Visual Markup)
    const annotateRes = await request(oz.app)
      .post(`/api/documents/${docId}/annotate`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        annotations: [
          {
            page: 1,
            type: 'stamp',
            x: 0.15,
            y: 0.15,
            text: 'APPROVED',
            color: '#16a34a',
          },
          {
            page: 2,
            type: 'mask',
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.08,
          },
        ],
        revisionNote: 'Added approval stamp and visual mask',
      });
    expect(annotateRes.status).toBe(201);
    const rev2DocId = annotateRes.body.document.id;
    expect(annotateRes.body.document.parentDocId).toBe(docId);
    expect(annotateRes.body.document.revisionNumber).toBe(2);

    // 2. True Redaction on revision 2
    const redactRes = await request(oz.app)
      .post(`/api/documents/${rev2DocId}/redact`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        redactions: [
          {
            page: 1,
            rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.1, fill: '#000000' }],
          },
        ],
      });
    expect(redactRes.status).toBe(201);
    expect(redactRes.body.document.parentDocId).toBe(rev2DocId);
    expect(redactRes.body.document.revisionNumber).toBe(3);

    // 3. Verify lineage contains all 3 revisions
    const lineageRes = await request(oz.app)
      .get(`/api/documents/${docId}/revisions`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(lineageRes.status).toBe(200);
    expect(lineageRes.body.revisions.length).toBe(3);
  });

  it('executes Layer 3 Personal Walk-Up QR Kiosk flow with automatic post-print file purging', async () => {
    // 1. Create Walk-Up Kiosk Session
    const sessRes = await request(oz.app)
      .post('/api/kiosk/sessions')
      .send({ printerId, maxSheetsAllowed: 25 });
    expect(sessRes.status).toBe(201);
    const token = sessRes.body.sessionToken;

    // 2. Guest uploads a 4-page PDF
    const kioskPdf = await buildMultiPagePdf(4);
    const uploadRes = await request(oz.app)
      .post(`/api/kiosk/sessions/${token}/upload`)
      .attach('file', kioskPdf, 'guest_boarding_pass.pdf');
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.session.status).toBe('UPLOADED');

    // 3. Guest prints pages 1-2
    const printRes = await request(oz.app)
      .post(`/api/kiosk/sessions/${token}/print`)
      .send({
        printerId,
        options: { range: '1-2', subset: 'all', copies: 1, duplex: 'none' },
      });
    expect(printRes.status).toBe(202);
    expect(printRes.body.session.status).toBe('PRINTING');

    // 4. CUPS poller detects completion -> automatically unlinks guest source file and marks session PURGED
    await new Promise((r) => setTimeout(r, 80));
    await oz.orchestrator.pollActiveJobs();

    const finalSess = await request(oz.app).get(`/api/kiosk/sessions/${token}`);
    expect(finalSess.status).toBe(200);
    expect(finalSess.body.session.status).toBe('PURGED');
  });

  it('converts a 10-page PDF into a 4-pages-per-sheet (N-Up) layout with borders, margins, and custom filename, and supports deleting stored PDFs', async () => {
    // 1. Convert 10-page PDF into 4-pages-per-sheet -> ceil(10 / 4) = 3 output sheets
    const nupRes = await request(oz.app)
      .post(`/api/documents/${docId}/nup-layout`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        pagesPerSheet: 4,
        withBorder: true,
        readingDirection: 'row',
        horizontalOrder: 'ltr',
        pageSize: 'A4',
        orientation: 'auto',
        outerMarginTopMm: 5,
        outerMarginBottomMm: 5,
        outerMarginLeftMm: 5,
        outerMarginRightMm: 5,
        innerMarginMm: 5,
        outputFilename: 'Q bank - converted.pdf',
      });
    expect(nupRes.status).toBe(201);
    expect(nupRes.body.document.originalFilename).toBe('Q bank - converted.pdf');
    expect(nupRes.body.document.pageCount).toBe(3);
    const convertedDocId = nupRes.body.document.id;

    // 2. Delete the converted PDF from storage & database
    const delRes = await request(oz.app)
      .delete(`/api/documents/${convertedDocId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // 3. Verify deleted PDF is no longer accessible (404)
    const getDeleted = await request(oz.app)
      .get(`/api/documents/${convertedDocId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(getDeleted.status).toBe(404);
  });
});
