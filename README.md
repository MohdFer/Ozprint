# OzPrint

**Open-Source Self-Hosted Document Management & Print Orchestration Platform**

[![Version](https://img.shields.io/badge/version-3.0.0-16a34a.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](package.json)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab.svg)](workers/pdf_worker.py)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**OzPrint** is a self-hosted, open-source web platform that unifies opaque document storage, interactive PDF.js previewing, granular page slicing (`range`, `odd/even`, `reverse` manual duplexing), multi-page-per-sheet (**N-Up**) layout conversion, non-destructive Fabric.js markup, isolated rasterized true redaction, format conversions (`PDF ↔ Images`), and physical print orchestration inside a single deployable modular monolith.

![OzPrint Workspace, Interactive PDF Preview & Granular Page Slicer](docs/screenshots/01-workspace-page-slicer.png)

---

## Table of Contents

1. [Visual Usage Tutorial & Step-by-Step Guide](#1-visual-usage-tutorial--step-by-step-guide)
2. [Deployment Topologies: Direct Server vs. Remote Agent](#2-deployment-topologies-direct-server-vs-remote-agent)
3. [System Architecture](#3-system-architecture)
4. [Feature Overview (Three-Layer Architecture)](#4-feature-overview-three-layer-architecture)
5. [Quick Start (Docker & Bare-Metal Linux)](#5-quick-start-docker--bare-metal-linux)
6. [Local Development & Automated Test Suite](#6-local-development--automated-test-suite)
7. [Configuration Reference (`.env`)](#7-configuration-reference-env)
8. [Documentation & Open-Source Guides](#8-documentation--open-source-guides)

---

## 1. Visual Usage Tutorial & Step-by-Step Guide

### Step 1: Upload Documents, Preview Pages & Slice for Printing

![Workspace, PDF Preview & Granular Page Slicer](docs/screenshots/01-workspace-page-slicer.png)

1. **Upload PDFs or Images**:
   - In the left **Document Library** panel, click **Upload PDF / Images**.
   - Select a `.pdf` file—or select **multiple PNG/JPG images at once** to automatically compile them into a standardized multi-page PDF.
   - Organize documents into **Folders**, search by filename, or click the **Trash (`Delete`)** icon next to any stored PDF to permanently delete it from disk and the database.
2. **Interactive PDF Preview, Markup & True Redaction (Center Panel)**:
   - Navigate pages (`<` / `>`), adjust zoom (`60%–180%`), or click **Export PNG ZIP** / **Export JPG ZIP** to download high-DPI page images.
   - Use **Text Box**, **Freehand Sign**, **Stamp** (`APPROVED`, `CONFIDENTIAL`, `DRAFT`, `PAID`), or **Visual Mask (White Box)** and click **Save Annotated Revision** to flatten annotations via `pdf-lib` into a new non-destructive revision (`v2`, `v3`...) without mutating your original upload.
   - Use **True Redaction (Strip & Rasterize)** and click **Burn True Redaction** to permanently destroy underlying vector/text data on sensitive pages by rasterizing them at 300 DPI.
3. **Granular Page Slicing & Manual Duplexing (Right Panel — `Slice & Print`)**:
   - Choose your **Target CUPS / Remote Printer**.
   - Enter **Custom Page Ranges** (e.g., `1-3, 5, 8-10`), select a **Page Subset Filter** (`All`, `Odd`, or `Even`), and toggle **Print Order** (`Normal 1 → N` vs. `Reverse N → 1` for face-up manual duplexing).
   - Check the **Live Physical Sheet Counter** to see the exact spool sequence and physical sheets required before clicking **Slice & Print**.

---

### Step 2: Convert PDFs to Multiple Pages Per Sheet (N-Up Layout)

![Multiple Pages Per Sheet (N-Up PDF Layout)](docs/screenshots/02-multi-page-per-sheet-nup.png)

Need to print lecture slides, question banks, or handouts with **2, 4, 6, 8, 9, or 16 pages on a single physical sheet**?

1. In the right panel, switch to the **Multi-Page Per Sheet** tab.
2. **PDF Page Layout**:
   - Select `2`, `4`, `6`, `8`, `9`, or `16 pages per sheet`.
   - Toggle **`with border`** to draw a crisp frame around each sub-page cell. The live diagram on the right updates immediately to preview how pages `1, 2, 3, 4...` will be positioned.
3. **Reading Direction**:
   - Choose `Row by row` or `Column by column`, and `Left to right` or `Right to left`.
4. **Page Layout & Margins**:
   - Pick the output paper size (`A4`, `A3`, `A5`, `Letter`, `Legal`) and orientation (`Automatic orientation (Standard)`, `Portrait`, or `Landscape`).
   - Adjust **Outer margin** (`Top`, `Left`, `Right`, `Bottom` in `mm`) and **Inner margin** (spacing between sub-pages in `mm`, default `5 mm`).
5. **Convert & Print**:
   - Set your **Filename after conversion** (e.g., `Q bank - converted.pdf`) and click **Convert to N Pages/Sheet**.
   - The newly generated N-Up PDF is saved to your Document Library and loaded into the previewer immediately, ready to print.

---

### Step 3: Monitor Live CUPS Jobs & Resolve `UNKNOWN` Halts Safely

![Live Print Queue & UNKNOWN Communication Halt Guardrail](docs/screenshots/04-print-queue-and-unknown-guard.png)

1. Open the **Live Print Queue** tab from the top navigation bar.
2. Every job transitions through `UPLOADED → VALIDATED → QUEUED → PROCESSING → COMPLETED` as OzPrint polls CUPS (`lpstat -W completed -o`) every 2 seconds.
3. **`UNKNOWN` Safety Guardrail (Zero Duplicate Prints)**:
   - If the CUPS daemon or a Remote Print Agent loses connectivity mid-job, OzPrint transitions the job to `UNKNOWN` and **halts auto-retry** so your printer never wastes paper printing duplicates.
   - Check the physical printer tray and click **Printed OK** (marks completed and cleans up temp slices), **Re-Spool** (explicitly re-queues the job once), or **Cancel** (cancels and refunds your page quota).

---

### Step 4: Personal Walk-Up QR Print Kiosk

![Personal Walk-Up QR Print Kiosk](docs/screenshots/03-walkup-qr-kiosk.png)

1. Open the **Walk-Up QR Kiosk** tab (also accessible directly from the login screen without signing in as an admin).
2. Scan the QR code with any smartphone on your LAN or Tailscale network to open an ephemeral guest session.
3. Tap **Select PDF, PNG, or JPEG**, choose your page range, odd/even filter, and copies, and tap **Print Now & Auto-Purge File**.
4. As soon as CUPS confirms physical completion (or if you tap **Erase File Now**), OzPrint permanently unlinks both the uploaded source file and the temporary print slice from disk.

---

### Step 5: Admin Dashboard — Discover CUPS Printers, Manage Quotas & Audit Logs

![Admin Dashboard: CUPS Printers, Agents, Quotas & Immutable Audit Logs](docs/screenshots/05-admin-printers-and-audit.png)

1. Open the **Admin, CUPS & Agents** tab (visible to `ADMIN` users).
2. **Printer Discovery**: Click **Scan CUPS (`lpstat`)** to automatically detect attached USB/network printers and parse their hardware capabilities (`lpoptions`).
3. **Remote Print Agents**: If you have a printer on a separate remote network behind NAT, enter a name and click **Enroll Agent** to generate a one-time `AGENT_ENROLLMENT_TOKEN`.
4. **User Quotas & Immutable Audit Trail**: Create `MEMBER` accounts with monthly physical sheet quotas, reset used quotas with one click, and inspect the SQLite trigger-protected **Immutable Audit Trail**.

---

## 2. Deployment Topologies: Direct Server vs. Remote Agent

OzPrint supports two ways to talk to physical printers through its pluggable `IPrintAdapter` layer:

### Topology A: Direct Single-Server Setup (Default — No Agent Needed)
Run OzPrint directly on the Linux machine (homelab server, mini-PC, Raspberry Pi, or office server) where your USB or network printer is configured in CUPS. You access the OzPrint web UI from any phone or laptop over LAN, Tailscale, or Cloudflare Tunnel and click **Print**.

```text
[Phone / Laptop Browser] ──HTTPS──> [OzPrint Server + Local CUPS] ──USB / LAN──> [Physical Printer]
```

### Topology B: Distributed Remote Print Agent Setup (Optional — For Cloud VPS or Branch Offices)
If OzPrint is hosted on a **Cloud VPS** (outside your local network) or in **Office A**, while a printer lives behind a home router/NAT firewall in **Office B**, run the lightweight `@ozprint/agent` daemon next to the remote printer. It connects **outbound** over WebSockets (`WS /ws/agent`) so zero router port-forwarding is required.

```text
[Phone / ERP] ──HTTPS──> [Cloud OzPrint Server] <══Outbound WSS══ [Remote Agent + CUPS] ──> [Printer]
```

> See **[AGENTS.md](AGENTS.md)** for a complete guide on how Remote Print Agents work and when to use them.

---

## 3. System Architecture

```mermaid
flowchart TD
    subgraph SPA["React 18 + Vite + Tailwind SPA (apps/web)"]
        Lib["Managed Document Library & Folders"]
        Slicer["PDF.js Viewer & Granular Page Slicer"]
        NUp["Multi-Page Per Sheet (N-Up) Layout Engine"]
        Markup["Fabric.js Visual Markup & True Redaction"]
        Kiosk["Personal Walk-Up QR Print Kiosk"]
    end

    subgraph Server["Node.js 20 + Express + TypeScript Monolith (apps/server)"]
        API["REST API • JWT Auth • RBAC • Rate Limiter"]
        DocSvc["Opaque Document Service & Revision Lineage"]
        Orch["Print Orchestration Engine & State Machine"]
        Poller["2-Second CUPS Poller & UNKNOWN Retry Guard"]
        Hub["Outbound Agent WebSocket Hub (/ws/agent)"]
    end

    subgraph Storage["Persistence & Document Worker"]
        DB[("SQLite (WAL Mode) / PostgreSQL")]
        FS[("Opaque UUIDv4 Object Store & tmp/ Slices")]
        Py["Python Worker (workers/pdf_worker.py)"]
    end

    subgraph Hardware["Pluggable IPrintAdapter Layer"]
        CUPS["LocalCupsAdapter (spawn /usr/bin/lp*)"]
        Remote["RemoteAgentAdapter (WS /ws/agent)"]
    end

    SPA <-->|"HTTPS REST"| API
    API --> DocSvc
    API --> Orch
    DocSvc --> DB
    DocSvc --> FS
    DocSvc <-->|"spawn python3"| Py
    Orch --> DB
    Orch --> Poller
    Orch --> CUPS
    Orch --> Remote
    Remote <--> Hub
```

---

## 4. Feature Overview (Three-Layer Architecture)

### Layer 1 — Core Printing Engine
- **Opaque UUIDv4 Storage & Magic-Byte Validation**: Verifies file headers (`%PDF-`, `PNG`, `JPEG`) via raw magic-byte inspection, computes SHA-256 checksums, stores files under non-guessable keys (`objects/YYYY/MM/<uuid>.pdf`), and supports 1-click permanent deletion from disk and database.
- **Granular Page Slicing & Manual Duplexing**:
  - Custom page ranges (`1-3, 5, 8-10`).
  - Page subset filters (`All Pages`, `Odd Pages Only`, `Even Pages Only`).
  - Print order toggle (`Normal 1 → N` vs. `Reverse N → 1` for face-up manual duplexing).
  - **Live Physical Sheet Counter**: Calculates exact physical paper sheets consumed before job submission.
- **Multiple Pages Per Sheet (N-Up Layout Converter)**:
  - Combine `2`, `4`, `6`, `8`, `9`, or `16` pages onto a single sheet (`A4`, `A3`, `A5`, `Letter`, `Legal`).
  - Configurable reading direction (`Row by row` vs. `Column by column`, `Left to right` vs. `Right to left`), automatic or fixed orientation, outer margins (`Top`, `Bottom`, `Left`, `Right` in `mm`), inner margin (`mm`), optional cell borders, and custom converted filename.
- **Persistent Job Lifecycle & `UNKNOWN` Safety Guard**:
  - Tracks jobs through `UPLOADED → VALIDATED → QUEUED → PROCESSING → COMPLETED` (plus `FAILED`, `CANCELLED`, and `UNKNOWN`) by polling `lpstat` every 2 seconds.
  - **Zero Duplicate Prints**: If communication with CUPS or a Remote Agent drops mid-job, the job enters `UNKNOWN` and **never auto-retries** without explicit user confirmation.
- **Zero-Shell Command Execution**: Invokes `/usr/bin/lp`, `/usr/bin/lpstat`, `/usr/bin/lpoptions`, and `/usr/bin/cancel` exclusively via `child_process.spawn()` with `shell: false`, strict argument arrays, regex-validated printer IDs, and `SIGKILL` execution timeouts.

### Layer 2 — Document Workspace, Markup & Format Conversions
- **Managed Document Library**: Folder hierarchies, tags, filename search, 1-click PDF deletion, and non-destructive parent-child revision history (`parent_doc_id`).
- **Interactive Annotation vs. Isolated True Redaction**:
  - **Visual Markup & Masking**: Place text boxes, freehand signatures, stamps (`APPROVED`, `CONFIDENTIAL`, `DRAFT`, `PAID`), and white-box visual masks flattened into a new PDF revision via `pdf-lib`.
  - **True Redaction**: Dedicated backend operation (`workers/pdf_worker.py redact`) that burns solid redaction blocks and rasterizes affected pages at 300 DPI, permanently stripping underlying text and vector objects.
- **Bidirectional Format Conversions**:
  - **PDF → Images**: Export selected page ranges to high-DPI PNG or JPEG `.zip` archives.
  - **Images → PDF**: Select multiple PNG/JPEG files during upload to automatically compile them into a standardized multi-page PDF.

### Layer 3 — Distributed Print Agents & Walk-Up QR Kiosk
- **Remote Print Agent Daemon (`apps/agent`)**: Outbound WebSocket daemon for printers attached to remote NAT-bound machines.
- **Personal Walk-Up QR Kiosk Mode**: Generates a scannable walk-up QR code allowing guests on mobile devices to upload a document, choose exact page ranges, dispatch a print job, and automatically purge all uploaded files immediately upon completion.

---

## 5. Quick Start (Docker & Bare-Metal Linux)

### Option A: Official Docker Compose (Recommended)

The official multi-stage Linux container bundles **Node.js 20 LTS**, **Python 3** (`pypdf`, `pdf2image`, `Pillow`), **CUPS client binaries** (`lp`, `lpstat`, `lpoptions`, `cancel`), **`poppler-utils`**, and **`better-sqlite3` (WAL mode)**.

```bash
# Build and start OzPrint on port 4000
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

> **Connecting Host CUPS to Docker on Linux**: To give the container direct access to the Linux host's local CUPS daemon, uncomment the `/var/run/cups/cups.sock:/var/run/cups/cups.sock` volume line in [`deploy/docker/docker-compose.yml`](deploy/docker/docker-compose.yml).

### Option B: Bare-Metal Ubuntu / Debian Installer (Zero-Docker)

For personal homelab laptops, Raspberry Pis, or mini-PCs running Ubuntu/Debian without Docker:

```bash
sudo bash deploy/bare-metal/install.sh
```

This script provisions a least-privilege `ozprint` system account in the `lp` group, creates `/var/lib/ozprint` (`0750`), installs OS and Python dependencies, builds the monorepo, and enables the sandboxed [`ozprint.service`](deploy/bare-metal/ozprint.service) systemd unit.

### Default Login Credentials
- **URL**: `http://localhost:4000`
- **Username**: `admin`
- **Password**: `ozprint-admin` *(change via `DEFAULT_ADMIN_PASSWORD` in `.env`)*

---

## 6. Local Development & Automated Test Suite

### Prerequisites
- **Node.js** 20 LTS or newer (`npm` 10+)
- **Python** 3.10+ (optional locally; `pdf-lib` fallback is built in if Python packages are not installed on a dev workstation)

```bash
# 1. Install workspace dependencies
npm install

# 2. Run the mandatory automated test matrix (Unit, Security & Integration)
npm test

# 3. Build all workspaces (@ozprint/server, @ozprint/web, @ozprint/agent)
npm run build

# 4. Start the production monolith server
npm start
```

For hot-reload development across backend and frontend:

```bash
# Terminal 1: Start Express API & Print Orchestrator on :4000
npm run dev:server

# Terminal 2: Start Vite React SPA with API proxy on :5173
npm run dev:web
```

---

## 7. Configuration Reference (`.env`)

Copy [`.env.example`](.env.example) to `.env` to customize your instance:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | HTTP & WebSocket listening port |
| `NODE_ENV` | `development` | `development` or `production` |
| `JWT_SECRET` | *(change in prod)* | Secret key used to sign HTTP-only cookies and Bearer tokens |
| `DB_DRIVER` | `sqlite` | `sqlite` (`better-sqlite3` WAL mode) or `postgres` |
| `SQLITE_PATH` | `./storage/ozprint.db` | Path to the SQLite database file |
| `STORAGE_ROOT` | `./storage` | Root directory for opaque `objects/` PDFs and `tmp/` print slices |
| `CUPS_POLL_INTERVAL_MS` | `2000` | Interval (ms) for polling `lpstat` on active print jobs |
| `CUPS_TIMEOUT_MS` | `15000` | Execution timeout (ms) before killing hung OS print binaries |
| `PYTHON_BINARY` | `/usr/bin/python3` | Path to the Python 3 interpreter for `workers/pdf_worker.py` |
| `DEFAULT_ADMIN_USERNAME` | `admin` | Bootstrap administrator username |
| `DEFAULT_ADMIN_PASSWORD` | `ozprint-admin` | Bootstrap administrator password |
| `DEFAULT_MONTHLY_QUOTA` | `500` | Default monthly physical sheet quota for new members |
| `DOCUMENT_TTL_HOURS` | `168` | Default retention period (hours) before stored documents expire |

---

## 8. Documentation & Open-Source Guides

- **[AGENTS.md](AGENTS.md)** — Complete guide to Remote Print Agents (how they work, when to use them vs. direct server printing) + AI Coding Agent repository rules.
- **[docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)** — Architecture deep-dive, database schema, N-Up layout math, state machine internals, and testing guide.
- **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** — Complete REST API & WebSocket protocol reference for external ERP integrations (`eliteERP`).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Contribution workflow, code style, and pull request requirements.
- **[SECURITY.md](SECURITY.md)** — Security sandboxing model, threat mitigations, and vulnerability disclosure policy.

---

## License

Released under the [MIT License](LICENSE).
