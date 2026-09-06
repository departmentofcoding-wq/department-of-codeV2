export interface AdmissionInput {
  occupied: boolean;
  inCooldown: boolean;
  probeResult?: boolean; // undefined when skipped due to occupied or cooldown
}

export type AdmissionDecision =
  | { action: 'admit' }
  | { action: 'hold_occupied' }
  | { action: 'hold_cooldown'; journalAction: 'junior_unhealthy_hold'; reason: string }
  | { action: 'hold_probe_failed'; journalAction: 'junior_unhealthy_hold'; reason: string };

/**
 * Pure admission gate evaluation enforcing 3-stage gate ordering:
 * 1. Capacity check: if occupied -> hold_occupied (no journal span)
 * 2. Cooldown check: if inCooldown -> hold_cooldown (emits junior_unhealthy_hold)
 * 3. CDP probe check: if probeResult === true -> admit, else hold_probe_failed (emits junior_unhealthy_hold)
 */
export function evaluateAdmissionGate(input: AdmissionInput): AdmissionDecision {
  if (input.occupied) {
    return { action: 'hold_occupied' };
  }

  if (input.inCooldown) {
    return {
      action: 'hold_cooldown',
      journalAction: 'junior_unhealthy_hold',
      reason: 'Junior is in cooldown'
    };
  }

  if (input.probeResult === true) {
    return { action: 'admit' };
  }

  return {
    action: 'hold_probe_failed',
    journalAction: 'junior_unhealthy_hold',
    reason: 'Junior CDP health handshake probe failed'
  };
}
