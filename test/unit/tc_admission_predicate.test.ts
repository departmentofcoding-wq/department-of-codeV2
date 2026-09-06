import { describe, it, expect } from 'vitest';
import {
  evaluateAdmissionGate,
  type AdmissionInput,
  type AdmissionDecision
} from '../../engine/flow/admission_predicate.ts';

describe('Unit: evaluateAdmissionGate pure admission predicate', () => {
  it('Branch 1: occupied: true -> hold_occupied (no probe executed, no guardrail span)', () => {
    const input: AdmissionInput = {
      occupied: true,
      inCooldown: false,
      probeResult: undefined
    };

    const decision: AdmissionDecision = evaluateAdmissionGate(input);
    expect(decision).toEqual({ action: 'hold_occupied' });
    expect('journalAction' in decision).toBe(false);
  });

  it('Branch 2: occupied: false, inCooldown: true -> hold_cooldown (no probe executed, emits junior_unhealthy_hold)', () => {
    const input: AdmissionInput = {
      occupied: false,
      inCooldown: true,
      probeResult: undefined
    };

    const decision: AdmissionDecision = evaluateAdmissionGate(input);
    expect(decision.action).toBe('hold_cooldown');
    if (decision.action === 'hold_cooldown') {
      expect(decision.journalAction).toBe('junior_unhealthy_hold');
      expect(decision.reason).toBeTruthy();
    }
  });

  it('Branch 3: occupied: false, inCooldown: false, probeResult: false (timeout/wedged) -> hold_probe_failed', () => {
    const input: AdmissionInput = {
      occupied: false,
      inCooldown: false,
      probeResult: false
    };

    const decision: AdmissionDecision = evaluateAdmissionGate(input);
    expect(decision.action).toBe('hold_probe_failed');
    if (decision.action === 'hold_probe_failed') {
      expect(decision.journalAction).toBe('junior_unhealthy_hold');
      expect(decision.reason).toBeTruthy();
    }
  });

  it('Branch 4: occupied: false, inCooldown: false, probeResult: false (malformed echo) -> hold_probe_failed', () => {
    const input: AdmissionInput = {
      occupied: false,
      inCooldown: false,
      probeResult: false
    };

    const decision: AdmissionDecision = evaluateAdmissionGate(input);
    expect(decision.action).toBe('hold_probe_failed');
    if (decision.action === 'hold_probe_failed') {
      expect(decision.journalAction).toBe('junior_unhealthy_hold');
    }
  });

  it('Branch 5: occupied: false, inCooldown: false, probeResult: true -> admit', () => {
    const input: AdmissionInput = {
      occupied: false,
      inCooldown: false,
      probeResult: true
    };

    const decision: AdmissionDecision = evaluateAdmissionGate(input);
    expect(decision).toEqual({ action: 'admit' });
  });
});
