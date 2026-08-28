import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BureauProjectRow, DbConnection, ProvisionProjectInput, RepoProvider } from '../contract/types.ts';
import { PROVISION_ACTOR_ROLES } from '../contract/constants.ts';
import { journal } from '../journal/writer.ts';
import { ensureWorktreeIgnored, registerProject } from './manager.ts';
import { getGithubOwner, getProjectsRoot, getRepoPrefix } from './config.ts';
import { getRepoProvider, ProvisionError } from './repo_provider.ts';
import { projectProvisionJobId } from '../jobs/ids.ts';

const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function resolveJobId(db: DbConnection, canonicalName?: string, explicitJobId?: string): string | undefined {
  if (explicitJobId) {
    const row = db.get<{ id: string }>('SELECT id FROM bureau_jobs WHERE id = ?', explicitJobId);
    if (row) return row.id;
  }
  if (canonicalName) {
    const candidateId = projectProvisionJobId(canonicalName);
    const row = db.get<{ id: string }>('SELECT id FROM bureau_jobs WHERE id = ?', candidateId);
    if (row) return row.id;
  }
  return undefined;
}

export async function provisionProject(
  db: DbConnection,
  input: ProvisionProjectInput,
  options?: { repoProvider?: RepoProvider }
): Promise<BureauProjectRow> {
  const actorRole = input.attribution?.actor_role;

  // 1. Actor Authorization
  if (!actorRole || !(PROVISION_ACTOR_ROLES as readonly string[]).includes(actorRole)) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: {
        reason: 'actor_not_authorized',
        actor_role: actorRole,
        allowed: PROVISION_ACTOR_ROLES
      }
    });
    throw new ProvisionError(
      `Actor role '${actorRole}' is not authorized to provision projects. Allowed: ${PROVISION_ACTOR_ROLES.join(', ')}`,
      'ACTOR_NOT_AUTHORIZED'
    );
  }

  // 2. Public Visibility Gate: only human-operator can provision public repositories
  const visibility = input.visibility ?? 'private';
  if (visibility === 'public' && actorRole !== 'human-operator') {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: {
        reason: 'public_visibility_restricted',
        actor_role: actorRole
      }
    });
    throw new ProvisionError(
      "Only 'human-operator' is permitted to provision public repositories.",
      'PUBLIC_VISIBILITY_RESTRICTED'
    );
  }

  // 3. Slug Validation
  const rawName = input.name?.trim();
  if (!rawName) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: { reason: 'empty_slug' }
    });
    throw new ProvisionError('Project name cannot be empty', 'INVALID_SLUG');
  }

  if (WINDOWS_RESERVED_NAMES.test(rawName)) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: { reason: 'reserved_name', name: rawName }
    });
    throw new ProvisionError(`Project name '${rawName}' is a reserved device name.`, 'INVALID_SLUG');
  }

  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: { reason: 'invalid_slug_traversal', name: rawName }
    });
    throw new ProvisionError(`Project name '${rawName}' contains invalid characters or path traversal sequences.`, 'INVALID_SLUG');
  }

  if (!SLUG_REGEX.test(rawName)) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      detail: { reason: 'invalid_slug_format', name: rawName }
    });
    throw new ProvisionError(`Project name '${rawName}' is not a valid slug.`, 'INVALID_SLUG');
  }

  // 4. Prefix & Canonical Naming
  const prefix = input.repoPrefix ?? getRepoPrefix(db);
  const canonicalName = rawName.startsWith(prefix) ? rawName : `${prefix}${rawName}`;

  // 5. Collision Check (Case-Insensitive against DB)
  const existingRow = db.get<BureauProjectRow>(
    'SELECT * FROM bureau_projects WHERE LOWER(name) = LOWER(?)',
    canonicalName
  );
  if (existingRow) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      jobId: resolveJobId(db, canonicalName, input.jobId),
      detail: {
        reason: 'project_already_exists',
        name: canonicalName,
        existingId: existingRow.id
      }
    });
    throw new ProvisionError(`Project with name '${canonicalName}' already exists.`, 'PROJECT_ALREADY_EXISTS');
  }

  // 6. Path Containment Enforcement
  const projectsRoot = input.projectsRoot ? path.resolve(input.projectsRoot) : getProjectsRoot(db);
  const targetPath = path.resolve(projectsRoot, canonicalName);
  const rel = path.relative(projectsRoot, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '' || rel.includes('..')) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      jobId: resolveJobId(db, canonicalName, input.jobId),
      detail: {
        reason: 'path_containment_violation',
        targetPath,
        projectsRoot
      }
    });
    throw new ProvisionError(
      `Target project path '${targetPath}' escapes projects root '${projectsRoot}'.`,
      'PATH_CONTAINMENT_VIOLATION'
    );
  }

  // 7. On-Disk Inspection & Clean Adoption
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      journal(db, {
        kind: 'guardrail',
        attribution: input.attribution,
        jobId: resolveJobId(db, canonicalName, input.jobId),
        detail: { reason: 'directory_collision_not_dir', targetPath }
      });
      throw new ProvisionError(`Target path '${targetPath}' already exists and is not a directory.`, 'DIRECTORY_COLLISION');
    }

    const entries = fs.readdirSync(targetPath);
    const isCleanScaffold = entries.every(e => e === '.git' || e === '.gitignore' || e === 'README.md');
    let hasOriginRemote = false;
    if (fs.existsSync(path.join(targetPath, '.git'))) {
      try {
        const remotes = execFileSync('git', ['remote'], { cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        hasOriginRemote = remotes.split('\n').map(r => r.trim()).includes('origin');
      } catch {}
    }

    if (!isCleanScaffold || hasOriginRemote) {
      journal(db, {
        kind: 'guardrail',
        attribution: input.attribution,
        jobId: resolveJobId(db, canonicalName, input.jobId),
        detail: { reason: 'directory_collision', targetPath }
      });
      throw new ProvisionError(`Target directory '${targetPath}' already exists and is not an adoptable project scaffold.`, 'DIRECTORY_COLLISION');
    }
  } else {
    fs.mkdirSync(targetPath, { recursive: true });
  }

  // 8. Local Git Initialization
  if (!fs.existsSync(path.join(targetPath, '.git'))) {
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: targetPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  ensureWorktreeIgnored(targetPath);

  const readmePath = path.join(targetPath, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${canonicalName}\n\n${input.description ?? ''}\n`, 'utf8');
  }

  let hasCommits = false;
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetPath, stdio: ['pipe', 'pipe', 'pipe'] });
    hasCommits = true;
  } catch {
    hasCommits = false;
  }

  if (!hasCommits) {
    execFileSync('git', ['add', '.'], { cwd: targetPath, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['commit', '-m', 'chore: bureau project scaffold'], {
      cwd: targetPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Bureau Provisioner',
        GIT_AUTHOR_EMAIL: 'bureau@departmentofcoding.internal',
        GIT_COMMITTER_NAME: 'Bureau Provisioner',
        GIT_COMMITTER_EMAIL: 'bureau@departmentofcoding.internal'
      }
    });
  }

  // 9. Remote GitHub Repository Creation
  const repoProvider = options?.repoProvider ?? getRepoProvider();
  const githubOwner = input.githubOwner ?? getGithubOwner(db);

  let remoteResult: { url: string };
  try {
    remoteResult = await repoProvider.createRemote({
      name: canonicalName,
      owner: githubOwner,
      visibility,
      sourcePath: targetPath,
      description: input.description ?? null
    });
  } catch (err: any) {
    journal(db, {
      kind: 'guardrail',
      attribution: input.attribution,
      jobId: resolveJobId(db, canonicalName, input.jobId),
      detail: {
        reason: 'remote_creation_failed',
        name: canonicalName,
        error: err.message
      }
    });
    throw err;
  }

  // 10. Database Registration — through the EXISTING registerProject gate
  // (its on-disk dir + git-repo checks re-verify what we just built; its
  // UNIQUE-collision handling and project-registered span stay single-sourced).
  const row = registerProject(db, {
    name: canonicalName,
    pathToRepo: targetPath,
    description: input.description?.trim() ?? null,
    github_url: remoteResult.url,
    provisioned_by: actorRole ?? null,
    visibility,
    attribution: input.attribution
  });

  // 11. Journal Span
  journal(db, {
    kind: 'project-provisioned',
    attribution: input.attribution,
    jobId: resolveJobId(db, canonicalName, input.jobId),
    detail: {
      projectId: row.id,
      name: row.name,
      pathToRepo: row.path_to_repo,
      githubUrl: remoteResult.url,
      visibility,
      provisionedBy: actorRole,
      description: row.description
    }
  });

  return row;
}
