import type { BureauJournalRow } from '../contract/index.ts';

function safeParseDetail(detail: unknown): Record<string, any> {
  if (!detail) return {};
  if (typeof detail === 'object' && !Array.isArray(detail)) {
    return detail as Record<string, any>;
  }
  if (typeof detail === 'string') {
    const trimmed = detail.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return { raw: detail };
      }
    }
    return { raw: detail };
  }
  return {};
}

/**
 * Pure mapper converting a structured journal row into one natural-language sentence.
 * Zero I/O, zero DB operations, total function (never throws).
 */
export function narrateEntry(row: Partial<BureauJournalRow> | Record<string, unknown> | null | undefined): string {
  if (!row || typeof row !== 'object') {
    return 'Journal event.';
  }

  try {
    const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
    const detail = safeParseDetail(row.detail);

    switch (kind) {
      case 'transition': {
        let fromState = detail.fromState || detail.from;
        let toState = detail.toState || detail.to;

        if (!fromState && !toState && typeof detail.raw === 'string' && detail.raw.includes('->')) {
          const parts = detail.raw.split('->');
          if (parts.length === 2) {
            fromState = parts[0].trim();
            toState = parts[1].trim();
          }
        }

        if (fromState && toState) {
          return `Task moved from ${fromState} to ${toState}.`;
        }
        if (toState) {
          return `Task moved to ${toState}.`;
        }
        return 'Task state transition.';
      }

      case 'review': {
        const senior = (typeof row.provider === 'string' && row.provider) ||
                       (typeof row.actor_role === 'string' && row.actor_role) ||
                       'senior';
        const stage = detail.stage || 'work-review';
        const verdict = detail.verdict || detail.action || '';
        const round = detail.round;

        if (stage === 'plan-review') {
          if (verdict === 'approved') {
            return `The plan senior (${senior}) approved the plan.`;
          }
          if (verdict === 'revise' || verdict === 'amend') {
            return `The plan senior (${senior}) requested revisions on the plan.`;
          }
          if (verdict) {
            return `The plan senior (${senior}) reviewed the plan: ${verdict}.`;
          }
          return `The plan senior (${senior}) completed a plan review.`;
        }

        if (stage === 'diff-review' || stage === 'work.diff-review' || stage === 'code-diff') {
          if (verdict === 'approved') {
            return `The diff senior (${senior}) approved the code diff.`;
          }
          if (verdict === 'revise' || verdict === 'amend') {
            return `The diff senior (${senior}) requested changes on the code diff.`;
          }
          if (verdict) {
            return `The diff senior (${senior}) reviewed the code diff: ${verdict}.`;
          }
          return `The diff senior (${senior}) completed a code diff review.`;
        }

        // Default: work-review
        if (verdict === 'approved') {
          if (round !== undefined && round !== null) {
            return `The work senior (${senior}) approved the implementation round ${round}.`;
          }
          return `The work senior (${senior}) approved the implementation.`;
        }
        if (verdict === 'revise' || verdict === 'amend') {
          return `The work senior (${senior}) requested revisions on the implementation.`;
        }
        if (verdict) {
          return `The work senior (${senior}) reviewed the implementation: ${verdict}.`;
        }
        return `The work senior (${senior}) completed a review.`;
      }

      case 'human': {
        const action = detail.action || (typeof detail.raw === 'string' ? detail.raw : '');
        if (action === 'approve' || action === 'approve_task') {
          return 'The operator approved the task for delivery.';
        }
        if (action === 'rearm' || action === 'rearm_budget') {
          return 'The operator re-armed the task fix budget.';
        }
        if (action === 'archive' || action === 'archive_task') {
          return 'The operator archived the task.';
        }
        if (action === 'unarchive' || action === 'unarchive_task') {
          return 'The operator unarchived the task.';
        }
        if (action === 'complete' || action === 'complete_task') {
          return 'The operator marked the task completed.';
        }
        if (action === 'reopen') {
          return 'The operator reopened the task.';
        }
        if (action === 'rekick') {
          return 'The operator re-kicked the task.';
        }
        if (action === 'asset_create') {
          const name = detail.name ? ` ${detail.name}` : (detail.id ? ` ${detail.id}` : '');
          return `The operator created asset${name}.`;
        }
        if (action === 'asset_update') {
          const name = detail.id ? ` ${detail.id}` : '';
          return `The operator updated asset${name}.`;
        }
        if (action === 'asset_delete') {
          const name = detail.id ? ` ${detail.id}` : '';
          return `The operator deleted asset${name}.`;
        }
        if (action) {
          return `Human operator performed action: ${action}.`;
        }
        return 'Human operator action recorded.';
      }

      case 'dispatch': {
        const junior = (typeof row.provider === 'string' && row.provider) ||
                       (typeof row.actor_role === 'string' && row.actor_role) ||
                       'junior';
        return `Work dispatched to the junior (${junior}).`;
      }

      case 'guardrail': {
        const action = detail.action || detail.reason || (typeof detail.raw === 'string' ? detail.raw : '') || 'action refused';
        return `A guardrail refused an action: ${action}.`;
      }

      case 'llm': {
        const model = (typeof row.model === 'string' && row.model) ||
                       (typeof row.provider === 'string' && row.provider) ||
                       'model';
        return `LLM call to ${model} completed.`;
      }

      case 'tool': {
        if (detail.action === 'verify_run_completed' || detail.name === 'verify_run_completed') {
          const exitCode = detail.exit_code !== undefined ? detail.exit_code : 0;
          if (exitCode === 0) {
            return 'Verification completed successfully (exit code 0).';
          }
          return `Verification completed with exit code ${exitCode}.`;
        }
        const toolName = detail.name || detail.tool || 'execution';
        return `Tool ${toolName} executed.`;
      }

      case 'observation': {
        const junior = detail.junior ||
                       (typeof row.provider === 'string' && row.provider) ||
                       (typeof row.actor_role === 'string' && row.actor_role) ||
                       'junior';
        const stage = detail.stage || detail.action || '';
        if (stage === 'plan-authoring') {
          return `The junior (${junior}) authored the implementation plan.`;
        }
        if (stage === 'verify-fix') {
          return `The junior (${junior}) completed verify-fix dispatch.`;
        }
        if (stage === 'work-review-fix') {
          return `The junior (${junior}) completed work-review fix dispatch.`;
        }
        if (stage === 'junior-implementation' || detail.dispatchId) {
          return `The junior (${junior}) completed work dispatch.`;
        }
        if (detail.junior) {
          return `Junior (${junior}) observation recorded.`;
        }
        return 'Junior observation recorded.';
      }

      case 'system': {
        const action = detail.action || '';
        if (action === 'pr.create') {
          const target = detail.url || (detail.number ? `#${detail.number}` : '');
          return target ? `Pull request created: ${target}.` : 'Pull request created.';
        }
        if (action === 'pr.merge') {
          const by = detail.mergedBy ? ` by ${detail.mergedBy}` : '';
          return `Pull request merged${by}.`;
        }
        if (action === 'backup.push') {
          const target = detail.remote && detail.branch ? ` to ${detail.remote}/${detail.branch}` : '';
          return `Backup pushed${target}.`;
        }
        if (action === 'junior_pointed_at_worktree') {
          return `Junior pointed at worktree: ${detail.path}.`;
        }
        if (action) {
          return `System event: ${action}.`;
        }
        return 'System event recorded.';
      }

      case 'task-filed': {
        if (detail.title) {
          return `Task filed into bureau: "${detail.title}".`;
        }
        return 'Task filed into bureau.';
      }

      case 'project-registered': {
        const name = detail.name ? ` ${detail.name}` : '';
        return `Project${name} registered.`;
      }

      case 'project-provisioned': {
        const name = detail.name ? ` ${detail.name}` : '';
        return `Project${name} provisioned.`;
      }

      case 'assignment': {
        if (detail.junior && detail.senior) {
          return `Task assigned to junior (${detail.junior}) and senior (${detail.senior}).`;
        }
        if (detail.junior) {
          return `Task assigned to junior (${detail.junior}).`;
        }
        const role = detail.role || (typeof row.actor_role === 'string' ? row.actor_role : '') || 'worker';
        return `Task assigned to ${role}.`;
      }

      default: {
        return kind ? `Journal event: ${kind}.` : 'Journal event.';
      }
    }
  } catch {
    const k = row && typeof row.kind === 'string' ? row.kind.trim() : '';
    return k ? `Journal event: ${k}.` : 'Journal event.';
  }
}
