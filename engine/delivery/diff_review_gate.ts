import type { DbConnection, BureauWorkReviewRow } from '../contract/types.ts';
import { WORK_REVIEW_DIFF_PHASE } from '../contract/constants.ts';

/**
 * N2 — the delivery-gating review lookup.
 *
 * The delivery decision (pr.create, pr.merge, and the A1 out-of-band merge
 * guard) must key on the latest APPROVED code-diff review (`phase = 'phase4'`)
 * — NOT on the latest review row of any phase. Before N2 the gate read
 * `ORDER BY created_at DESC LIMIT 1` regardless of phase, so a `walkthrough`
 * (or plan-phase) approval satisfied delivery and the final diff was never
 * senior-reviewed before merge (the b55e2fda / N1a incidents).
 *
 * The caller still enforces `reviewed_commit === tip`; this helper only
 * narrows WHICH review row is the gate.
 */
export function getDeliveryGatingReview(
  db: DbConnection,
  taskId: string
): BureauWorkReviewRow | undefined {
  return db.get<BureauWorkReviewRow>(
    `SELECT * FROM bureau_work_reviews
      WHERE task_id = ? AND verdict = 'approved' AND phase = ?
      ORDER BY created_at DESC LIMIT 1`,
    taskId,
    WORK_REVIEW_DIFF_PHASE
  );
}
