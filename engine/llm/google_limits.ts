/**
 * Free-tier per-key rate limits for Google Gemini text-out models, transcribed
 * from the operator's AI Studio rate-limit page (the number after the slash in
 * each `peak-used / limit` cell). These are provider facts, versioned in code so
 * the selector can steer proactively without a DB migration.
 *
 * The flash-lite models (500 RPD / 15 RPM) are the department's workhorses; the
 * flash models are higher quality but scarce (20 RPD). Pro / 2.0 models read
 * 0/0 on this tier and are intentionally absent.
 */
export interface GoogleRateLimit {
  /** Requests per minute. */
  rpm: number;
  /** Input tokens per minute. */
  tpm: number;
  /** Requests per day (rolling 24h, the binding free-tier constraint). */
  rpd: number;
}

export const GOOGLE_MODEL_LIMITS: Record<string, GoogleRateLimit> = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3.5-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000, rpd: 20 },
  'gemini-3.6-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.7-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 }
};

/** Limits for an unknown Google model — conservative so we never over-drive it. */
export const GOOGLE_DEFAULT_LIMIT: GoogleRateLimit = { rpm: 5, tpm: 250_000, rpd: 20 };

export function googleLimitFor(modelId: string): GoogleRateLimit {
  return GOOGLE_MODEL_LIMITS[modelId] ?? GOOGLE_DEFAULT_LIMIT;
}
