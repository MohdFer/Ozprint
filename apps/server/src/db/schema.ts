/**
 * TRD Section 3 — SQLite & PostgreSQL Compatible DDL Schema
 */

export const COMMON_SCHEMA_DDL = `
-- 1. Users & Quotas
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'KIOSK_GUEST')),
    monthly_page_quota INTEGER NOT NULL DEFAULT 500,
    pages_used_current_period INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Remote Print Agents (Layer 3)
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'ONLINE', 'OFFLINE', 'REVOKED')),
    last_heartbeat_at TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Registered Printers (Local & Remote)
CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    system_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    adapter_type TEXT NOT NULL CHECK (adapter_type IN ('LOCAL_CUPS', 'REMOTE_AGENT')),
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    capabilities_json TEXT NOT NULL,
    operational_state TEXT NOT NULL DEFAULT 'IDLE',
    is_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(adapter_type, agent_id, system_name)
);

-- 4. Document Folders (Layer 2 Managed Library)
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 5. Managed Documents (Opaque Storage)
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    original_filename TEXT NOT NULL,
    storage_key TEXT UNIQUE NOT NULL,
    mime_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    page_count INTEGER NOT NULL,
    sha256_checksum TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    revision_number INTEGER NOT NULL DEFAULT 1,
    revision_note TEXT,
    is_ephemeral_kiosk INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Persistent Print Job Queue & State Machine
CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    printer_id TEXT NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('UPLOADED', 'VALIDATED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN')),
    options_json TEXT NOT NULL,
    resolved_pages_json TEXT NOT NULL,
    logical_page_count INTEGER NOT NULL,
    physical_sheets INTEGER NOT NULL,
    quota_deducted INTEGER NOT NULL DEFAULT 0,
    temp_slice_key TEXT,
    cups_job_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

-- 7. Personal Walk-Up QR Kiosk Sessions (Layer 3)
CREATE TABLE IF NOT EXISTS kiosk_sessions (
    id TEXT PRIMARY KEY,
    session_token TEXT UNIQUE NOT NULL,
    guest_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    print_job_id TEXT REFERENCES print_jobs(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'UPLOADED', 'PRINTING', 'COMPLETED', 'PURGED', 'EXPIRED')),
    max_sheets_allowed INTEGER NOT NULL DEFAULT 50,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. Immutable Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export const SQLITE_IMMUTABILITY_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS prevent_audit_logs_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_LOGS_IMMUTABLE: UPDATE not permitted');
END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_logs_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'AUDIT_LOGS_IMMUTABLE: DELETE not permitted');
END;
`;
