import fs from 'node:fs';
import path from 'node:path';

/**
 * Persist a junior's captured artifacts as department data the Senior can open
 * and diff. Antigravity emits an implementation **plan** before coding and a
 * **walkthrough** when done; both, plus the whole raw output, are written per
 * task under `docs/junior-artifacts/<taskId>/`.
 *
 * The journal records that these exist (attributed spans); the files hold the
 * full text so a review isn't limited to a transcript tail.
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

/** Root under which per-task artifact folders live. Overridable for tests. */
export function artifactsRoot(baseDir: string = process.cwd()): string {
  return path.join(baseDir, 'docs', 'junior-artifacts');
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
 */
export function readLatestArtifacts(taskId: string, baseDir: string = process.cwd()): ReadArtifacts {
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
 */
export function writeJuniorArtifacts(
  taskId: string,
  dispatchId: string,
  art: CapturedArtifacts,
  baseDir: string = process.cwd()
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
    fs.writeFileSync(p, `${value!.trim()}\n`, 'utf8');
    files[name] = p;
  }
  return { dir, files };
}
