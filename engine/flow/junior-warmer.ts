import type { DbConnection } from '../contract/types.ts';
import {
  ensureJuniorRunning,
  resolveJunior,
  type EnsureResult,
  type JuniorConfig
} from '../harness/antigravity.ts';
import { probeJuniorHealth } from '../harness/antigravity-seam.ts';
import { clearJuniorUnhealthy, setJuniorUnhealthy } from './junior-health.ts';
import { DEFAULT_JUNIOR_COOLDOWN_MS } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';

/**
 * Junior auto-warmup (docs/plan-junior-auto-warmup.md) — the producer behind the
 * C3 admission gate. C3 made admission probe a junior's CDP health BEFORE the
 * dispatch step that used to launch it, so a merely COLD junior (not started
 * yet) failed the probe and nothing ever opened it — the department wedged with
 * tasks queued forever. The warmer opens cold juniors in the BACKGROUND:
 *
 *  - `request(j)` is fire-and-forget and never blocks a caller — the runner's
 *    100ms poll loop must not freeze for a 90s cold start (JUNIOR_PORT_WAIT_MS).
 *  - One attempt per junior at a time (dedupe) + a 60s failure backoff — the
 *    100ms sweep can call `request` every tick without spamming launches.
 *  - "Warm succeeded" means EXACTLY "the C3 admission probe passes" (senior R1):
 *    after `ensureJuniorRunning` brings the port up, a readiness loop polls the
 *    SAME probe the gate uses (`probeJuniorHealth`: page ws + Runtime.evaluate
 *    handshake). Waiting merely for the window ws is NOT enough — the page
 *    target can exist before the renderer answers Runtime.evaluate.
 *  - Success clears the admission cooldown once, at the end; `ensureJuniorRunning`
 *    is deliberately called WITHOUT `db` so its own port-time cooldown-clear
 *    cannot let the sweep re-probe mid-warm (plan §4.2).
 *  - The warmer must NOT gate on `isJuniorHealthy` (plan §4.1): the admission
 *    probe-fail path ITSELF marks the 60s cooldown, so a cooldown-gated warmer
 *    would be blocked by the very mark that triggered it — a permanent wedge
 *    (mutation M-AW2). Its gates are the in-flight map + failure backoff only.
 *  - The operator opt-out is the `bureau_meta` key `junior_warmup:disabled`
 *    (set/clear via `npm run junior:warmup -- off|on|status`), because a manual
 *    cooldown no longer pins a junior down while demand exists.
 */

/** bureau_meta key that disables all warming when set to a truthy value. */
export const JUNIOR_WARMUP_DISABLED_KEY = 'junior_warmup:disabled';
const JUNIOR_WARMUP_DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Pacing between failed warm attempts (aligns DEFAULT_JUNIOR_COOLDOWN_MS). */
export const WARM_RETRY_BACKOFF_MS = 60_000;
/**
 * Absolute cap on one warm attempt (90s port + 60s readiness + slack). Enforced
 * via Promise.race so a HUNG ensure/probe cannot pin the in-flight entry — the
 * map cleanup lives on the race chain, not the inner sequence (senior Rec4,
 * mutation M-AW6).
 */
export const WARM_ABSOLUTE_CAP_MS = 180_000;
/**
 * Readiness budget after the port answers: poll the admission probe until it
 * passes, mirroring MAIN_WINDOW_ATTACH_MS. Bounded primarily by poll count so
 * tests (and a stalled clock) stay deterministic; the wall-clock check is the
 * secondary bound.
 */
export const WARM_READY_MAX_POLLS = 30;
export const WARM_READY_WAIT_MS = 60_000;
export const WARM_READY_POLL_INTERVAL_MS = 2_000;

const WARMER_ATTRIBUTION = {
  actor_role: 'system',
  provider: 'deterministic',
  model: 'queue-policy',
  account: null
} as const;

export interface JuniorWarmerDeps {
  /** Default: the real `ensureJuniorRunning`, called WITHOUT `db` (plan §4.2). */
  ensure?: typeof ensureJuniorRunning;
  /** Default: the admission probe itself (`probeJuniorHealth`, the same seam
   *  the gate uses — senior R1: identical success criterion). */
  probe?: (cfg: JuniorConfig) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class JuniorWarmer {
  private readonly db: DbConnection;
  private readonly deps: Required<Pick<JuniorWarmerDeps, 'now'>> & JuniorWarmerDeps;
  private readonly capMs: number;
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly lastFailedAt = new Map<string, number>();

  constructor(db: DbConnection, deps: JuniorWarmerDeps = {}, opts: { capMs?: number } = {}) {
    this.db = db;
    this.deps = {
      ensure: deps.ensure ?? ensureJuniorRunning,
      probe: deps.probe ?? ((cfg: JuniorConfig) => probeJuniorHealth(cfg)),
      sleep: deps.sleep ?? (async (ms: number) => new Promise<void>(r => setTimeout(r, ms))),
      now: deps.now ?? (() => Date.now())
    };
    this.capMs = opts.capMs ?? WARM_ABSOLUTE_CAP_MS;
  }

  /**
   * Fire-and-forget warm request. Never throws, never blocks (the launch + wait
   * live in a detached promise). Returns true iff a warm for this junior is IN
   * FLIGHT after the call (newly started or already running); false when the
   * warmer is disabled, the junior is inside the failure backoff, or the id is
   * unknown. The boolean drives the reconcile quiet rule (senior R2).
   */
  request(juniorId: string, reason: 'boot' | 'probe_failed'): boolean {
    try {
      if (this.readDisabled()) return false;
      if (this.inFlight.has(juniorId)) return true;
      const lastFail = this.lastFailedAt.get(juniorId);
      if (lastFail !== undefined && this.deps.now() - lastFail < WARM_RETRY_BACKOFF_MS) {
        return false;
      }
      // Fail on an unknown junior id before any span is written.
      resolveJunior(juniorId);

      journal(this.db, {
        kind: 'system',
        attribution: WARMER_ATTRIBUTION,
        detail: { action: 'junior_warmup_requested', junior: juniorId, reason }
      });

      const attempt = this.runWarmSequence(juniorId); // never rejects
      let capTimer: NodeJS.Timeout | undefined;
      const cap = new Promise<boolean>(resolve => {
        capTimer = setTimeout(() => resolve(false), this.capMs);
      });
      const raced = Promise.race([attempt, cap]);
      this.inFlight.set(juniorId, raced);
      // Cleanup hangs off the RACE chain (Rec4): a hung inner ensure clears the
      // entry when the cap fires, so the next request can start a fresh warm.
      raced
        .finally(() => {
          if (capTimer) clearTimeout(capTimer);
          this.inFlight.delete(juniorId);
        })
        .catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** Whether a warm attempt is currently running for this junior. */
  isInFlight(juniorId: string): boolean {
    return this.inFlight.has(juniorId);
  }

  /**
   * The warm sequence: bring the port up, then poll the ADMISSION PROBE until it
   * passes (R1 — readiness, not window presence). Never rejects; failures are
   * journaled (guardrail), cooldown-marked, and recorded as backoff timestamps.
   */
  private async runWarmSequence(juniorId: string): Promise<boolean> {
    try {
      const cfg = resolveJunior(juniorId);
      // Deliberately WITHOUT db: ensureJuniorRunning would clear the admission
      // cooldown the moment the PORT answers, letting the sweep re-probe
      // mid-warm and re-fail. One explicit clear happens after readiness (§4.2).
      const ensured: EnsureResult = await this.deps.ensure!(cfg, {});
      const startedAt = this.deps.now();
      for (let i = 0; i < WARM_READY_MAX_POLLS; i++) {
        if (await this.deps.probe!(cfg)) {
          clearJuniorUnhealthy(this.db, juniorId);
          journal(this.db, {
            kind: 'system',
            attribution: WARMER_ATTRIBUTION,
            detail: {
              action: 'junior_warmup_succeeded',
              junior: juniorId,
              launched: ensured.launched
            }
          });
          return true;
        }
        if (this.deps.now() - startedAt > WARM_READY_WAIT_MS) break;
        await this.deps.sleep!(WARM_READY_POLL_INTERVAL_MS);
      }
      throw new Error(
        `${cfg.label} CDP endpoint up but admission probe not ready within ` +
          `${WARM_READY_WAIT_MS}ms (${WARM_READY_MAX_POLLS} polls)`
      );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastFailedAt.set(juniorId, this.deps.now());
      try {
        setJuniorUnhealthy(this.db, juniorId, DEFAULT_JUNIOR_COOLDOWN_MS, 'warmup_failed');
        journal(this.db, {
          kind: 'guardrail',
          attribution: WARMER_ATTRIBUTION,
          detail: { action: 'junior_warmup_failed', junior: juniorId, error: msg }
        });
      } catch {
        /* best-effort recording — the backoff timestamp above already holds */
      }
      return false;
    }
  }

  private readDisabled(): boolean {
    const row = this.db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      JUNIOR_WARMUP_DISABLED_KEY
    );
    if (!row || !row.value) return false;
    return JUNIOR_WARMUP_DISABLED_VALUES.has(row.value.trim().toLowerCase());
  }
}
