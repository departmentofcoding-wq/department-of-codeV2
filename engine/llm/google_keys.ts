/**
 * Multi-key Google API key handling.
 *
 * KEY HYGIENE (AGENTS.md law + T18): keys live in environment variables only.
 * The operator may set them via the Settings tab, which persists them to a
 * gitignored local secrets file and into the live process env — never the DB,
 * the journal, messages, or logs. Reads are masked; the raw key never leaves
 * this module except as the Authorization header inside GoogleClient.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEYS_ENV_VAR = 'GOOGLE_API_KEYS';
const LEGACY_ENV_VAR = 'GOOGLE_API_KEY';

/** Absolute path of the gitignored secrets file (overridable for tests). */
export function googleKeysFilePath(): string {
  return process.env.BUREAU_GOOGLE_KEYS_FILE || path.join(process.cwd(), 'secrets', 'google.env');
}

/** A Google API key is `AIza…` followed by URL-safe base64-ish chars. */
export function isValidGoogleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(key.trim());
}

/**
 * The active key list from the environment: GOOGLE_API_KEYS (comma-separated)
 * plus the legacy single GOOGLE_API_KEY, de-duplicated, order preserved.
 */
export function getGoogleKeys(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const k = raw.trim();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  for (const part of (process.env[KEYS_ENV_VAR] || '').split(',')) push(part);
  if (process.env[LEGACY_ENV_VAR]) push(process.env[LEGACY_ENV_VAR]!);
  return out;
}

export function hasGoogleKeys(): boolean {
  return getGoogleKeys().length > 0;
}

/** Mask a key for display: `AIza…last4`. Never returns the full value. */
export function maskGoogleKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return 'AIza…';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Masked status per configured key slot — safe to send to the browser. */
export function googleKeyStatus(): { count: number; masked: string[] } {
  const keys = getGoogleKeys();
  return { count: keys.length, masked: keys.map(maskGoogleKey) };
}

/**
 * Load keys from the gitignored secrets file into process.env at boot, unless
 * GOOGLE_API_KEYS is already set (an explicit env wins over the file).
 */
export function loadGoogleKeysFromDisk(filePath = googleKeysFilePath()): void {
  if (process.env[KEYS_ENV_VAR]) return;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // no file yet — nothing to load
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*GOOGLE_API_KEYS\s*=\s*(.*)\s*$/);
    if (m) {
      process.env[KEYS_ENV_VAR] = m[1].trim();
      return;
    }
  }
}

/**
 * Persist the operator-supplied keys: set the live process env AND write the
 * gitignored secrets file (0600). Validates every key; never logs values.
 * Returns the masked status. Throws on an invalid key.
 */
export function saveGoogleKeys(keys: string[], filePath = googleKeysFilePath()): { count: number; masked: string[] } {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const k = (raw ?? '').trim();
    if (!k) continue;
    if (!isValidGoogleKey(k)) {
      throw new Error('One or more keys are not valid Google API keys (expected an "AIza…" key).');
    }
    if (!seen.has(k)) {
      seen.add(k);
      cleaned.push(k);
    }
  }
  if (cleaned.length === 0) {
    throw new Error('Provide at least one Google API key.');
  }

  const joined = cleaned.join(',');
  process.env[KEYS_ENV_VAR] = joined;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `GOOGLE_API_KEYS=${joined}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort on platforms without POSIX perms (e.g. some Windows setups)
  }

  return { count: cleaned.length, masked: cleaned.map(maskGoogleKey) };
}
