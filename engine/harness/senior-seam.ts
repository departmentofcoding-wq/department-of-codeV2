import { makeSeniorDriver, type SeniorDriver } from './senior.ts';

/**
 * Seam for driving the Senior reviewers, mirroring the department's other
 * override seams (antigravity-seam, llm-seam, pr-seam). The real implementation
 * drives the Claude CLI or the ZCode (GLM) GUI; tests inject a fake so the
 * review flow can be verified without a live senior.
 */
let override: SeniorDriver | null = null;

export function setSeniorDriverOverride(driver: SeniorDriver | null): void {
  override = driver;
}

/** Get the driver for a senior id ('claude' | 'zai'). Honors a test override. */
export function getSeniorDriver(id?: string): SeniorDriver {
  return override ?? makeSeniorDriver(id);
}
