import crypto from 'node:crypto';
import { DEFAULT_LEASE_MS, HARNESS_META_KEYS } from '../contract/constants.ts';
import { leaseIsExpired } from '../contract/harness-pure.ts';
import type {
  AttributionTuple,
  BureauWindowLeaseRow,
  DbConnection
} from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { LeaseError } from './errors.ts';

function getLeaseMs(db: DbConnection, overrideMs?: number): number {
  if (overrideMs && overrideMs > 0) {
    return overrideMs;
  }
  const row = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', HARNESS_META_KEYS.LEASE_MS);
  if (row?.value) {
    const val = Number.parseInt(row.value, 10);
    if (!Number.isNaN(val) && val > 0) {
      return val;
    }
  }
  return DEFAULT_LEASE_MS;
}

function getHeartbeatCeiling(db: DbConnection): number | null {
  const row = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', HARNESS_META_KEYS.LEASE_HEARTBEATS_CEILING);
  if (row?.value) {
    const val = Number.parseInt(row.value, 10);
    if (!Number.isNaN(val) && val >= 0) {
      return val;
    }
  }
  return null;
}

export function acquireLease(
  db: DbConnection,
  windowTarget: string,
  dispatchId: string,
  attribution: AttributionTuple,
  leaseMs?: number
): BureauWindowLeaseRow {
  const durationMs = getLeaseMs(db, leaseMs);
  const id = crypto.randomUUID();
  const now = new Date();
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + durationMs).toISOString();

  try {
    db.run(
      `INSERT INTO bureau_window_leases (
        id, window_target, dispatch_id, status, acquired_at, expires_at,
        heartbeats, actor_role, provider, model, account, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      id,
      windowTarget,
      dispatchId,
      acquiredAt,
      expiresAt,
      attribution.actor_role,
      attribution.provider,
      attribution.model,
      attribution.account ?? null,
      acquiredAt,
      acquiredAt
    );
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed') || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      journal(db, {
        kind: 'guardrail',
        attribution,
        detail: {
          reason: 'window_lease_conflict',
          windowTarget,
          dispatchId,
          error: err.message
        }
      });
      throw new LeaseError(`Window target '${windowTarget}' is already leased by an active dispatch.`, windowTarget, dispatchId);
    }
    throw err;
  }

  return {
    id,
    window_target: windowTarget,
    dispatch_id: dispatchId,
    status: 'active',
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    heartbeats: 0,
    actor_role: attribution.actor_role,
    provider: attribution.provider,
    model: attribution.model,
    account: attribution.account ?? null,
    created_at: acquiredAt,
    updated_at: acquiredAt
  };
}

export function heartbeatLease(
  db: DbConnection,
  leaseId: string,
  nowMs?: number | string | Date
): BureauWindowLeaseRow {
  const currentMs = typeof nowMs === 'number' ? nowMs : (typeof nowMs === 'string' ? Date.parse(nowMs) : (nowMs?.getTime() ?? Date.now()));
  const lease = db.get<BureauWindowLeaseRow>('SELECT * FROM bureau_window_leases WHERE id = ?', leaseId);

  if (!lease) {
    throw new LeaseError(`Lease '${leaseId}' not found.`, 'unknown');
  }

  if (lease.status !== 'active' || leaseIsExpired(lease, currentMs)) {
    throw new LeaseError(`Cannot heartbeat lease '${leaseId}' with status '${lease.status}' or expired lease.`, lease.window_target, lease.dispatch_id);
  }

  const ceiling = getHeartbeatCeiling(db);
  if (ceiling !== null && lease.heartbeats >= ceiling) {
    throw new LeaseError(`Heartbeat ceiling reached (${ceiling}) for lease '${leaseId}'.`, lease.window_target, lease.dispatch_id);
  }

  const durationMs = getLeaseMs(db);
  const nowIso = new Date(currentMs).toISOString();
  const newExpiresAt = new Date(currentMs + durationMs).toISOString();

  db.run(
    `UPDATE bureau_window_leases
     SET expires_at = ?, heartbeats = heartbeats + 1, updated_at = ?
     WHERE id = ? AND status = 'active'`,
    newExpiresAt,
    nowIso,
    leaseId
  );

  return {
    ...lease,
    expires_at: newExpiresAt,
    heartbeats: lease.heartbeats + 1,
    updated_at: nowIso
  };
}

export function releaseLease(db: DbConnection, leaseId: string): void {
  const nowIso = new Date().toISOString();
  db.run(
    `UPDATE bureau_window_leases
     SET status = 'released', updated_at = ?
     WHERE id = ? AND status = 'active'`,
    nowIso,
    leaseId
  );
}

export function reapExpiredWindowLeases(db: DbConnection, nowMs?: number | string | Date): number {
  const currentMs = typeof nowMs === 'number' ? nowMs : (typeof nowMs === 'string' ? Date.parse(nowMs) : (nowMs?.getTime() ?? Date.now()));
  const nowIso = new Date(currentMs).toISOString();

  return db.execTransaction(() => {
    const expiredLeases = db.all<BureauWindowLeaseRow>(
      `SELECT * FROM bureau_window_leases WHERE status = 'active' AND expires_at <= ?`,
      nowIso
    );

    for (const lease of expiredLeases) {
      db.run(
        `UPDATE bureau_window_leases SET status = 'reaped', updated_at = ? WHERE id = ?`,
        nowIso,
        lease.id
      );

      journal(db, {
        kind: 'guardrail',
        attribution: {
          actor_role: (lease.actor_role as any) || 'system',
          provider: lease.provider || 'deterministic',
          model: lease.model || 'core',
          account: lease.account ?? null
        },
        detail: {
          reason: 'lease_expired_reaped',
          leaseId: lease.id,
          windowTarget: lease.window_target,
          dispatchId: lease.dispatch_id
        }
      });
    }

    return expiredLeases.length;
  });
}
