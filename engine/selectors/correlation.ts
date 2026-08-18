import {
  isCorrelated,
  type AttributionTuple,
  type BureauDispatchRow,
  type BureauJournalRow,
  type BureauObservationRow,
  type DbConnection
} from '../contract/index.ts';
import { journal } from '../journal/writer.ts';

export interface RecordCorrelatedObservationInput {
  dispatchId: string;
  selectorKey: string;
  action: string;
  nonceEcho: string;
  observed: Record<string, unknown>;
  attribution: AttributionTuple;
  taskId?: string | null;
  jobId?: string | null;
}

export function recordCorrelatedObservation(
  db: DbConnection,
  input: RecordCorrelatedObservationInput
): BureauObservationRow {
  const { dispatchId, selectorKey, action, nonceEcho, observed, attribution, taskId, jobId } = input;
  const now = new Date().toISOString();
  const obsId = crypto.randomUUID();

  return db.execTransaction(() => {
    // 1. Journal dispatch span carrying nonceEcho
    journal(db, {
      kind: 'dispatch',
      attribution,
      taskId: taskId ?? null,
      jobId: jobId ?? null,
      detail: {
        nonce: nonceEcho,
        dispatchId,
        selectorKey,
        action,
        observed
      }
    });

    // 2. Write bureau_observations row carrying exact same nonceEcho
    db.run(
      `INSERT INTO bureau_observations (id, dispatch_id, nonce, selector_key, observed, actor_role, provider, model, account, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      obsId,
      dispatchId,
      nonceEcho,
      selectorKey,
      JSON.stringify(observed),
      attribution.actor_role,
      attribution.provider,
      attribution.model,
      attribution.account ?? null,
      now
    );

    const obsRow = db.get<BureauObservationRow>('SELECT * FROM bureau_observations WHERE id = ?', obsId);
    if (!obsRow) {
      throw new Error(`Failed to insert observation row ${obsId}`);
    }
    return obsRow;
  });
}

export interface CorrelatedPair {
  nonce: string;
  selectorKey: string;
  span: BureauJournalRow;
  observation: BureauObservationRow;
}

export interface CorrelatedChainResult {
  dispatch: BureauDispatchRow | null;
  pairs: CorrelatedPair[];
}

export function queryCorrelatedChain(db: DbConnection, dispatchId: string): CorrelatedChainResult {
  const dispatch = db.get<BureauDispatchRow>('SELECT * FROM bureau_dispatches WHERE id = ?', dispatchId) ?? null;

  const observations = db.all<BureauObservationRow>(
    'SELECT * FROM bureau_observations WHERE dispatch_id = ? ORDER BY created_at ASC',
    dispatchId
  );

  const spans = db.all<BureauJournalRow>(
    "SELECT * FROM bureau_journal WHERE kind = 'dispatch' ORDER BY id ASC"
  );

  const pairs: CorrelatedPair[] = [];

  for (const obs of observations) {
    const matchingSpan = spans.find((s) => isCorrelated(s, obs));
    if (matchingSpan) {
      pairs.push({
        nonce: obs.nonce,
        selectorKey: obs.selector_key,
        span: matchingSpan,
        observation: obs
      });
    }
  }

  return {
    dispatch,
    pairs
  };
}
