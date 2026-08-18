import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BureauJournalRow, DbConnection } from '../../engine/contract/index.ts';
import { openDbConnection } from '../../engine/db/index.ts';
import { enqueueJob } from '../../engine/jobs/jobs.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { registerSelector } from '../../engine/selectors/registry.ts';
import { queryCorrelatedChain } from '../../engine/selectors/correlation.ts';
import { UncalibratedSelectorError } from '../../engine/selectors/gate.ts';
import { getIdeDriver, setIdeDriverOverride, setMockClientOverride } from '../../engine/contract/index.ts';

describe('T36: End-to-End Integration Test (Milestone CX)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DbConnection & { close: () => void };
  let fixturePath: string;
  let fixtureUrl: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-t36-'));
    dbPath = path.join(tmpDir, 't36.db');
    fixturePath = path.join(tmpDir, 'fixture.html');

    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>T36 Fixture</title></head>
<body>
  <textarea id="task-input"></textarea>
  <button id="submit-btn" onclick="document.getElementById('status-output').textContent = 'Submitted: ' + document.getElementById('task-input').value">Submit</button>
  <button id="uncalibrated-btn" onclick="document.getElementById('status-output').textContent = 'Uncalibrated Clicked'">Uncalibrated</button>
  <div id="status-output">Initial</div>
</body>
</html>`;
    fs.writeFileSync(fixturePath, htmlContent);
    fixtureUrl = pathToFileURL(fixturePath).href;

    db = openDbConnection(dbPath);

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, verify_fixes, priority, work_uuid, created_at, updated_at)
      VALUES ('task-t36', 'T36 Task', 'E2E Test', 'Edit fixture', 'Clean completion', 'queued', 0, 1, 'uuid-t36', '${now}', '${now}');

      INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
      VALUES ('disp-t36', 'task-t36', 'uuid-t36', 'junior-engineer', 'ollama', 'qwen2.5-coder', 'pending', 0, '${now}');
    `);
  });

  afterEach(async () => {
    delete process.env.BUREAU_MOCK_LLM;
    setMockClientOverride(null);
    const driver = getIdeDriver();
    if (driver && typeof driver.close === 'function') {
      try {
        await driver.close();
      } catch {
        // Ignored
      }
    }
    setIdeDriverOverride(null);
    if (db) {
      try {
        db.close();
      } catch {
        // Ignored
      }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('runs dispatch under GatedIdeDriver with live gate beat, mock LLM loop, and exact nonce correlation', async () => {
    // 1. Register selectors
    registerSelector(db, { key: 'task.input', css: '#task-input' });
    registerSelector(db, { key: 'task.submit', css: '#submit-btn' });
    registerSelector(db, { key: 'task.uncalibrated', css: '#uncalibrated-btn' });

    // Driver wiring: Use runner default GatedIdeDriver(new CdpIdeDriver(...))
    const { Runner } = await import('../../runner/main.ts');
    const runner = new Runner(db); // Installs default GatedIdeDriver composite
    const driver = getIdeDriver();

    await driver.navigate(fixtureUrl);

    // 2. Live Gate Beat (CX-2): Attempt action on uncalibrated selector task.uncalibrated
    await expect(driver.act('task.uncalibrated', 'click')).rejects.toThrow(UncalibratedSelectorError);

    // Assert guardrail span recorded for gate refusal and DOM remains unaffected
    const guardrailSpan = db.get<BureauJournalRow>(
      "SELECT * FROM bureau_journal WHERE kind = 'guardrail' AND detail LIKE '%gate_refusal%'"
    );
    expect(guardrailSpan).toBeDefined();

    const snapshotBefore = await driver.snapshot();
    expect(snapshotBefore.outline).toContain('id="status-output">Initial</div>');

    // 3. Calibrate selectors task.input and task.submit via selector.calibrate job
    const cal1 = enqueueJob(db, { kind: 'selector.calibrate', task_id: 'task-t36', payload: { key: 'task.input' } });
    await drainSingleJob(db, cal1.id);

    const cal2 = enqueueJob(db, { kind: 'selector.calibrate', task_id: 'task-t36', payload: { key: 'task.submit' } });
    await drainSingleJob(db, cal2.id);

    const sel1 = db.get<{ status: string }>('SELECT status FROM bureau_selectors WHERE key = ?', 'task.input');
    const sel2 = db.get<{ status: string }>('SELECT status FROM bureau_selectors WHERE key = ?', 'task.submit');
    expect(sel1?.status).toBe('calibrated');
    expect(sel2?.status).toBe('calibrated');

    // 4. Script Mock LLM decision loop (CX-4) over Phase 1 callModel seam
    const { MockClient } = await import('../../engine/llm/mock_client.ts');
    const mockClient = new MockClient([
      {
        text: JSON.stringify({ action: 'type', selectorKey: 'task.input', value: 'Hello T36' }),
        tokensIn: 20,
        tokensOut: 15,
        latencyMs: 10,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      },
      {
        text: JSON.stringify({ action: 'click', selectorKey: 'task.submit' }),
        tokensIn: 20,
        tokensOut: 10,
        latencyMs: 10,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      },
      {
        text: JSON.stringify({ action: 'done' }),
        tokensIn: 10,
        tokensOut: 5,
        latencyMs: 5,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      }
    ]);
    setMockClientOverride(mockClient);
    process.env.BUREAU_MOCK_LLM = 'true';

    // 5. Enqueue & Drain junior.dispatch job
    const dispatchJob = enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: 'task-t36',
      payload: {
        dispatchId: 'disp-t36',
        windowTarget: 'window-t36'
      }
    });

    await drainSingleJob(db, dispatchJob.id);

    // 6. Assert dispatch completed status & window lease released status
    const dispRow = db.get<{ status: string }>('SELECT status FROM bureau_dispatches WHERE id = ?', 'disp-t36');
    expect(dispRow?.status).toBe('completed');

    const leaseRow = db.get<{ status: string }>('SELECT status FROM bureau_window_leases WHERE dispatch_id = ?', 'disp-t36');
    expect(leaseRow?.status).toBe('released');

    // 7. Nonce Correlation Assertion (CX-1): Query correlated chain and verify triple equality
    const chain = queryCorrelatedChain(db, 'disp-t36');
    expect(chain.pairs.length).toBeGreaterThan(0);

    for (const pair of chain.pairs) {
      const detail = typeof pair.span.detail === 'string' ? JSON.parse(pair.span.detail) : pair.span.detail;
      expect(detail.nonce).toBe(pair.observation.nonce);
      expect(pair.observation.nonce).toBe(pair.nonce);
    }
  });
});
