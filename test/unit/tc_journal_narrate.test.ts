import { describe, expect, it } from 'vitest';
import { narrateEntry } from '../../engine/journal/narrate.ts';

describe('tc_journal_narrate: pure journal narration layer', () => {
  describe('1. Transition mappings', () => {
    it('narrates transition with fromState and toState', () => {
      const row = {
        kind: 'transition',
        detail: { fromState: 'queued', toState: 'claimed' }
      };
      expect(narrateEntry(row)).toBe('Task moved from queued to claimed.');
    });

    it('narrates transition with from and to keys', () => {
      const row = {
        kind: 'transition',
        detail: { from: 'verifying', to: 'needs-review' }
      };
      expect(narrateEntry(row)).toBe('Task moved from verifying to needs-review.');
    });

    it('narrates transition from raw string "queued->claimed"', () => {
      const row = {
        kind: 'transition',
        detail: 'queued->claimed'
      };
      expect(narrateEntry(row)).toBe('Task moved from queued to claimed.');
    });

    it('narrates transition with only toState', () => {
      const row = {
        kind: 'transition',
        detail: { toState: 'claimed' }
      };
      expect(narrateEntry(row)).toBe('Task moved to claimed.');
    });

    it('narrates transition fallback when states are empty', () => {
      const row = {
        kind: 'transition',
        detail: {}
      };
      expect(narrateEntry(row)).toBe('Task state transition.');
    });
  });

  describe('2. Review mappings with dynamic attribution', () => {
    it('narrates work-review approved round 2 with provider', () => {
      const row = {
        kind: 'review',
        provider: 'claude',
        detail: { stage: 'work-review', verdict: 'approved', round: 2 }
      };
      expect(narrateEntry(row)).toBe('The work senior (claude) approved the implementation round 2.');
    });

    it('narrates work-review approved without round', () => {
      const row = {
        kind: 'review',
        provider: 'claude',
        detail: { stage: 'work-review', verdict: 'approved' }
      };
      expect(narrateEntry(row)).toBe('The work senior (claude) approved the implementation.');
    });

    it('narrates work-review revise request', () => {
      const row = {
        kind: 'review',
        provider: 'claude',
        detail: { stage: 'work-review', verdict: 'revise' }
      };
      expect(narrateEntry(row)).toBe('The work senior (claude) requested revisions on the implementation.');
    });

    it('narrates plan-review approved', () => {
      const row = {
        kind: 'review',
        provider: 'claude',
        detail: { stage: 'plan-review', verdict: 'approved' }
      };
      expect(narrateEntry(row)).toBe('The plan senior (claude) approved the plan.');
    });

    it('narrates plan-review revise request', () => {
      const row = {
        kind: 'review',
        provider: 'claude',
        detail: { stage: 'plan-review', verdict: 'revise' }
      };
      expect(narrateEntry(row)).toBe('The plan senior (claude) requested revisions on the plan.');
    });

    it('derives attribution from actor_role when provider is absent', () => {
      const row = {
        kind: 'review',
        actor_role: 'senior-engineer',
        detail: { stage: 'work-review', verdict: 'approved' }
      };
      expect(narrateEntry(row)).toBe('The work senior (senior-engineer) approved the implementation.');
    });
  });

  describe('3. Human operator action mappings', () => {
    it('narrates human approve action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'approve' }
      };
      expect(narrateEntry(row)).toBe('The operator approved the task for delivery.');
    });

    it('narrates human rearm action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'rearm' }
      };
      expect(narrateEntry(row)).toBe('The operator re-armed the task fix budget.');
    });

    it('narrates human archive action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'archive' }
      };
      expect(narrateEntry(row)).toBe('The operator archived the task.');
    });

    it('narrates human unarchive action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'unarchive' }
      };
      expect(narrateEntry(row)).toBe('The operator unarchived the task.');
    });

    it('narrates human complete action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'complete' }
      };
      expect(narrateEntry(row)).toBe('The operator marked the task completed.');
    });

    it('narrates human reopen action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'reopen' }
      };
      expect(narrateEntry(row)).toBe('The operator reopened the task.');
    });

    it('narrates human rekick action', () => {
      const row = {
        kind: 'human',
        detail: { action: 'rekick' }
      };
      expect(narrateEntry(row)).toBe('The operator re-kicked the task.');
    });

    it('narrates human asset actions', () => {
      expect(narrateEntry({ kind: 'human', detail: { action: 'asset_create', name: 'my-asset' } }))
        .toBe('The operator created asset my-asset.');
      expect(narrateEntry({ kind: 'human', detail: { action: 'asset_update', id: 'ast-1' } }))
        .toBe('The operator updated asset ast-1.');
      expect(narrateEntry({ kind: 'human', detail: { action: 'asset_delete', id: 'ast-1' } }))
        .toBe('The operator deleted asset ast-1.');
    });
  });

  describe('4. Dispatch mappings', () => {
    it('narrates dispatch with provider attribution', () => {
      const row = {
        kind: 'dispatch',
        provider: 'antigravity',
        detail: { status: 'running' }
      };
      expect(narrateEntry(row)).toBe('Work dispatched to the junior (antigravity).');
    });

    it('narrates dispatch with actor_role fallback', () => {
      const row = {
        kind: 'dispatch',
        actor_role: 'junior-engineer',
        detail: { status: 'running' }
      };
      expect(narrateEntry(row)).toBe('Work dispatched to the junior (junior-engineer).');
    });
  });

  describe('5. Guardrail mappings', () => {
    it('narrates guardrail refusal by action', () => {
      const row = {
        kind: 'guardrail',
        detail: { action: 'work_preconditions_refusal' }
      };
      expect(narrateEntry(row)).toBe('A guardrail refused an action: work_preconditions_refusal.');
    });

    it('narrates guardrail refusal by reason', () => {
      const row = {
        kind: 'guardrail',
        detail: { reason: 'lease expired' }
      };
      expect(narrateEntry(row)).toBe('A guardrail refused an action: lease expired.');
    });
  });

  describe('6. Additional bureau event kinds', () => {
    it('narrates llm call', () => {
      expect(narrateEntry({ kind: 'llm', model: 'claude-3-5-sonnet' }))
        .toBe('LLM call to claude-3-5-sonnet completed.');
    });

    it('narrates tool execution', () => {
      expect(narrateEntry({ kind: 'tool', detail: { name: 'git_status' } }))
        .toBe('Tool git_status executed.');
    });

    it('narrates observation', () => {
      expect(narrateEntry({ kind: 'observation' }))
        .toBe('Junior observation recorded.');
    });

    it('narrates system event', () => {
      expect(narrateEntry({ kind: 'system' }))
        .toBe('System event recorded.');
    });

    it('narrates task-filed', () => {
      expect(narrateEntry({ kind: 'task-filed' }))
        .toBe('Task filed into bureau.');
      expect(narrateEntry({ kind: 'task-filed', detail: { title: 'Build a clicker' } }))
        .toBe('Task filed into bureau: "Build a clicker".');
    });

    it('narrates project-registered and provisioned', () => {
      expect(narrateEntry({ kind: 'project-registered', detail: { name: 'my-project' } }))
        .toBe('Project my-project registered.');
      expect(narrateEntry({ kind: 'project-provisioned', detail: { name: 'my-project' } }))
        .toBe('Project my-project provisioned.');
    });

    it('narrates assignment', () => {
      expect(narrateEntry({ kind: 'assignment', detail: { role: 'junior-engineer' } }))
        .toBe('Task assigned to junior-engineer.');
      expect(narrateEntry({ kind: 'assignment', detail: { junior: 'A', senior: 'claude' } }))
        .toBe('Task assigned to junior (A) and senior (claude).');
    });

    it('narrates observation with stages and actions', () => {
      expect(narrateEntry({ kind: 'observation', detail: { stage: 'plan-authoring', junior: 'A' } }))
        .toBe('The junior (A) authored the implementation plan.');
      expect(narrateEntry({ kind: 'observation', detail: { stage: 'verify-fix', junior: 'B' } }))
        .toBe('The junior (B) completed verify-fix dispatch.');
      expect(narrateEntry({ kind: 'observation', detail: { stage: 'work-review-fix', junior: 'A' } }))
        .toBe('The junior (A) completed work-review fix dispatch.');
      expect(narrateEntry({ kind: 'observation', detail: { stage: 'junior-implementation', junior: 'A' } }))
        .toBe('The junior (A) completed work dispatch.');
      expect(narrateEntry({ kind: 'observation', detail: { dispatchId: 'd-123', junior: 'A' } }))
        .toBe('The junior (A) completed work dispatch.');
    });

    it('narrates diff-review stages', () => {
      expect(narrateEntry({ kind: 'review', provider: 'claude', detail: { stage: 'diff-review', verdict: 'approved' } }))
        .toBe('The diff senior (claude) approved the code diff.');
      expect(narrateEntry({ kind: 'review', provider: 'zai', detail: { stage: 'diff-review', verdict: 'amend' } }))
        .toBe('The diff senior (zai) requested changes on the code diff.');
    });

    it('narrates verify_run_completed tool span', () => {
      expect(narrateEntry({ kind: 'tool', detail: { action: 'verify_run_completed', exit_code: 0 } }))
        .toBe('Verification completed successfully (exit code 0).');
      expect(narrateEntry({ kind: 'tool', detail: { action: 'verify_run_completed', exit_code: 1 } }))
        .toBe('Verification completed with exit code 1.');
    });

    it('narrates system delivery and durability spans', () => {
      expect(narrateEntry({ kind: 'system', detail: { action: 'pr.create', url: 'https://github.com/org/repo/pull/42' } }))
        .toBe('Pull request created: https://github.com/org/repo/pull/42.');
      expect(narrateEntry({ kind: 'system', detail: { action: 'pr.merge', mergedBy: 'system:deterministic:core' } }))
        .toBe('Pull request merged by system:deterministic:core.');
      expect(narrateEntry({ kind: 'system', detail: { action: 'backup.push', remote: 'origin', branch: 'main' } }))
        .toBe('Backup pushed to origin/main.');
      expect(narrateEntry({ kind: 'system', detail: { action: 'junior_pointed_at_worktree', path: '/worktrees/wt-1' } }))
        .toBe('Junior pointed at worktree: /worktrees/wt-1.');
    });
  });

  describe('7. Unknown kind and empty fallbacks', () => {
    it('returns generic sentence for unknown kinds without throwing', () => {
      expect(narrateEntry({ kind: 'alien_event' })).toBe('Journal event: alien_event.');
    });

    it('handles missing kind gracefully', () => {
      expect(narrateEntry({})).toBe('Journal event.');
    });

    it('handles null and undefined row input', () => {
      expect(narrateEntry(null)).toBe('Journal event.');
      expect(narrateEntry(undefined)).toBe('Journal event.');
    });
  });

  describe('8. Detail input robustness permutations', () => {
    it('handles JSON string detail', () => {
      const row = {
        kind: 'transition',
        detail: JSON.stringify({ fromState: 'queued', toState: 'claimed' })
      };
      expect(narrateEntry(row)).toBe('Task moved from queued to claimed.');
    });

    it('handles plain string detail', () => {
      const row = {
        kind: 'human',
        detail: 'approve'
      };
      expect(narrateEntry(row)).toBe('The operator approved the task for delivery.');
    });

    it('handles null detail', () => {
      const row = {
        kind: 'transition',
        detail: null
      };
      expect(narrateEntry(row)).toBe('Task state transition.');
    });

    it('handles undefined detail', () => {
      const row = {
        kind: 'transition',
        detail: undefined
      };
      expect(narrateEntry(row)).toBe('Task state transition.');
    });

    it('handles empty string detail', () => {
      const row = {
        kind: 'transition',
        detail: ''
      };
      expect(narrateEntry(row)).toBe('Task state transition.');
    });

    it('handles corrupted JSON string gracefully', () => {
      const row = {
        kind: 'transition',
        detail: '{"broken'
      };
      expect(narrateEntry(row)).toBe('Task state transition.');
    });
  });
});
