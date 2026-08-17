import { VACUOUS_VERIFY_COMMANDS } from './constants.ts';
import type { BureauIntakeSessionRow } from './types.ts';

export function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isVacuousVerify(command: string | null | undefined): boolean {
  if (!command) {
    return true;
  }
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return true;
  }
  return (VACUOUS_VERIFY_COMMANDS as readonly string[]).includes(normalized);
}

export type TaskGap = 'title' | 'intent' | 'verify_cmd' | 'verify_confirmed';

export function taskGaps(draft: Partial<BureauIntakeSessionRow>): TaskGap[] {
  const gaps: TaskGap[] = [];

  if (!draft.title || !draft.title.trim()) {
    gaps.push('title');
  }

  if (!draft.intent || !draft.intent.trim()) {
    gaps.push('intent');
  }

  if (!draft.verify_cmd || isVacuousVerify(draft.verify_cmd)) {
    gaps.push('verify_cmd');
  }

  if (!draft.verify_confirmed_at || !draft.verify_confirmed_by) {
    gaps.push('verify_confirmed');
  }

  return gaps;
}

export function formatActor(attribution: { actor_role: string; account?: string | null }): string {
  return attribution.account ? `${attribution.actor_role}:${attribution.account}` : attribution.actor_role;
}
