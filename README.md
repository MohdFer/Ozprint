# OzPrint

**Open-Source Self-Hosted Document Management & Print Orchestration Platform**

[![Version](https://img.shields.io/badge/version-3.0.0-16a34a.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](package.json)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776ab.svg)](workers/pdf_worker.py)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**OzPrint** is a self-hosted, open-source web platform that unifies opaque document storage, interactive PDF.js previewing, granular page slicing (`range`, `odd/even`, `reverse` manual duplexing), multi-page-per-sheet (**N-Up**) layout conversion, non-destructive Fabric.js markup, isolated rasterized true redaction, format conversions (`PDF ↔ Images`), and physical print orchestration inside a single deployable modular monolith.

---

## Table of Contents

1. [Deployment Topologies: Direct Server vs. Remote Agent](#1-deployment-topologies-direct-server-vs-remote-agent)
2. [System Architecture](#2-system-architecture)
3. [Feature Overview (Three-Layer Architecture)](#3-feature-overview-three-layer-architecture)
4. [Quick Start (Docker & Bare-Metal Linux)](#4-quick-start-docker--bare-metal-linux)
5. [Local Development & Automated Test Suite](#5-local-development--automated-test-suite)
6. [Configuration Reference (`.env`)](#6-configuration-reference-env)
7. [Documentation & Open-Source Guides](#7-documentation--open-source-guides)

---

## 1. Deployment Topologies: Direct Server vs. Remote Agent

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

## 2. System Architecture

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

## 3. Feature Overview (Three-Layer Architecture)

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

## 4. Quick Start (Docker & Bare-Metal Linux)

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

## 5. Local Development & Automated Test Suite

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

## 6. Configuration Reference (`.env`)

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

## 7. Documentation & Open-Source Guides

- **[AGENTS.md](AGENTS.md)** — Complete guide to Remote Print Agents (how they work, when to use them vs. direct server printing) + AI Coding Agent repository rules.
- **[docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)** — Architecture deep-dive, database schema, N-Up layout math, state machine internals, and testing guide.
- **[docs/API_REFERENCE.md](docs/API_REFERENCE.md)** — Complete REST API & WebSocket protocol reference for external ERP integrations (`eliteERP`).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Contribution workflow, code style, and pull request requirements.
- **[SECURITY.md](SECURITY.md)** — Security sandboxing model, threat mitigations, and vulnerability disclosure policy.

---

## License

Released under the [MIT License](LICENSE).
