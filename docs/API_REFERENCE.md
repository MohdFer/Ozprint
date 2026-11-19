# OzPrint — REST API & WebSocket Protocol Reference

This document specifies the HTTP REST endpoints and WebSocket protocol exposed by OzPrint v3.0 for browser clients, walk-up kiosks, and external ERP/POS integrations (such as `eliteERP`).

---

## 1. Authentication

OzPrint supports two authentication mechanisms on all protected `/api/*` endpoints:
1. **Bearer Token (Recommended for ERP / API Clients)**:
   ```http
   Authorization: Bearer <JWT_TOKEN>
   ```
2. **HTTP-Only Cookie (Used by Browser SPA)**:
   `Cookie: ozprint_token=<JWT_TOKEN>`

### `POST /api/auth/login`
Authenticates a user and returns a signed JWT token and profile.

**Request:**
```json
{
  "username": "admin",
  "password": "ozprint-admin"
}
```

**Response (`200 OK`):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "b6d9f3a2-1c4e-4d8a-9b2f-8e7a6c5d4e3f",
    "username": "admin",
    "email": "admin@ozprint.local",
    "role": "ADMIN",
    "monthlyPageQuota": 5000,
    "pagesUsedCurrentPeriod": 12
  }
}
```

---

## 2. Printers & Discovery

### `GET /api/printers`
Lists enabled local CUPS and remote agent printers along with their hardware capabilities.

**Response (`200 OK`):**
```json
{
  "printers": [
    {
      "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "systemName": "HP_LaserJet_M1136",
      "displayName": "HP LaserJet M1136",
      "adapterType": "LOCAL_CUPS",
      "agentId": null,
      "capabilities": {
        "color": false,
        "duplex": true,
        "media": ["A4", "Letter"]
      },
      "operationalState": "IDLE",
      "isEnabled": true
    }
  ]
}
```

### `POST /api/printers/discover` *(Role: `ADMIN`)*
Scans `/usr/bin/lpstat -p -d` and `/usr/bin/lpoptions -p <printer> -l` to register or refresh attached CUPS printers.

---

## 3. Documents, N-Up Layout, Markup, Redaction & Conversions

### `POST /api/documents`
Uploads a PDF, PNG, or JPEG file (`multipart/form-data`, field name `file`). Verifies magic bytes, computes SHA-256, and stores under an opaque UUIDv4 key.

```bash
curl -X POST http://localhost:4000/api/documents \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@invoice.pdf"
```

### `GET /api/documents`
Lists stored documents for the current user (`ADMIN` views all). Supports query filters:
- `?folderId=<uuid>`
- `?tag=<tag>`
- `?search=<filename_substring>`

### `DELETE /api/documents/:docId`
Permanently deletes a stored PDF from disk (`storage/objects/...`) and removes its metadata record.

### `GET /api/documents/:docId/stream`
Streams the raw PDF binary (`Content-Type: application/pdf`) after verifying ownership.

### `POST /api/documents/:docId/nup-layout`
Generates a **Multiple Pages Per Sheet (N-Up)** PDF revision and saves it to the user's library.

**Request:**
```json
{
  "pagesPerSheet": 4,
  "withBorder": true,
  "readingDirection": "row",
  "horizontalOrder": "ltr",
  "pageSize": "A4",
  "orientation": "auto",
  "outerMarginTopMm": 0,
  "outerMarginBottomMm": 0,
  "outerMarginLeftMm": 0,
  "outerMarginRightMm": 0,
  "innerMarginMm": 5,
  "outputFilename": "Q bank - converted.pdf"
}
```

### `POST /api/documents/:docId/annotate`
Flattens visual annotations (`text`, `signature`, `stamp`, `mask`) into a new non-destructive PDF revision via `pdf-lib`.

**Request:**
```json
{
  "annotations": [
    {
      "page": 1,
      "type": "stamp",
      "x": 0.15,
      "y": 0.12,
      "text": "APPROVED",
      "color": "#16a34a"
    }
  ],
  "revisionNote": "Stamped approved"
}
```

### `POST /api/documents/:docId/redact`
Executes isolated **True Redaction** (`workers/pdf_worker.py redact`), burning opaque rectangles and rasterizing affected pages at 300 DPI to permanently strip underlying text and vectors.

**Request:**
```json
{
  "redactions": [
    {
      "page": 1,
      "rects": [
        { "x": 0.1, "y": 0.2, "w": 0.4, "h": 0.08, "fill": "#000000" }
      ]
    }
  ],
  "revisionNote": "Redacted account numbers on page 1"
}
```

### `POST /api/documents/:docId/convert`
Converts selected PDF pages into a downloadable `.zip` archive of PNG or JPEG images.

**Request:**
```json
{
  "format": "png",
  "range": "1-3",
  "subset": "all",
  "dpi": 200
}
```

### `POST /api/conversions/images-to-pdf`
Multipart upload (`files` array of PNG/JPEG images) that compiles multiple images into a single standardized multi-page PDF document.

---

## 4. Print Job Submission & Lifecycle

### `POST /api/print-jobs`
Validates options, resolves page ranges, deducts user quota atomically, slices the PDF into `tmp/`, and dispatches the job to the target printer adapter.

> **Idempotency**: Repeating a request with the same `idempotencyKey` returns the existing job without re-slicing, re-deducting quota, or queueing a duplicate physical print.

**Request:**
```json
{
  "idempotencyKey": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "documentId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "printerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "options": {
    "range": "1-10",
    "subset": "odd",
    "reverse": true,
    "copies": 1,
    "duplex": "none",
    "colorMode": "monochrome",
    "mediaSize": "A4"
  }
}
```

**Response (`202 Accepted`):**
```json
{
  "jobId": "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
  "state": "PROCESSING",
  "resolvedPages": [9, 7, 5, 3, 1],
  "logicalPageCount": 5,
  "physicalSheets": 5,
  "cupsJobId": "HP_LaserJet_M1136-101",
  "createdAt": "2026-11-19T11:42:00.000Z"
}
```

### `GET /api/print-jobs/:jobId`
Returns live job status (`UPLOADED`, `VALIDATED`, `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`, `UNKNOWN`).

### `POST /api/print-jobs/:jobId/cancel`
Cancels an active job via `/usr/bin/cancel`, unlinks its temporary slice file, and refunds deducted page quota.

### `POST /api/print-jobs/:jobId/resolve-unknown`
Resolves a job that entered `UNKNOWN` due to CUPS/Agent communication loss:
```json
{
  "resolution": "CONFIRM_COMPLETED"
}
```
*(Valid values: `"CONFIRM_COMPLETED"`, `"EXPLICIT_RETRY"`, `"CANCEL"`)*

---

## 5. Personal Walk-Up QR Kiosk Endpoints

- `POST /api/kiosk/sessions` — Creates a short-lived walk-up guest session and QR token.
- `GET /api/kiosk/sessions/:token` — Returns session status and available printers.
- `POST /api/kiosk/sessions/:token/upload` — Uploads an ephemeral document into the session.
- `POST /api/kiosk/sessions/:token/print` — Prints the session document and schedules automatic file erasure upon completion.
- `POST /api/kiosk/sessions/:token/purge` — Immediately erases all files associated with the session.

---

## 6. Remote Print Agent WebSocket Protocol (`WS /ws/agent`)

- **Handshake Header**: `Authorization: Bearer <AGENT_ENROLLMENT_TOKEN>`
- **Agent → Server Frames**:
  - `AGENT_HELLO`: `{ "type": "AGENT_HELLO", "printers": [...] }`
  - `HEARTBEAT`: `{ "type": "HEARTBEAT", "timestamp": "2026-11-19T12:00:00Z" }`
  - `JOB_PROGRESS`: `{ "type": "JOB_PROGRESS", "jobId": "<uuid>", "cupsJobId": "<id>", "state": "PROCESSING | COMPLETED | FAILED", "reason": "..." }`
- **Server → Agent Frames**:
  - `JOB_ASSIGN`: `{ "type": "JOB_ASSIGN", "jobId": "<uuid>", "printerSystemName": "...", "sliceDownloadUrl": "/api/print-jobs/<id>/agent-slice", "options": {...} }`
  - `JOB_CANCEL`: `{ "type": "JOB_CANCEL", "cupsJobId": "<id>" }`
