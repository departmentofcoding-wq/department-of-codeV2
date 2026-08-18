import crypto from 'node:crypto';
import type { BureauJournalRow, BureauObservationRow } from './types.ts';

export function mintNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isCorrelated(
  span: Pick<BureauJournalRow, 'detail'> | { detail: string },
  observation: Pick<BureauObservationRow, 'nonce'> | { nonce: string }
): boolean {
  if (!span || typeof span.detail !== 'string' || !observation || typeof observation.nonce !== 'string') {
    return false;
  }

  try {
    const parsed = JSON.parse(span.detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    return parsed.nonce === observation.nonce;
  } catch {
    return false;
  }
}

export function leaseIsExpired(
  lease: { expires_at: string },
  nowMs: number | string | Date
): boolean {
  if (!lease || !lease.expires_at) {
    return true;
  }

  const expiresMs = Date.parse(lease.expires_at);
  if (Number.isNaN(expiresMs)) {
    return true;
  }

  let currentMs: number;
  if (typeof nowMs === 'number') {
    currentMs = nowMs;
  } else if (typeof nowMs === 'string') {
    currentMs = Date.parse(nowMs);
  } else if (nowMs instanceof Date) {
    currentMs = nowMs.getTime();
  } else {
    return true;
  }

  if (Number.isNaN(currentMs)) {
    return true;
  }

  return currentMs >= expiresMs;
}
