import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type child_process from 'node:child_process';
import { HarnessError } from '../../engine/harness/errors.ts';
import {
  DEFAULT_CLAUDE_SENIOR_MAX_MS,
  DEFAULT_CLAUDE_SENIOR_STALL_MS,
  ensureSeniorRunning,
  isSeniorConnectionError,
  killSeniorProcesses,
  resolveClaudeSeniorMaxMs,
  resolveClaudeSeniorStallMs,
  runSeniorWithRecovery,
  seniorProcessImageName,
  SENIORS
} from '../../engine/harness/senior.ts';
import { buildKillProcessCommand } from '../../engine/harness/process-control.ts';

/**
 * WS1/WS3 — senior self-healing, pure/wrappable parts. Every test injects
 * fakes for the port probe / killer / launcher, so nothing here launches or
 * kills a real GUI, and no network is touched.
 */

/** A fake ChildProcess good enough for the ensure/recover paths. */
function fakeChild(): child_process.ChildProcess {
  return { unref: vi.fn() } as unknown as child_process.ChildProcess;
}

/** Temp "installed" binary + ZCODE_PATH override so findSeniorBinary resolves. */
function withFakeZCodeBinary<T>(fn: (bin: string) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-rec-'));
  const bin = path.join(tmp, 'ZCode.exe');
  fs.writeFileSync(bin, '');
  const saved = process.env['ZCODE_PATH'];
  process.env['ZCODE_PATH'] = bin;
  return fn(bin).finally(() => {
    if (saved === undefined) delete process.env['ZCODE_PATH'];
    else process.env['ZCODE_PATH'] = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

describe('WS1 — ensureSeniorRunning (reuse a live endpoint, else relaunch)', () => {
  it('returns early (launched:false, NO kill, NO spawn) when the port is already live', async () => {
    const kill = vi.fn();
    const spawn = vi.fn();
    const res = await ensureSeniorRunning(SENIORS.zai, {
      deps: { isPortLive: async () => true, killProcesses: kill, spawn, sleep: async () => {} }
    });
    expect(res).toEqual({ launched: false, port: 9335 });
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('port dead: kills zombie processes (tray/single-instance scar), relaunches with the debug flag, polls until live', async () => {
    await withFakeZCodeBinary(async bin => {
      const kill = vi.fn();
      const spawn = vi.fn(() => fakeChild());
      // Dead for the first 3 probes, live afterwards — the relaunch "coming up".
      let probes = 0;
      const isPortLive = vi.fn(async () => ++probes > 3);
      const res = await ensureSeniorRunning(SENIORS.zai, {
        deps: { isPortLive, killProcesses: kill, spawn, sleep: async () => {} }
      });
      expect(res.launched).toBe(true);
      expect(res.port).toBe(9335);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(bin, ['--remote-debugging-port=9335']);
    });
  });

  it('throws a clear relaunch-instruction error when the endpoint never comes up', async () => {
    await withFakeZCodeBinary(async () => {
      const kill = vi.fn();
      const spawn = vi.fn(() => fakeChild());
      await expect(
        ensureSeniorRunning(SENIORS.zai, {
          timeoutMs: 50,
          deps: { isPortLive: async () => false, killProcesses: kill, spawn, sleep: async () => {} }
        })
      ).rejects.toThrow(/no CDP endpoint appeared on port 9335.*--remote-debugging-port=9335/s);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses non-CDP seniors (nothing to launch)', async () => {
    await expect(ensureSeniorRunning(SENIORS.claude, { deps: { sleep: async () => {} } })).rejects.toThrow(
      /not a CDP \(GUI\) senior/
    );
  });
});

describe('WS1 — isSeniorConnectionError (what is worth a relaunch+retry)', () => {
  it('classifies endpoint/socket deaths as connection errors', () => {
    expect(isSeniorConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:9335'))).toBe(true);
    expect(isSeniorConnectionError(new HarnessError('ZCode CDP WebSocket connection failed'))).toBe(true);
    expect(isSeniorConnectionError(new HarnessError('ZCode main window not found on port 9335'))).toBe(true);
    expect(isSeniorConnectionError(new HarnessError('CDP timeout: Runtime.evaluate'))).toBe(true);
    expect(isSeniorConnectionError(new TypeError('WebSocket is not open: readyState 3 (CLOSED)'))).toBe(true);
    expect(isSeniorConnectionError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does NOT classify capture/calibration/stall failures as connection errors (fail-closed stays)', () => {
    expect(
      isSeniorConnectionError(
        new HarnessError(
          "ZCode (zai) senior review was not captured: captured the senior app's empty home screen " +
            '(5 chrome markers, no VERDICT line) — the review was never submitted or never generated'
        )
      )
    ).toBe(false);
    expect(isSeniorConnectionError(new HarnessError('ZCode chat input not found (needs selector calibration)'))).toBe(false);
    expect(isSeniorConnectionError(new HarnessError('ZCode: could not start a fresh conversation (no New task control)'))).toBe(
      false
    );
    expect(
      isSeniorConnectionError(
        new HarnessError('ZCode (zai) senior did not complete: no progress for the stall window. Partial output was NOT recorded.')
      )
    ).toBe(false);
    expect(isSeniorConnectionError(new HarnessError("Model 'GLM-9' not offered in ZCode's picker"))).toBe(false);
  });
});

describe('WS1 — runSeniorWithRecovery (one mid-death relaunch, then fail)', () => {
  it('a mid-review connection death relaunches EXACTLY ONCE and the retry succeeds', async () => {
    await withFakeZCodeBinary(async () => {
      // Stateful port: live at first; the app dies during the first attempt.
      let live = true;
      const kill = vi.fn();
      const spawn = vi.fn(() => {
        live = true; // the relaunch brings the endpoint back up
        return fakeChild();
      });
      const ensure = vi.fn((cfg: typeof SENIORS.zai) =>
        ensureSeniorRunning(cfg, {
          deps: { isPortLive: async () => live, killProcesses: kill, spawn, sleep: async () => {} }
        })
      );
      let died = false;
      const op = vi.fn(async () => {
        if (!died) {
          died = true; // the app goes down mid-review ONCE (socket dies)
          live = false;
          throw new Error('connect ECONNREFUSED 127.0.0.1:9335');
        }
        return { verdict: 'approve' as const };
      });
      const res = await runSeniorWithRecovery(SENIORS.zai, op, { ensure });
      expect(res).toEqual({ verdict: 'approve' });
      expect(op).toHaveBeenCalledTimes(2); // first attempt + one retry
      expect(ensure).toHaveBeenCalledTimes(2); // initial ensure + the recovery relaunch
      expect(kill).toHaveBeenCalledTimes(1); // the relaunch killed the corpse — exactly once
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  it('a captured home screen is NOT retried (real capture problem, fail-closed)', async () => {
    const ensure = vi.fn();
    const op = vi.fn(async () => {
      throw new HarnessError(
        "ZCode (zai) senior review was not captured: captured the senior app's empty home screen. Refusing to record a phantom verdict."
      );
    });
    await expect(runSeniorWithRecovery(SENIORS.zai, op, { ensure })).rejects.toThrow(/was not captured/);
    expect(op).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledTimes(1); // the initial ensure only — no relaunch
  });

  it('a SECOND connection failure after the one retry propagates', async () => {
    const ensure = vi.fn();
    const op = vi.fn(async () => {
      throw new HarnessError('ZCode CDP WebSocket connection failed');
    });
    await expect(runSeniorWithRecovery(SENIORS.zai, op, { ensure })).rejects.toThrow(/WebSocket connection failed/);
    expect(op).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('non-connection failures (calibration miss) propagate without any relaunch', async () => {
    const ensure = vi.fn();
    const op = vi.fn(async () => {
      throw new HarnessError('ZCode chat input not found (needs selector calibration)');
    });
    await expect(runSeniorWithRecovery(SENIORS.zai, op, { ensure })).rejects.toThrow(/chat input not found/);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('WS1 — senior process image + kill command (pure)', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    delete process.env['ZCODE_PATH'];
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true
    });
  });

  it('seniorProcessImageName derives the exe name from the env-overridden binary', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-img-'));
    try {
      const bin = path.join(tmp, 'ZCode.exe');
      process.env['ZCODE_PATH'] = bin;
      expect(seniorProcessImageName(SENIORS.zai)).toBe('ZCode.exe');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('buildKillProcessCommand force-kills by image name and quotes names with spaces', () => {
    const cmd = buildKillProcessCommand('Antigravity IDE.exe');
    if (process.platform === 'win32') {
      expect(cmd).toBe('taskkill /IM "Antigravity IDE.exe" /F');
    } else {
      expect(cmd).toBe('pkill -x "Antigravity IDE.exe"');
    }
  });

  it('buildKillProcessCommand on POSIX platforms uses exact name matching (pkill -x)', () => {
    for (const plat of ['linux', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { value: plat, configurable: true });
      expect(buildKillProcessCommand('ZCode')).toBe('pkill -x "ZCode"');
      expect(buildKillProcessCommand('Antigravity IDE.exe')).toBe('pkill -x "Antigravity IDE.exe"');
    }
  });

  it('buildKillProcessCommand on Windows platform uses taskkill /IM "<image>" /F', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(buildKillProcessCommand('ZCode.exe')).toBe('taskkill /IM "ZCode.exe" /F');
    expect(buildKillProcessCommand('Antigravity IDE.exe')).toBe('taskkill /IM "Antigravity IDE.exe" /F');
  });

  it('killSeniorProcesses never throws, even for an image that does not exist', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sen-kill-'));
    try {
      // A deliberately nonexistent image: the kill must swallow "not found"
      // (and must never target a real app of the department).
      process.env['ZCODE_PATH'] = path.join(tmp, 'NoSuchSeniorApp-8f3a.exe');
      await expect(killSeniorProcesses(SENIORS.zai)).resolves.toBeUndefined();
    } finally {
      delete process.env['ZCODE_PATH'];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('WS3 — claude senior timing env (stall + cap, not an absolute kill)', () => {
  it('defaults: 5-minute stall window, 1-hour absolute cap', () => {
    expect(DEFAULT_CLAUDE_SENIOR_STALL_MS).toBe(300000);
    expect(DEFAULT_CLAUDE_SENIOR_MAX_MS).toBe(3600000);
    expect(resolveClaudeSeniorStallMs({})).toBe(300000);
    expect(resolveClaudeSeniorMaxMs({})).toBe(3600000);
  });

  it('CLAUDE_SENIOR_STALL_MS / CLAUDE_SENIOR_MAX_MS override their own knobs', () => {
    expect(resolveClaudeSeniorStallMs({ CLAUDE_SENIOR_STALL_MS: '45000' })).toBe(45000);
    expect(resolveClaudeSeniorMaxMs({ CLAUDE_SENIOR_MAX_MS: '7200000' })).toBe(7200000);
  });

  it('the legacy CLAUDE_SENIOR_TIMEOUT_MS still works as the cap source (back-compat)', () => {
    expect(resolveClaudeSeniorMaxMs({ CLAUDE_SENIOR_TIMEOUT_MS: '1200000' })).toBe(1200000);
    // An explicit MAX wins when both are set.
    expect(resolveClaudeSeniorMaxMs({ CLAUDE_SENIOR_TIMEOUT_MS: '1200000', CLAUDE_SENIOR_MAX_MS: '60000' })).toBe(60000);
  });

  it('garbage or non-positive values fall back to the defaults', () => {
    expect(resolveClaudeSeniorStallMs({ CLAUDE_SENIOR_STALL_MS: 'abc' })).toBe(300000);
    expect(resolveClaudeSeniorStallMs({ CLAUDE_SENIOR_STALL_MS: '0' })).toBe(300000);
    expect(resolveClaudeSeniorMaxMs({ CLAUDE_SENIOR_MAX_MS: '-5' })).toBe(3600000);
  });
});
