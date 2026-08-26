import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { BureauProjectRow, DbConnection, RegisterProjectInput } from '../contract/types.ts';
import { journal } from '../journal/writer.ts';
import { getRepoRoot } from '../worktrees/manager.ts';

export function isGitRepo(dirPath: string): boolean {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dirPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return Boolean(gitDir);
  } catch {
    return false;
  }
}

export function ensureWorktreeIgnored(repoPath: string): void {
  const gitignorePath = path.join(repoPath, '.gitignore');
  const ignorePattern = '/.bureau-worktrees/';
  try {
    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (!content.includes(ignorePattern) && !content.includes('.bureau-worktrees')) {
        const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
        fs.appendFileSync(gitignorePath, `${separator}${ignorePattern}\n`, 'utf8');
      }
    } else {
      fs.writeFileSync(gitignorePath, `${ignorePattern}\n`, 'utf8');
    }
  } catch {
    // Non-fatal if project folder is read-only in test setup
  }
}

export function registerProject(
  db: DbConnection,
  input: RegisterProjectInput
): BureauProjectRow {
  const name = input.name?.trim();
  if (!name) {
    throw new Error('Project name cannot be empty');
  }

  const rawPath = input.pathToRepo?.trim();
  if (!rawPath) {
    throw new Error('Project path cannot be empty');
  }

  const resolvedPath = path.resolve(rawPath);

  // 1. Validate path exists on disk
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Target path does not exist on disk: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${resolvedPath}`);
  }

  // 2. Validate git repository
  if (!isGitRepo(resolvedPath)) {
    throw new Error(`Target path is not a valid git repository: ${resolvedPath}`);
  }

  // 3. Ensure /.bureau-worktrees/ is in .gitignore
  ensureWorktreeIgnored(resolvedPath);

  // 4. Insert into bureau_projects
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    const row = db.get<BureauProjectRow>(`
      INSERT INTO bureau_projects (id, name, path_to_repo, description, github_url, provisioned_by, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `,
      id,
      name,
      resolvedPath,
      input.description?.trim() ?? null,
      input.github_url ?? null,
      input.provisioned_by ?? null,
      input.visibility ?? null,
      now,
      now
    );

    if (!row) {
      throw new Error('Failed to insert bureau_projects row');
    }

    journal(db, {
      kind: 'project-registered',
      attribution: input.attribution,
      detail: {
        projectId: row.id,
        name: row.name,
        pathToRepo: row.path_to_repo,
        description: row.description,
        githubUrl: row.github_url,
        provisionedBy: row.provisioned_by,
        visibility: row.visibility
      }
    });

    return row;
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint failed') || err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`Project with name '${name}' already exists`);
    }
    throw err;
  }
}

export function getProject(db: DbConnection, idOrName: string): BureauProjectRow | null {
  const row = db.get<BureauProjectRow>(
    'SELECT * FROM bureau_projects WHERE id = ? OR name = ?',
    idOrName,
    idOrName
  );
  return row ?? null;
}

export function listProjects(db: DbConnection): BureauProjectRow[] {
  return db.all<BureauProjectRow>(
    'SELECT * FROM bureau_projects ORDER BY created_at ASC'
  );
}

export function resolveProjectPath(db: DbConnection, projectId?: string | null): string {
  if (!projectId) {
    return getRepoRoot();
  }
  const project = getProject(db, projectId);
  if (!project) {
    return getRepoRoot();
  }
  return project.path_to_repo;
}
