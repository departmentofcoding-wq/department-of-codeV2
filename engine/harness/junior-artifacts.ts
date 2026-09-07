import fs from 'node:fs';
import path from 'node:path';
import { redactOutput } from '../contract/tools.ts';
import { getRepoRoot } from '../worktrees/manager.ts';

/**
 * Persist a junior's captured artifacts as department data the Senior can open
 * and diff. Antigravity emits an implementation **plan** before coding and a
 * **walkthrough** when done; both, plus the whole raw output, are written per
 * task under `docs/junior-artifacts/<taskId>/`.
 *
 * The journal records that these exist (attributed spans); the files hold the
 * full text so a review isn't limited to a transcript tail.
 *
 * SECURITY: these files are kept and committed for history, so every artifact is
 * scrubbed through `redactOutput` before it touches disk — a junior transcript
 * can echo an API key or a `KEY=value` line, and once committed that would live
 * in git history forever. Redaction is the same door the console read APIs use.
 */
export interface CapturedArtifacts {
  junior?: string;
  fullOutput?: string;
  plan?: string;
  walkthrough?: string;
  reply?: string;
}

export interface WrittenArtifacts {
  dir: string;
  files: Record<string, string>;
}

let artifactsRootOverride: string | null = null;

/**
 * Set an in-memory override for the artifacts root directory (test seam).
 * When set, all artifact operations redirect here to isolate test runs.
 */
export function setArtifactsRootOverride(dir: string | null): void {
  artifactsRootOverride = dir;
}

/**
 * Get the active override if one is configured (in-memory test override or
 * BUREAU_ARTIFACTS_ROOT environment variable).
 */
export function getArtifactsRootOverride(): string | null {
  if (artifactsRootOverride !== null) return artifactsRootOverride;
  if (process.env.BUREAU_ARTIFACTS_ROOT && process.env.BUREAU_ARTIFACTS_ROOT.trim()) {
    return process.env.BUREAU_ARTIFACTS_ROOT.trim();
  }
  return null;
}

/**
 * Root under which per-task artifact folders live.
 *
 * Resolution order:
 * 1. Test/environment override seam (if active)
 * 2. Explicit `baseDir` if passed (`<baseDir>/docs/junior-artifacts`)
 * 3. Default repository root via `getRepoRoot()` (`<repoRoot>/docs/junior-artifacts`)
 *
 * Note: `process.cwd()` is never used as an uncontained default; `getRepoRoot()`
 * resolves git toplevel and falls back to cwd only as a CLI safety net.
 */
export function artifactsRoot(baseDir?: string): string {
  const override = getArtifactsRootOverride();
  if (override) return override;
  if (baseDir) return path.join(baseDir, 'docs', 'junior-artifacts');
  return path.join(getRepoRoot(), 'docs', 'junior-artifacts');
}

function safeSeg(s: string): string {
  return (s || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export interface ReadArtifacts {
  dir: string;
  plan: string;
  walkthrough: string;
  transcript: string;
  reply: string;
}

/**
 * Read back the MOST RECENT captured artifacts for a task, so a Senior can
 * review them. Returns empty strings for any artifact not present. Looks under
 * `docs/junior-artifacts/<taskId>/` and picks the newest run directory.
 *
 * @param taskId Target task ID
 * @param baseDir Optional explicit base repo directory (defaults to repo root / override)
 */
export function readLatestArtifacts(taskId: string, baseDir?: string): ReadArtifacts {
  const taskDir = path.join(artifactsRoot(baseDir), safeSeg(taskId));
  const empty: ReadArtifacts = { dir: '', plan: '', walkthrough: '', transcript: '', reply: '' };
  if (!fs.existsSync(taskDir)) return empty;
  const runs = fs
    .readdirSync(taskDir)
    .map(name => path.join(taskDir, name))
    .filter(p => fs.statSync(p).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (runs.length === 0) return empty;
  const dir = runs[0];
  const read = (f: string) => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  return {
    dir,
    plan: read('plan.md'),
    walkthrough: read('walkthrough.md'),
    transcript: read('transcript.md'),
    reply: read('reply.md')
  };
}

/**
 * Write whichever artifacts are present. Returns the directory and the map of
 * artifact-name → absolute path actually written (empty artifacts are skipped).
 *
 * @param taskId Target task ID
 * @param dispatchId Dispatch execution ID
 * @param art Captured artifacts bundle
 * @param baseDir Optional explicit base repo directory (defaults to repo root / override)
 */
export function writeJuniorArtifacts(
  taskId: string,
  dispatchId: string,
  art: CapturedArtifacts,
  baseDir?: string
): WrittenArtifacts {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(
    artifactsRoot(baseDir),
    safeSeg(taskId),
    `${safeSeg(dispatchId)}-junior${safeSeg(art.junior || '?')}-${stamp}`
  );
  const files: Record<string, string> = {};
  const parts: Array<[string, string | undefined]> = [
    ['plan.md', art.plan],
    ['walkthrough.md', art.walkthrough],
    ['reply.md', art.reply],
    ['transcript.md', art.fullOutput]
  ];
  const present = parts.filter(([, v]) => v && v.trim());
  if (present.length === 0) return { dir, files };

  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of present) {
    const p = path.join(dir, name);
    // Scrub secrets before persisting — these files are committed for history.
    fs.writeFileSync(p, `${redactOutput(value!.trim())}\n`, 'utf8');
    files[name] = p;
  }
  return { dir, files };
}
