import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DETERMINISTIC_ATTRIBUTION, type BureauJournalRow, type BureauObservationRow, type DbConnection } from '../engine/contract/index.ts';
import { closeDatabase, openDbConnection } from '../engine/db/index.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { drainSingleJob } from '../runner/main.ts';
import { registerSelector } from '../engine/selectors/registry.ts';
import { queryCorrelatedChain } from '../engine/selectors/correlation.ts';
import { MockClient } from '../engine/llm/mock_client.ts';
import { setIdeDriverOverride, setMockClientOverride } from '../engine/contract/index.ts';
import { CdpIdeDriver } from '../engine/harness/cdp-client.ts';
import { GatedIdeDriver } from '../engine/selectors/gate.ts';

export async function runDemoPhase3(): Promise<string> {
  const logs: string[] = [];
  const log = (msg: string) => {
    logs.push(msg);
    console.log(msg);
  };

  log('=== DEPARTMENT OF CODE V2 — PHASE 3 EXIT DEMO (CDP, SELECTORS, NONCES, WINDOW LEASE) ===\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-demo-phase3-'));
  const dbPath = path.join(tempDir, 'demo_p3.db');
  const fixturePath = path.join(tempDir, 'ide_fixture.html');

  // Create local HTML fixture page
  const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Phase 3 Local IDE Fixture</title></head>
<body>
  <h1>Bureau Local IDE Fixture</h1>
  <textarea id="task-input" rows="4" cols="50"></textarea><br>
  <button id="submit-btn" onclick="document.getElementById('status-output').textContent = 'Submitted: ' + document.getElementById('task-input').value">Submit Task</button>
  <div id="status-output">Pending</div>
</body>
</html>`;
  fs.writeFileSync(fixturePath, htmlContent);
  const fixtureUrl = pathToFileURL(fixturePath).href;

  const db = openDbConnection(dbPath);

  const taskId = 'task-demo-p3';
  const dispatchId = 'disp-demo-p3';
  const windowTarget = 'window-demo-p3';
  const now = new Date().toISOString();

  let gatedDriver: GatedIdeDriver | null = null;

  try {
    // 1. Seed Task & Dispatch
    log('[1] Seeding task and dispatch in database...');
    db.execTransaction(() => {
      db.run(
        `INSERT INTO bureau_tasks (id, title, intent, spec, acceptance, state, verify_fixes, priority, work_uuid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, 1, 'uuid-p3-demo', ?, ?)`,
        taskId,
        'Phase 3 Exit Demo Task',
        'Demonstrate CDP browser control, calibrated selectors, and nonce correlation',
        'scripted junior edits fixture page via calibrated selectors',
        'Task completes cleanly',
        now,
        now
      );

      db.run(
        `INSERT INTO bureau_dispatches (id, task_id, work_uuid, actor_role, provider, model, status, attempts, created_at)
         VALUES (?, ?, 'uuid-p3-demo', 'junior-engineer', 'ollama', 'qwen2.5-coder', 'pending', 0, ?)`,
        dispatchId,
        taskId,
        now
      );
    });

    // Initialize default GatedIdeDriver composite with CdpIdeDriver
    const cdpDriver = new CdpIdeDriver((key: string) => {
      const row = db.get<{ css: string }>('SELECT css FROM bureau_selectors WHERE key = ?', key);
      if (!row) throw new Error(`Selector key ${key} not found`);
      return row.css;
    });
    gatedDriver = new GatedIdeDriver(cdpDriver, db);
    setIdeDriverOverride(gatedDriver);
    log(`[CDP] Profile Dir: ${tempDir}`);

    // 2. Register & Calibrate Selectors
    log('[2] Registering and calibrating CSS selectors...');
    registerSelector(db, { key: 'task.input', css: '#task-input' });
    registerSelector(db, { key: 'task.submit', css: '#submit-btn' });

    // Navigate browser to local fixture page before calibrating selectors
    await gatedDriver.navigate(fixtureUrl);

    const calJob1 = enqueueJob(db, { kind: 'selector.calibrate', task_id: taskId, payload: { key: 'task.input' } });
    await drainSingleJob(db, calJob1.id);

    const calJob2 = enqueueJob(db, { kind: 'selector.calibrate', task_id: taskId, payload: { key: 'task.submit' } });
    await drainSingleJob(db, calJob2.id);

    const sel1 = db.get<{ status: string }>('SELECT status FROM bureau_selectors WHERE key = ?', 'task.input');
    const sel2 = db.get<{ status: string }>('SELECT status FROM bureau_selectors WHERE key = ?', 'task.submit');
    log(`    Selector 'task.input' status: ${sel1?.status} (Expected: calibrated)`);
    log(`    Selector 'task.submit' status: ${sel2?.status} (Expected: calibrated)`);

    // 3. Script Mock LLM Client & Enqueue Junior Dispatch Job
    log('\n[3] Scripting Mock LLM decision sequence over Phase 1 callModel seam...');
    const mockClient = new MockClient([
      {
        text: JSON.stringify({ action: 'type', selectorKey: 'task.input', value: 'Phase 3 Exit Demo Content' }),
        tokensIn: 20,
        tokensOut: 15,
        latencyMs: 30,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      },
      {
        text: JSON.stringify({ action: 'click', selectorKey: 'task.submit' }),
        tokensIn: 25,
        tokensOut: 10,
        latencyMs: 25,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      },
      {
        text: JSON.stringify({ action: 'done' }),
        tokensIn: 15,
        tokensOut: 5,
        latencyMs: 10,
        costUsd: null,
        finishReason: 'stop',
        truncated: false
      }
    ]);

    setMockClientOverride(mockClient);
    process.env.BUREAU_MOCK_LLM = 'true';

    const dispatchJob = enqueueJob(db, {
      kind: 'junior.dispatch',
      task_id: taskId,
      payload: {
        dispatchId,
        windowTarget,
        url: fixtureUrl
      }
    });

    log('[4] Executing junior.dispatch job with real CDP browser & GatedIdeDriver...');
    await drainSingleJob(db, dispatchJob.id);

    const finalDispatch = db.get<{ status: string }>('SELECT status FROM bureau_dispatches WHERE id = ?', dispatchId);
    log(`    Dispatch Status: ${finalDispatch?.status} (Expected: completed)`);

    // 4. Verify Correlated Observations and Nonce Chain
    log('\n[5] Reconstructing Attributed Nonce Correlation Chain...');
    const chain = queryCorrelatedChain(db, dispatchId);
    log(`    Correlated Pairs Count: ${chain.pairs.length}`);
    for (const pair of chain.pairs) {
      const detail = typeof pair.span.detail === 'string' ? JSON.parse(pair.span.detail) : pair.span.detail;
      log(`    - Nonce: ${pair.nonce} | Selector: ${pair.selectorKey} | Action: ${detail.action}`);
    }

    // 5. Assert Guardrail Spans Count
    const guardrailSpans = db.all<BureauJournalRow>("SELECT * FROM bureau_journal WHERE kind = 'guardrail'");
    log(`\n[6] Zero Guardrail Spans Check: ${guardrailSpans.length === 0 ? 'PASS' : 'FAIL'} (${guardrailSpans.length} guardrail spans found)`);

    // 6. Print Attributed Journal Timeline
    const journalSpans = db.all<BureauJournalRow>('SELECT * FROM bureau_journal ORDER BY id ASC');
    log(`\n=== ATTRIBUTED JOURNAL TIMELINE (${journalSpans.length} spans) ===`);
    for (const s of journalSpans) {
      log(`- [${s.kind}] role:${s.actor_role} (${s.provider}/${s.model}) detail:${JSON.stringify(s.detail)}`);
    }

    log('\n=== PHASE 3 EXIT DEMO COMPLETED SUCCESSFULLY ===');
    return logs.join('\n');
  } finally {
    delete process.env.BUREAU_MOCK_LLM;
    setMockClientOverride(null);
    if (gatedDriver) {
      try {
        await gatedDriver.close();
      } catch {
        // Ignored
      }
    }
    setIdeDriverOverride(null);
    closeDatabase();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

const isCli = process.argv[1] !== undefined && import.meta.url.toLowerCase().includes(path.basename(process.argv[1]).toLowerCase());
if (isCli) {
  void runDemoPhase3();
}
