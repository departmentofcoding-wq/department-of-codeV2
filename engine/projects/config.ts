import path from 'node:path';
import type { DbConnection } from '../contract/types.ts';
import { PROJECT_META_KEYS } from '../contract/constants.ts';

export interface ProjectConfig {
  projectsRoot: string;
  repoPrefix: string;
  githubOwner: string;
}

export const DEFAULT_REPO_PREFIX = 'dept-';
export const DEFAULT_GITHUB_OWNER = 'departmentofcoding-wq';
/** Operator-confirmed bureau default (2026-08-26): all provisioned projects
 * live under D:\projects. Overridable via the projects_root meta key or
 * BUREAU_PROJECTS_ROOT env; tests always set the meta to a temp dir. */
export const DEFAULT_PROJECTS_ROOT = 'D:\\projects';

function getMetaValue(db: DbConnection, key: string, fallbackKey?: string): string | null {
  const row = db.get<{ value: string }>(
    'SELECT value FROM bureau_meta WHERE key = ?',
    key
  );
  if (row?.value !== undefined && row.value !== null) {
    return row.value;
  }
  if (fallbackKey) {
    const fallbackRow = db.get<{ value: string }>(
      'SELECT value FROM bureau_meta WHERE key = ?',
      fallbackKey
    );
    if (fallbackRow?.value !== undefined && fallbackRow.value !== null) {
      return fallbackRow.value;
    }
  }
  return null;
}

export function getProjectsRoot(db: DbConnection): string {
  const meta = getMetaValue(db, PROJECT_META_KEYS.PROJECTS_ROOT, 'projects:root');
  if (meta) return path.resolve(meta);
  return process.env.BUREAU_PROJECTS_ROOT
    ? path.resolve(process.env.BUREAU_PROJECTS_ROOT)
    : DEFAULT_PROJECTS_ROOT;
}

export function setProjectsRoot(db: DbConnection, rootDir: string): void {
  db.run(
    'INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    PROJECT_META_KEYS.PROJECTS_ROOT,
    rootDir
  );
}

export function getRepoPrefix(db: DbConnection): string {
  const meta = getMetaValue(db, PROJECT_META_KEYS.REPO_PREFIX, 'projects:repo_prefix');
  return meta !== null ? meta : DEFAULT_REPO_PREFIX;
}

export function setRepoPrefix(db: DbConnection, prefix: string): void {
  db.run(
    'INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    PROJECT_META_KEYS.REPO_PREFIX,
    prefix
  );
}

export function getGithubOwner(db: DbConnection): string {
  const meta = getMetaValue(db, PROJECT_META_KEYS.GITHUB_OWNER, 'projects:github_owner');
  if (meta !== null) return meta;
  return process.env.GITHUB_OWNER || DEFAULT_GITHUB_OWNER;
}

export function setGithubOwner(db: DbConnection, owner: string): void {
  db.run(
    'INSERT INTO bureau_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    PROJECT_META_KEYS.GITHUB_OWNER,
    owner
  );
}

export function getProjectConfig(db: DbConnection): ProjectConfig {
  return {
    projectsRoot: getProjectsRoot(db),
    repoPrefix: getRepoPrefix(db),
    githubOwner: getGithubOwner(db)
  };
}

export function setProjectConfig(db: DbConnection, config: Partial<ProjectConfig>): void {
  if (config.projectsRoot !== undefined) {
    setProjectsRoot(db, config.projectsRoot);
  }
  if (config.repoPrefix !== undefined) {
    setRepoPrefix(db, config.repoPrefix);
  }
  if (config.githubOwner !== undefined) {
    setGithubOwner(db, config.githubOwner);
  }
}
