import crypto from 'node:crypto';
import { IDatabase } from '../db/database';

export interface AuditEventInput {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, any>;
  ipAddress?: string | null;
}

export class AuditService {
  constructor(private readonly db: IDatabase) {}

  log(event: AuditEventInput): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, details_json, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        event.actorUserId ?? null,
        event.action,
        event.targetType,
        event.targetId ?? null,
        JSON.stringify(event.details ?? {}),
        event.ipAddress ?? null
      );
    return id;
  }

  listRecent(limit = 100): any[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, u.username as actor_username
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.created_at DESC, a.rowid DESC
         LIMIT ?`
      )
      .all(limit);

    return rows.map((r: any) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorUsername: r.actor_username || 'system',
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      details: JSON.parse(r.details_json || '{}'),
      ipAddress: r.ip_address,
      createdAt: r.created_at,
    }));
  }
}
