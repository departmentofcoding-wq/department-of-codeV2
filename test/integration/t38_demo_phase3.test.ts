import { describe, expect, it } from 'vitest';
import { runDemoPhase3 } from '../../scripts/demo_phase3.ts';

describe('T38: Phase 3 Exit Demo Integration Test (Milestone CX)', () => {
  it('executes runDemoPhase3() to completion with exit code 0, journal output, and clean process teardown', async () => {
    const output = await runDemoPhase3();

    expect(output).toContain('=== DEPARTMENT OF CODE V2 — PHASE 3 EXIT DEMO');
    expect(output).toContain('=== PHASE 3 EXIT DEMO COMPLETED SUCCESSFULLY ===');
    expect(output).toContain('Zero Guardrail Spans Check: PASS');
  }, 30000);
});
