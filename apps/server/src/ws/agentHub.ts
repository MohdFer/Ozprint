import crypto from 'node:crypto';
import { IncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { IDatabase, hashToken } from '../db/database';
import { IAgentBridge } from '../adapters/RemoteAgentAdapter';
import {
  CupsJobStatusResult,
  DiscoveredPrinter,
  PrintSubmissionRequest,
} from '../adapters/IPrintAdapter';
import { validateSafePrinterName } from '../security/sandbox';
import { AuditService } from '../services/auditService';

interface ConnectedAgentSession {
  agentId: string;
  ws: WebSocket;
  lastHeartbeat: number;
  jobStatuses: Map<string, CupsJobStatusResult>;
  pendingAssignResolvers: Map<
    string,
    {
      resolve: (res: { cupsJobId: string }) => void;
      reject: (err: Error) => void;
    }
  >;
}

export class AgentHub implements IAgentBridge {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, ConnectedAgentSession>();

  constructor(
    private readonly db: IDatabase,
    private readonly audit: AuditService
  ) {}

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const urlObj = new URL(request.url || '/', 'http://localhost');
      if (urlObj.pathname !== '/ws/agent') {
        socket.destroy();
        return;
      }

      const authHeader = request.headers.authorization || '';
      let rawToken = '';
      if (authHeader.startsWith('Bearer ')) {
        rawToken = authHeader.slice(7).trim();
      } else if (urlObj.searchParams.get('token')) {
        rawToken = urlObj.searchParams.get('token')!.trim();
      }

      if (!rawToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const tokenHash = hashToken(rawToken);
      const agentRow = this.db
        .prepare<any>(
          "SELECT * FROM agents WHERE token_hash = ? AND status != 'REVOKED'"
        )
        .get(tokenHash);

      if (!agentRow) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.handleConnection(agentRow.id, request.socket.remoteAddress || null, ws);
      });
    });
  }

  private handleConnection(
    agentId: string,
    ipAddress: string | null,
    ws: WebSocket
  ): void {
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.ws.close();
    }

    const session: ConnectedAgentSession = {
      agentId,
      ws,
      lastHeartbeat: Date.now(),
      jobStatuses: new Map(),
      pendingAssignResolvers: new Map(),
    };
    this.sessions.set(agentId, session);

    this.db
      .prepare(
        `UPDATE agents
         SET status = 'ONLINE', last_heartbeat_at = CURRENT_TIMESTAMP, ip_address = ?
         WHERE id = ?`
      )
      .run(ipAddress, agentId);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleAgentMessage(session, msg);
      } catch {
        // Ignore malformed JSON frames
      }
    });

    ws.on('close', () => {
      if (this.sessions.get(agentId) === session) {
        this.sessions.delete(agentId);
        this.db
          .prepare("UPDATE agents SET status = 'OFFLINE' WHERE id = ?")
          .run(agentId);
      }
    });
  }

  public handleAgentMessage(session: ConnectedAgentSession, msg: any): void {
    const { agentId } = session;

    if (msg.type === 'AGENT_HELLO') {
      session.lastHeartbeat = Date.now();
      const printers: DiscoveredPrinter[] = Array.isArray(msg.printers)
        ? msg.printers
        : [];

      for (const p of printers) {
        const safeName = validateSafePrinterName(p.systemName);
        const existing = this.db
          .prepare<any>(
            `SELECT id FROM printers
             WHERE adapter_type = 'REMOTE_AGENT' AND agent_id = ? AND system_name = ?`
          )
          .get(agentId, safeName);

        const capabilities = p.capabilities || {
          color: false,
          duplex: true,
          media: ['A4', 'Letter'],
        };

        if (existing) {
          this.db
            .prepare(
              `UPDATE printers
               SET display_name = ?, capabilities_json = ?, operational_state = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`
            )
            .run(
              p.displayName || safeName,
              JSON.stringify(capabilities),
              p.operationalState || 'IDLE',
              existing.id
            );
        } else {
          this.db
            .prepare(
              `INSERT INTO printers (
                id, system_name, display_name, adapter_type, agent_id,
                capabilities_json, operational_state, is_enabled
              ) VALUES (?, ?, ?, 'REMOTE_AGENT', ?, ?, ?, 1)`
            )
            .run(
              crypto.randomUUID(),
              safeName,
              p.displayName || safeName,
              agentId,
              JSON.stringify(capabilities),
              p.operationalState || 'IDLE'
            );
        }
      }
    } else if (msg.type === 'HEARTBEAT') {
      session.lastHeartbeat = Date.now();
      this.db
        .prepare(
          `UPDATE agents
           SET status = 'ONLINE', last_heartbeat_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .run(agentId);
    } else if (msg.type === 'JOB_PROGRESS') {
      const { jobId, cupsJobId, state, reason } = msg;
      if (cupsJobId) {
        session.jobStatuses.set(cupsJobId, {
          state: state || 'PROCESSING',
          reason,
        });
      }
      const pending = session.pendingAssignResolvers.get(jobId);
      if (pending) {
        session.pendingAssignResolvers.delete(jobId);
        if (state === 'FAILED') {
          pending.reject(new Error(reason || 'REMOTE_AGENT_LP_FAILED'));
        } else {
          pending.resolve({ cupsJobId: cupsJobId || `remote-${jobId}` });
        }
      }
    }
  }

  isAgentOnline(agentId: string): boolean {
    const sess = this.sessions.get(agentId);
    return Boolean(sess && sess.ws.readyState === WebSocket.OPEN);
  }

  sendJobToAgent(
    agentId: string,
    payload: {
      jobId: string;
      printerSystemName: string;
      sliceDownloadUrl: string;
      options: PrintSubmissionRequest['options'];
    }
  ): Promise<{ cupsJobId: string }> {
    const session = this.sessions.get(agentId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`REMOTE_AGENT_OFFLINE:${agentId}`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingAssignResolvers.delete(payload.jobId);
        reject(new Error('REMOTE_AGENT_ASSIGN_TIMEOUT'));
      }, 15000);

      session.pendingAssignResolvers.set(payload.jobId, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      session.ws.send(
        JSON.stringify({
          type: 'JOB_ASSIGN',
          ...payload,
        })
      );
    });
  }

  getAgentJobStatus(agentId: string, cupsJobId: string): CupsJobStatusResult {
    const session = this.sessions.get(agentId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      return {
        state: 'UNKNOWN',
        reason: 'Remote agent connection dropped',
      };
    }
    return (
      session.jobStatuses.get(cupsJobId) || {
        state: 'PROCESSING',
      }
    );
  }

  async cancelAgentJob(agentId: string, cupsJobId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(
        JSON.stringify({
          type: 'JOB_CANCEL',
          cupsJobId,
        })
      );
    }
  }

  // Enrollment & Management API
  enrollAgent(
    name: string,
    actorUserId: string
  ): { id: string; name: string; enrollmentToken: string; status: string } {
    const id = crypto.randomUUID();
    const enrollmentToken = `ozagent_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(enrollmentToken);
    const cleanName = name.trim().slice(0, 120) || 'Branch Print Agent';

    this.db
      .prepare(
        `INSERT INTO agents (id, name, token_hash, status)
         VALUES (?, ?, ?, 'PENDING')`
      )
      .run(id, cleanName, tokenHash);

    this.audit.log({
      actorUserId,
      action: 'AGENT_ENROLLED',
      targetType: 'AGENT',
      targetId: id,
      details: { name: cleanName },
    });

    return {
      id,
      name: cleanName,
      enrollmentToken,
      status: 'PENDING',
    };
  }

  listAgents(): any[] {
    const rows = this.db
      .prepare<any>('SELECT * FROM agents ORDER BY created_at DESC')
      .all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: this.isAgentOnline(r.id) ? 'ONLINE' : r.status,
      lastHeartbeatAt: r.last_heartbeat_at,
      ipAddress: r.ip_address,
      createdAt: r.created_at,
    }));
  }

  revokeAgent(agentId: string, actorUserId: string): void {
    this.db
      .prepare("UPDATE agents SET status = 'REVOKED' WHERE id = ?")
      .run(agentId);
    this.db
      .prepare('UPDATE printers SET is_enabled = 0 WHERE agent_id = ?')
      .run(agentId);
    const session = this.sessions.get(agentId);
    if (session) {
      session.ws.close();
      this.sessions.delete(agentId);
    }
    this.audit.log({
      actorUserId,
      action: 'AGENT_REVOKED',
      targetType: 'AGENT',
      targetId: agentId,
    });
  }
}
