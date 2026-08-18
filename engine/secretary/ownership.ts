import {
  type BureauOwnershipRow,
  type DbConnection,
  type JobContext,
  DETERMINISTIC_ATTRIBUTION
} from '../contract/index.ts';
import { journal } from '../journal/writer.ts';

export const SECRETARY_ATTRIBUTION = {
  actor_role: 'secretary',
  ...DETERMINISTIC_ATTRIBUTION
} as const;

export interface SecretaryClaimInput {
  key: string;
  holderId: string;
  holderRole: string;
  leaseMs?: number;
  notes?: string;
}

/**
 * Claims ownership on a key in bureau_ownership.
 * Fail-Closed: Refuses claim if key is currently held and unexpired (expires_at > now).
 * Allows reclamation if existing lease is expired (expires_at <= now).
 */
export function claimOwnership(
  db: DbConnection,
  input: SecretaryClaimInput,
  jobId?: string | null
): BureauOwnershipRow {
  const now = new Date().toISOString();
  const leaseMs = input.leaseMs ?? 120000;
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();

  return db.execTransaction(() => {
    const existing = db.get<BureauOwnershipRow>(
      `SELECT * FROM bureau_ownership WHERE key = ?`,
      input.key
    );

    if (existing) {
      if (existing.expires_at > now) {
        // Held and unexpired — fail-closed refusal
        journal(db, {
          kind: 'guardrail',
          attribution: SECRETARY_ATTRIBUTION,
          jobId: jobId ?? null,
          detail: {
            action: 'secretary_claim_refused',
            key: input.key,
            attempted_holder: input.holderId,
            current_holder: existing.holder_id,
            expires_at: existing.expires_at,
            reason: 'key_currently_held'
          }
        });
        throw new Error(
          `Ownership claim on key '${input.key}' refused: currently held by '${existing.holder_id}' until ${existing.expires_at}`
        );
      } else {
        // Expired lease — reclaimable
        db.run(
          `UPDATE bureau_ownership
           SET holder_id = ?,
               holder_role = ?,
               leased_at = ?,
               expires_at = ?,
               notes = ?,
               updated_at = ?
           WHERE key = ?`,
          input.holderId,
          input.holderRole,
          now,
          expiresAt,
          input.notes ?? null,
          now,
          input.key
        );

        journal(db, {
          kind: 'system',
          attribution: SECRETARY_ATTRIBUTION,
          jobId: jobId ?? null,
          detail: {
            action: 'secretary_claim_reclaimed_expired',
            key: input.key,
            previous_holder: existing.holder_id,
            new_holder: input.holderId,
            expires_at: expiresAt,
            notes: input.notes ?? null
          }
        });
      }
    } else {
      // New claim
      db.run(
        `INSERT INTO bureau_ownership
         (key, holder_id, holder_role, leased_at, expires_at, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.key,
        input.holderId,
        input.holderRole,
        now,
        expiresAt,
        input.notes ?? null,
        now,
        now
      );

      journal(db, {
        kind: 'system',
        attribution: SECRETARY_ATTRIBUTION,
        jobId: jobId ?? null,
        detail: {
          action: 'secretary_claim_acquired',
          key: input.key,
          holder_id: input.holderId,
          expires_at: expiresAt,
          notes: input.notes ?? null
        }
      });
    }

    return db.get<BureauOwnershipRow>(
      `SELECT * FROM bureau_ownership WHERE key = ?`,
      input.key
    )!;
  });
}

export interface SecretaryReleaseInput {
  key: string;
  holderId: string;
}

/**
 * Releases ownership on a key in bureau_ownership.
 * Refuses release if attempted by anyone other than the active holder_id.
 */
export function releaseOwnership(
  db: DbConnection,
  input: SecretaryReleaseInput,
  jobId?: string | null
): boolean {
  return db.execTransaction(() => {
    const existing = db.get<BureauOwnershipRow>(
      `SELECT * FROM bureau_ownership WHERE key = ?`,
      input.key
    );

    if (!existing) {
      return false;
    }

    if (existing.holder_id !== input.holderId) {
      // Release by non-holder refused
      journal(db, {
        kind: 'guardrail',
        attribution: SECRETARY_ATTRIBUTION,
        jobId: jobId ?? null,
        detail: {
          action: 'secretary_release_refused',
          key: input.key,
          attempted_releaser: input.holderId,
          actual_holder: existing.holder_id,
          reason: 'holder_mismatch'
        }
      });
      throw new Error(
        `Ownership release on key '${input.key}' refused: attempted by '${input.holderId}' but held by '${existing.holder_id}'`
      );
    }

    db.run(`DELETE FROM bureau_ownership WHERE key = ?`, input.key);

    journal(db, {
      kind: 'system',
      attribution: SECRETARY_ATTRIBUTION,
      jobId: jobId ?? null,
      detail: {
        action: 'secretary_release_completed',
        key: input.key,
        holder_id: input.holderId
      }
    });

    return true;
  });
}

export async function handleSecretaryClaim(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as SecretaryClaimInput;
  if (!payload || !payload.key || !payload.holderId || !payload.holderRole) {
    throw new Error(`secretary.claim job missing required payload fields (key, holderId, holderRole)`);
  }
  claimOwnership(ctx.db, payload, ctx.job.id);
}

export async function handleSecretaryRelease(ctx: JobContext): Promise<void> {
  const payload = ctx.payload as SecretaryReleaseInput;
  if (!payload || !payload.key || !payload.holderId) {
    throw new Error(`secretary.release job missing required payload fields (key, holderId)`);
  }
  releaseOwnership(ctx.db, payload, ctx.job.id);
}
