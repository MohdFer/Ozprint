# Security Policy & Sandboxing Architecture

OzPrint bridges browser-based file uploads with physical OS print spoolers (`CUPS`). Because print servers often run inside trusted office LANs or personal homelabs exposed via Tailscale or Cloudflare Tunnel, security boundaries are enforced at every layer.

---

## 1. Built-In Security Controls

### 1.1 Zero-Shell Subprocess Execution
- All OS binaries (`/usr/bin/lp`, `/usr/bin/lpstat`, `/usr/bin/lpoptions`, `/usr/bin/cancel`, `/usr/bin/python3`) are invoked exclusively via `runSafeBinary()` in [`apps/server/src/security/sandbox.ts`](apps/server/src/security/sandbox.ts) using `child_process.spawn` with `shell: false` and a stripped environment (`PATH: '/usr/bin:/bin'`, `LC_ALL: 'C'`).
- Printer system names and CUPS job IDs are validated against strict allowlist regular expressions (`^[a-zA-Z0-9_.-]+$`) and rejected if they begin with `-` (preventing argument flag injection).
- Every subprocess is wrapped in a hard timeout timer that sends `SIGKILL` if execution exceeds `CUPS_TIMEOUT_MS`.

### 1.2 Opaque UUIDv4 Storage & Canonical Path Guard
- Uploaded files never use their original filename on disk. Files are stored under randomized UUIDv4 storage keys (`objects/YYYY/MM/<uuid>.pdf`).
- Every filesystem read, stream, slice, and unlink passes through `resolveSafeStoragePath(storageRoot, storageKey)`, which resolves canonical paths via `fs.realpath()` and blocks directory traversal (`../../etc/passwd`), null-byte injection, and symlink escapes.

### 1.3 Magic-Byte Header Inspection
- Uploads are inspected at the raw byte level (`%PDF-` `25 50 44 46 2D`, PNG `89 50 4E 47`, JPEG `FF D8 FF`) before touching disk or the PDF worker.

### 1.4 True Redaction vs. Visual Masking Isolation
- Visual white-box overlays in the markup canvas are explicitly labeled **Visual Masking**.
- **True Redaction** (`POST /api/documents/:docId/redact`) rasterizes affected pages into pixel buffers before burning opaque redaction boxes and rebuilding the PDF, permanently destroying underlying vector and text objects on redacted pages.

### 1.5 Least-Privilege Systemd & Container Hardening
- Both the official [`Dockerfile`](deploy/docker/Dockerfile) and bare-metal [`ozprint.service`](deploy/bare-metal/ozprint.service) run as a non-login `ozprint` user belonging solely to the `lp` group.
- `ozprint.service` enforces `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, and restricts writes to `ReadWritePaths=/var/lib/ozprint`.

---

## 2. Reporting a Vulnerability

If you discover a security vulnerability in OzPrint:
1. **Do not open a public GitHub issue.**
2. Report the vulnerability privately via GitHub Security Advisories on [`https://github.com/MohdFer/OzPrint/security/advisories`](https://github.com/MohdFer/OzPrint/security/advisories) or contact the repository maintainer directly.
3. Include steps to reproduce, affected endpoints or components, and impact assessment.
