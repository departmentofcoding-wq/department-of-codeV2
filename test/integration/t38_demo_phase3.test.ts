import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T38: Phase 3 Exit Demo Integration Test (Milestone CX)', () => {
  it('executes scripts/demo_phase3.ts as a child process with exit code 0, clean journal output, and zero leaked browser processes', () => {
    const rootDir = path.resolve(process.cwd());

    const output = execFileSync('node', ['--experimental-strip-types', 'scripts/demo_phase3.ts'], {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 30000
    });

    expect(output).toContain('=== DEPARTMENT OF CODE V2 — PHASE 3 EXIT DEMO');
    expect(output).toContain('Phase 3 Exit Demo Content');
    expect(output).toContain('=== PHASE 3 EXIT DEMO COMPLETED SUCCESSFULLY ===');
    expect(output).toContain('Zero Guardrail Spans Check: PASS');

    // Extract demo profile dir from output
    const match = output.match(/\[CDP\] Profile Dir: (.*)/);
    expect(match).toBeDefined();
    if (match && match[1]) {
      const demoProfileDir = match[1].trim();
      // Assert demo temp profile directory was cleaned up from disk
      expect(fs.existsSync(demoProfileDir)).toBe(false);

      // Assert process tree running against demoProfileDir is gone
      let psOutput = '';
      try {
        if (process.platform === 'win32') {
          psOutput = execSync('wmic process where "name=\'chrome.exe\' or name=\'msedge.exe\'" get commandline', { encoding: 'utf8' });
        } else {
          psOutput = execSync('ps aux | grep -E "chrome|edge"', { encoding: 'utf8' });
        }
      } catch {
        psOutput = '';
      }
      expect(psOutput).not.toContain(demoProfileDir);
    }
  }, 30000);
});
