import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type child_process from 'node:child_process';
import { HarnessError } from '../../engine/harness/errors.ts';
import {
  isJuniorWedgedWindowError,
  JUNIORS,
  juniorProcessImageName,
  JUNIOR_PORT_WAIT_MS,
  killJuniorProcesses,
  MAIN_WINDOW_ATTACH_MS,
  recoverJuniorRunning,
  resolveJunior
} from '../../engine/harness/antigravity.ts';
import { runJuniorCommandWithWedgedRecovery } from '../../engine/harness/dispatch-job.ts';
import type { AntigravityDriver, AntigravityRunResult } from '../../engine/harness/antigravity-seam.ts';

/**
 * Cold-start budgets (the 2026-08-29 scar, task 3756ec6e): a healthy-but-slow
 * cold launch must outlive both waits — the port wait and the attach wait.
 * These pins exist so nobody quietly re-tightens them to the values that
 * stranded a real task.
 */
describe('cold-start budgets', () => {
  it('the port wait (JUNIOR_PORT_WAIT_MS) exceeds the observed >30s cold port-open under load', () => {
    expect(JUNIOR_PORT_WAIT_MS).toBeGreaterThanOrEqual(90000);
  });

  it('the attach wait (MAIN_WINDOW_ATTACH_MS) exceeds the observed 30-40s cold workbench render', () => {
    expect(MAIN_WINDOW_ATTACH_MS).toBeGreaterThanOrEqual(60000);
  });
});

/**
 * WS2 — recovering a downed/WEDGED junior. The real failure (dead job 8c6f373e)
 * was an instance whose CDP port answered but whose window never appeared:
 * `ensureJuniorRunning` no-ops on a live port, so `recoverJuniorRunning` always
 * kills + relaunches, and the dispatch retries once in flight. All tests use
 * fake killers/launchers/drivers — no real Antigravity is launched or killed.
 */

function fakeChild(): child_process.ChildProcess {
  return { unref: vi.fn() } as unknown as child_process.ChildProcess;
}

/** Temp "installed" binary + env override so findJuniorBinary resolves. */
function withFakeJuniorBinary<T>(envVar: string, fn: (bin: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jun-rec-'));
  const bin = path.join(tmp, 'Antigravity.exe');
  fs.writeFileSync(bin, '');
  const saved = process.env[envVar];
  process.env[envVar] = bin;
  return fn(bin).finally(() => {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

describe('WS2 — recoverJuniorRunning (forced clean relaunch)', () => {
  it('ALWAYS kills + relaunches even when the port is live — reuse is exactly wrong for a wedge', async () => {
    await withFakeJuniorBinary(JUNIORS.B.envPath, async bin => {
      const kill = vi.fn();
      const spawn = vi.fn(() => fakeChild());
      const res = await recoverJuniorRunning(JUNIORS.B, {
        deps: { isPortLive: async () => true, killProcesses: kill, spawn, sleep: async () => {} }
      });
      expect(res).toMatchObject({ launched: true, port: 9334 });
      expect(kill).toHaveBeenCalledTimes(1); // the wedge itself died
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(bin, ['--remote-debugging-port=9334']);
    });
  });

  it('kills and relaunches a fully-down instance too, polling until the port answers', async () => {
    await withFakeJuniorBinary(JUNIORS.A.envPath, async bin => {
      const kill = vi.fn();
      const spawn = vi.fn(() => fakeChild());
      let probes = 0;
      const res = await recoverJuniorRunning(JUNIORS.A, {
        deps: { isPortLive: async () => ++probes > 2, killProcesses: kill, spawn, sleep: async () => {} }
      });
      expect(res).toMatchObject({ launched: true, port: 9333 });
      expect(kill).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(bin, ['--remote-debugging-port=9333']);
    });
  });

  it('waits for the MAIN workbench window (not just the port) before returning, when a finder is injected', async () => {
    await withFakeJuniorBinary(JUNIORS.A.envPath, async () => {
      let windowProbes = 0;
      // Port answers immediately, but the freshly relaunched workbench only
      // becomes attachable on the 3rd probe — recovery must keep polling.
      const findWindow = vi.fn(async () => (++windowProbes >= 3 ? 'ws://127.0.0.1:9333/win' : ''));
      const res = await recoverJuniorRunning(JUNIORS.A, {
        deps: {
          isPortLive: async () => true,
          killProcesses: vi.fn(),
          spawn: () => fakeChild(),
          sleep: async () => {},
          findWindow
        }
      });
      expect(res).toMatchObject({ launched: true, port: 9333 });
      expect(windowProbes).toBe(3); // polled until the workbench was attachable
    });
  });

  it('returns after the window budget even if the workbench never renders (caller gets the last word)', async () => {
    await withFakeJuniorBinary(JUNIORS.A.envPath, async () => {
      const findWindow = vi.fn(async () => ''); // never attachable
      const res = await recoverJuniorRunning(JUNIORS.A, {
        windowTimeoutMs: 5, // tiny budget so the test doesn't wait
        deps: {
          isPortLive: async () => true,
          killProcesses: vi.fn(),
          spawn: () => fakeChild(),
          sleep: async () => {},
          findWindow
        }
      });
      expect(res).toMatchObject({ launched: true, port: 9333 });
      expect(findWindow).toHaveBeenCalled();
    });
  });

  it('skips the window wait entirely when no finder is injected (pure kill+relaunch+port-wait)', async () => {
    await withFakeJuniorBinary(JUNIORS.A.envPath, async () => {
      const res = await recoverJuniorRunning(JUNIORS.A, {
        deps: { isPortLive: async () => true, killProcesses: vi.fn(), spawn: () => fakeChild(), sleep: async () => {} }
      });
      expect(res).toMatchObject({ launched: true, port: 9333 });
    });
  });

  it('throws a clear error when even the forced relaunch never exposes CDP', async () => {
    await withFakeJuniorBinary(JUNIORS.B.envPath, async () => {
      await expect(
        recoverJuniorRunning(JUNIORS.B, {
          timeoutMs: 50,
          deps: { isPortLive: async () => false, killProcesses: vi.fn(), spawn: () => fakeChild(), sleep: async () => {} }
        })
      ).rejects.toThrow(/forced relaunch did not bring up a CDP endpoint on port 9334/);
    });
  });

  it('juniorProcessImageName derives the exe name (env override first)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jun-img-'));
    try {
      process.env[JUNIORS.A.envPath] = path.join(tmp, 'Antigravity IDE.exe');
      expect(juniorProcessImageName(JUNIORS.A)).toBe('Antigravity IDE.exe');
    } finally {
      delete process.env[JUNIORS.A.envPath];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('killJuniorProcesses never throws for an image that does not exist', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jun-kill-'));
    try {
      // Deliberately nonexistent image — never a real department app.
      process.env[JUNIORS.B.envPath] = path.join(tmp, 'NoSuchJuniorApp-71cc.exe');
      await expect(killJuniorProcesses(JUNIORS.B)).resolves.toBeUndefined();
    } finally {
      delete process.env[JUNIORS.B.envPath];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('WS2 — isJuniorWedgedWindowError (the wedge signature)', () => {
  it('matches the two real wedged-window failure messages', () => {
    expect(
      isJuniorWedgedWindowError(
        new HarnessError(
          "Antigravity IDE: opened a window on 'D:\\repo\\.bureau-worktrees\\abc123' but no CDP window titled " +
            "'abc123 - Antigravity IDE' appeared within timeout."
        )
      )
    ).toBe(true);
    expect(isJuniorWedgedWindowError(new Error('Antigravity 2.0 workbench window did not become available in time.'))).toBe(true);
  });

  it('F3: matches the port-dead + single-instance-lock wedge (the 2026-09-02 N9 scar)', () => {
    // ensureJuniorRunning, junior-labeled form (B) — the exact N9 message shape.
    expect(
      isJuniorWedgedWindowError(
        new HarnessError('Antigravity 2.0 launched but no CDP endpoint on port 9334 within timeout')
      )
    ).toBe(true);
    // Junior A's label form.
    expect(
      isJuniorWedgedWindowError(
        new HarnessError('Antigravity IDE launched but no CDP endpoint on port 9333 within timeout')
      )
    ).toBe(true);
    // The legacy ensureAntigravityRunning form (bare port callers).
    expect(
      isJuniorWedgedWindowError(new HarnessError('Antigravity launched but no CDP endpoint on port 9333 within timeout'))
    ).toBe(true);
  });

  it('F3: does NOT match a failed recovery or an absent install — no kill/spawn thrash', () => {
    // recoverJuniorRunning's own failure must not trigger another recovery.
    expect(
      isJuniorWedgedWindowError(
        new HarnessError(
          'Antigravity 2.0: forced relaunch did not bring up a CDP endpoint on port 9334 within 30s — ' +
            'the installation may be broken or the port blocked.'
        )
      )
    ).toBe(false);
    // A genuinely-absent binary keeps failing loud, never kills/relaunches.
    expect(
      isJuniorWedgedWindowError(
        new HarnessError('Antigravity 2.0 executable not found. Set ANTIGRAVITY_2_PATH to its binary.')
      )
    ).toBe(false);
  });

  it('does not match ordinary agent/calibration failures', () => {
    expect(isJuniorWedgedWindowError(new HarnessError("Chat input ('Message input') not found"))).toBe(false);
    expect(isJuniorWedgedWindowError(new HarnessError('Antigravity 2.0 junior did not complete: no progress for the stall window.'))).toBe(
      false
    );
    expect(isJuniorWedgedWindowError(new Error('LLM decision step failed'))).toBe(false);
  });
});

describe('WS2 — runJuniorCommandWithWedgedRecovery (dispatch heals in flight)', () => {
  const ok: AntigravityRunResult = { transcript: 'done', launched: false, junior: 'A' };

  it('a wedged-window failure triggers ONE relaunch and the retry succeeds', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(
        new HarnessError(
          "Antigravity IDE: opened a window on 'D:/wt/task-9' but no CDP window titled 'task-9 - Antigravity IDE' appeared within timeout."
        )
      )
      .mockResolvedValueOnce(ok);
    const driver: AntigravityDriver = { runCommand };
    const recover = vi.fn();
    const res = await runJuniorCommandWithWedgedRecovery(driver, 'do the work', { junior: 'A' }, recover);
    expect(res).toBe(ok);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(resolveJunior('A'));
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('routes the recovery at the junior the dispatch selected', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('Antigravity 2.0 workbench window did not become available in time.'))
      .mockResolvedValueOnce({ ...ok, junior: 'B' });
    const recover = vi.fn();
    await runJuniorCommandWithWedgedRecovery({ runCommand }, 'prompt', { junior: 'B' }, recover);
    expect(recover).toHaveBeenCalledWith(resolveJunior('B'));
    expect(recover.mock.calls[0]![0].id).toBe('B');
  });

  it('a NON-wedged failure propagates with no relaunch at all', async () => {
    const runCommand = vi.fn().mockRejectedValue(new HarnessError("Chat input ('Message input') not found"));
    const recover = vi.fn();
    await expect(runJuniorCommandWithWedgedRecovery({ runCommand }, 'p', {}, recover)).rejects.toThrow(/Chat input/);
    expect(recover).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('a SECOND wedged failure propagates after exactly one recovery', async () => {
    const runCommand = vi.fn().mockRejectedValue(
      new Error('Antigravity 2.0 workbench window did not become available in time.')
    );
    const recover = vi.fn();
    await expect(runJuniorCommandWithWedgedRecovery({ runCommand }, 'p', { junior: 'B' }, recover)).rejects.toThrow(
      /workbench window did not become available/
    );
    expect(recover).toHaveBeenCalledTimes(1); // one in-flight heal, not a loop
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  // F3 (2026-09-02, N9 rekick): the port-dead + single-instance-lock wedge —
  // the junior's processes are alive but its CDP port is gone, so a plain
  // relaunch forwards to the dead instance and the port wait times out. Left
  // unclassified, this burned every dispatch attempt until a manual
  // `taskkill /IM Antigravity.exe /F` + relaunch-with-port; it must heal in
  // flight exactly like the window wedge (one recovery per attempt).
  it('F3: a port-wedge failure triggers the kill-all + relaunch recovery and the retry succeeds', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(
        new HarnessError('Antigravity 2.0 launched but no CDP endpoint on port 9334 within timeout')
      )
      .mockResolvedValueOnce({ ...ok, junior: 'B' });
    const recover = vi.fn();
    const res = await runJuniorCommandWithWedgedRecovery({ runCommand }, 'do the work', { junior: 'B' }, recover);
    expect(res.transcript).toBe('done');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(resolveJunior('B'));
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('F3: a port wedge that SURVIVES the recovery propagates after exactly one heal (no loop)', async () => {
    const runCommand = vi.fn().mockRejectedValue(
      new HarnessError('Antigravity IDE launched but no CDP endpoint on port 9333 within timeout')
    );
    const recover = vi.fn();
    await expect(runJuniorCommandWithWedgedRecovery({ runCommand }, 'p', { junior: 'A' }, recover)).rejects.toThrow(
      /no CDP endpoint on port 9333/
    );
    expect(recover).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
