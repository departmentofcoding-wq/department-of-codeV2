import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeDb } from '../fixtures/db_factory.ts';
import type { DbConnection, BureauTaskRow, BureauIntakeSessionRow, BureauJournalRow, BureauJobRow } from '../../engine/contract/types.ts';
import {
  fileAgentTask,
  AgentFileError,
  AGENT_IDENTITIES,
  isAgentAutofileEnabled,
  setAgentAutofile
} from '../../engine/filing/index.ts';
import { createSession, confirmVerify } from '../../engine/intake/index.ts';
import { planCycleJobId } from '../../engine/jobs/ids.ts';

describe('Agent Task-Filing Door (fileAgentTask)', () => {
  let db: DbConnection & { close: () => void };

  const claudeAttr = { ...AGENT_IDENTITIES.claude };
  const glmAttr = { ...AGENT_IDENTITIES.glm };
  const juniorAttr = {
    actor_role: 'junior-engineer' as const,
    provider: 'antigravity',
    model: 'gemini-3.7-flash',
    account: null
  };
  const humanAttr = {
    actor_role: 'human-operator' as const,
    provider: 'deterministic',
    model: 'core',
    account: 'operator'
  };

  const baseInput = {
    title: 'Add usage metrics endpoint',
    intent: 'Expose per-model usage metrics so agents can check quota headroom.',
    verifyCmd: 'npm test -- metrics'
  };

  function tasks(): BureauTaskRow[] {
    return db.all<BureauTaskRow>('SELECT * FROM bureau_tasks');
  }

  function guardrails(): BureauJournalRow[] {
    return db.all<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'guardrail'");
  }

  beforeEach(() => {
    db = createFakeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('T-AGENTFILE-1: Happy path (flag ON) files a queued task, kicks off plan.cycle, and attributes honestly', () => {
    expect(isAgentAutofileEnabled(db)).toBe(false); // fail-closed default
    setAgentAutofile(db, true);
    expect(isAgentAutofileEnabled(db)).toBe(true);

    const task = fileAgentTask(db, { ...baseInput, attribution: claudeAttr });

    expect(task.state).toBe('queued');
    expect(task.title).toBe(baseInput.title);
    expect(task.intake_session_id).toBeTruthy();

    // The plan-cycle kickoff job exists (pending — drained by a runner, not here).
    const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', planCycleJobId(task.id));
    expect(job).toBeDefined();
    expect(job?.kind).toBe('plan.cycle');
    expect(job?.state).toBe('pending');

    // task-filed span carries the agent's identity, not a forged human.
    const filedSpan = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'task-filed' AND task_id = ?",
      task.id
    );
    expect(filedSpan).toBeDefined();
    expect(filedSpan?.actor_role).toBe('senior-engineer');
    expect(filedSpan?.provider).toBe('anthropic');
    expect(filedSpan?.model).toBe('claude-opus-4-8');

    // The verify-confirm span is the AGENT under the autofile flag — never a human.
    const confirmSpan = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'system' AND detail LIKE '%agent-auto-confirm-verify%'"
    );
    expect(confirmSpan).toBeDefined();
    expect(confirmSpan?.actor_role).toBe('senior-engineer');
    expect(confirmSpan?.provider).toBe('anthropic');
    const detail = JSON.parse(confirmSpan!.detail);
    expect(detail.autofile).toBe(true);
    expect(detail.sessionId).toBe(task.intake_session_id);

    // Session: filed, verify confirmed by the agent role (distinct from human-operator).
    const session = db.get<BureauIntakeSessionRow>(
      'SELECT * FROM bureau_intake_sessions WHERE id = ?',
      task.intake_session_id
    );
    expect(session?.state).toBe('filed');
    expect(session?.verify_confirmed_at).toBeTruthy();
    expect(session?.verify_confirmed_by).toBe('senior-engineer');
  });

  it('T-AGENTFILE-2: Flag OFF (default) refuses with zero task rows and a guardrail span (M-AGENTFILE-1)', () => {
    let err: unknown;
    try {
      fileAgentTask(db, { ...baseInput, attribution: claudeAttr });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentFileError);
    expect((err as AgentFileError).code).toBe('autofile_disabled');

    expect(tasks()).toHaveLength(0);
    expect(
      db.all<BureauIntakeSessionRow>('SELECT * FROM bureau_intake_sessions')
    ).toHaveLength(0); // nothing created on refusal
    const spans = guardrails();
    expect(spans).toHaveLength(1);
    const detail = JSON.parse(spans[0].detail);
    expect(detail.code).toBe('autofile_disabled');
    expect(detail.metaKey).toBe('intake:agent_autofile');
  });

  it('T-AGENTFILE-3: Disallowed actor role (junior-engineer) is refused + journaled (M-AGENTFILE-2)', () => {
    setAgentAutofile(db, true);

    let err: unknown;
    try {
      fileAgentTask(db, { ...baseInput, attribution: juniorAttr });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentFileError);
    expect((err as AgentFileError).code).toBe('actor_not_allowed');

    expect(tasks()).toHaveLength(0);
    const spans = guardrails();
    expect(spans).toHaveLength(1);
    const detail = JSON.parse(spans[0].detail);
    expect(detail.code).toBe('actor_not_allowed');
    expect(detail.actor_role).toBe('junior-engineer');
  });

  it('T-AGENTFILE-4: Vacuous verify command is refused + journaled', () => {
    setAgentAutofile(db, true);

    for (const vacuous of ['exit 0', 'true', '   ', '']) {
      let err: unknown;
      try {
        fileAgentTask(db, { ...baseInput, verifyCmd: vacuous, attribution: claudeAttr });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AgentFileError);
      expect((err as AgentFileError).code).toBe('vacuous_verify');
    }

    expect(tasks()).toHaveLength(0);
    expect(guardrails().length).toBeGreaterThanOrEqual(1);
    expect(
      guardrails().some((s) => JSON.parse(s.detail).code === 'vacuous_verify')
    ).toBe(true);
  });

  it('T-AGENTFILE-5: Missing title or intent is refused + journaled', () => {
    setAgentAutofile(db, true);

    const cases = [
      { title: '', intent: 'present' },
      { title: '   ', intent: 'present' },
      { title: 'present', intent: '' }
    ];
    for (const c of cases) {
      let err: unknown;
      try {
        fileAgentTask(db, {
          ...baseInput,
          title: c.title,
          intent: c.intent,
          attribution: claudeAttr
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AgentFileError);
      expect((err as AgentFileError).code).toBe('missing_fields');
    }

    expect(tasks()).toHaveLength(0);
    expect(
      guardrails().some((s) => JSON.parse(s.detail).code === 'missing_fields')
    ).toBe(true);
  });

  it('T-AGENTFILE-6: Same idempotencyKey twice files exactly one task', () => {
    setAgentAutofile(db, true);
    const key = 'agent-file-once-1';

    const first = fileAgentTask(db, {
      ...baseInput,
      idempotencyKey: key,
      attribution: glmAttr
    });
    const second = fileAgentTask(db, {
      ...baseInput,
      title: 'Retry with a different title — the first session must win',
      idempotencyKey: key,
      attribution: glmAttr
    });

    expect(second.id).toBe(first.id);
    expect(tasks()).toHaveLength(1);
    expect(
      db.all<BureauIntakeSessionRow>('SELECT * FROM bureau_intake_sessions')
    ).toHaveLength(1);

    // Exactly one task-filed span for the whole exchange.
    const filedSpans = db.all<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'task-filed'");
    expect(filedSpans).toHaveLength(1);
    expect(filedSpans[0].provider).toBe('zai');
  });

  it('T-AGENTFILE-7: confirmVerify stays human-only — the agent role is refused, the human still works', () => {
    setAgentAutofile(db, true);

    const session = createSession(db, {
      title: baseInput.title,
      intent: baseInput.intent,
      verifyCmd: baseInput.verifyCmd,
      attribution: claudeAttr
    });

    // The agent CANNOT walk the human confirm-verify door.
    expect(() => confirmVerify(db, session.id, claudeAttr)).toThrow(/Only human-operator can confirm/i);
    expect(() => confirmVerify(db, session.id, glmAttr)).toThrow(/Only human-operator can confirm/i);

    // The human still can — the original door keeps its exact guarantee.
    const confirmed = confirmVerify(db, session.id, humanAttr);
    expect(confirmed.verify_confirmed_by).toBe('human-operator:operator');
  });

  it('T-AGENTFILE-8: Key hygiene — whole-DB secret scan proves no key material is journaled', () => {
    setAgentAutofile(db, true);
    fileAgentTask(db, { ...baseInput, attribution: claudeAttr });

    const secretPatterns = [
      /ghp_[A-Za-z0-9_]{30,}/,
      /github_pat_[A-Za-z0-9_]{22,}/,
      /AIzaSy[A-Za-z0-9_-]{33}/,
      /sk-[A-Za-z0-9]{32,}/
    ];

    const tables = [
      'bureau_tasks',
      'bureau_intake_sessions',
      'bureau_intake_messages',
      'bureau_journal',
      'bureau_meta',
      'bureau_jobs'
    ];
    for (const table of tables) {
      const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const text = JSON.stringify(row);
        for (const pat of secretPatterns) {
          expect(pat.test(text), `${table} must not contain key material`).toBe(false);
        }
      }
    }
  });
});
