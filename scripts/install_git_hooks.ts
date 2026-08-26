/**
 * install_git_hooks — installs the merge-law git hooks (scripts/merge_guard_hook.ts)
 * as this repo's `pre-merge-commit` and `pre-commit` hooks.
 *
 * Idempotent: re-running overwrites the bureau-managed hooks in place and never
 * duplicates. Windows-safe: writes LF-only sh wrappers (git's bundled sh runs
 * them) and marks them executable. Also sets `merge.ff = false` on this repo so
 * a manual merge into the protected branch always creates a merge commit the
 * hook can inspect (a fast-forward merge would otherwise run no hook).
 *
 * Run: `npm run hooks:install`
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openDbConnection } from '../engine/db/index.ts';
import { journal } from '../engine/journal/writer.ts';

const MANAGED_MARKER = 'bureau-merge-law-hook';

function wrapperFor(hookName: string): string {
  // LF-only. `git rev-parse --show-toplevel` keeps the path correct regardless
  // of where git invokes the hook from.
  return [
    '#!/bin/sh',
    `# ${MANAGED_MARKER} — installed by scripts/install_git_hooks.ts. Do not edit.`,
    '# Enforces the merge law: nothing reaches the protected branch that did not',
    '# travel the tracked delivery path (Senior APPROVE + done-gate). See',
    '# engine/delivery/merge_guard.ts.',
    'ROOT="$(git rev-parse --show-toplevel)"',
    `exec node --experimental-strip-types "$ROOT/scripts/merge_guard_hook.ts" ${hookName}`,
    ''
  ].join('\n');
}

export function installGitHooks(opts?: { repoDir?: string; journalInstall?: boolean }): {
  hooksDir: string;
  installed: string[];
} {
  const repoDir = opts?.repoDir || process.cwd();
  const hooksDir = execSync('git rev-parse --git-path hooks', { cwd: repoDir, encoding: 'utf8' }).trim();
  const absHooksDir = path.isAbsolute(hooksDir) ? hooksDir : path.join(repoDir, hooksDir);
  fs.mkdirSync(absHooksDir, { recursive: true });

  const installed: string[] = [];
  for (const hookName of ['pre-merge-commit', 'pre-commit']) {
    const hookPath = path.join(absHooksDir, hookName);
    // Refuse to clobber a NON-bureau hook the user may already rely on.
    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf8');
      if (!existing.includes(MANAGED_MARKER)) {
        throw new Error(
          `Refusing to overwrite existing non-bureau hook at ${hookPath}. ` +
            `Move it aside or merge the merge-law wrapper in by hand.`
        );
      }
    }
    fs.writeFileSync(hookPath, wrapperFor(hookName), { encoding: 'utf8' });
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      /* chmod is a no-op on some Windows filesystems; git's sh still runs it */
    }
    installed.push(hookName);
  }

  // Force merge commits on manual merges so the hook always fires (no silent ff).
  try {
    execSync('git config merge.ff false', { cwd: repoDir });
  } catch {
    /* non-fatal: the hooks still catch merge commits, only ff is left unguarded */
  }

  if (opts?.journalInstall !== false) {
    try {
      const db = openDbConnection(process.env.BUREAU_DB_PATH || 'db/bureau.db');
      journal(db, {
        kind: 'system',
        attribution: { actor_role: 'human-operator', provider: 'deterministic', model: 'core', account: null },
        detail: { action: 'merge_guard_hooks_installed', hooks: installed, hooksDir: absHooksDir }
      });
    } catch {
      /* journaling is best-effort; the hooks are installed regardless */
    }
  }

  return { hooksDir: absHooksDir, installed };
}

if (process.argv[1]?.endsWith('install_git_hooks.ts')) {
  const result = installGitHooks();
  process.stdout.write(
    `Installed merge-law hooks (${result.installed.join(', ')}) in ${result.hooksDir}\n` +
      `Set merge.ff=false so manual merges into the protected branch always create an inspectable commit.\n`
  );
}
