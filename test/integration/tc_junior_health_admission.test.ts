import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealSqliteDb } from '../fixtures/db_factory.ts';
import type { DbConnection, BureauJobRow } from '../../engine/contract/types.ts';
import { reconcileQueuedTasks } from '../../engine/flow/reconcile.ts';
import {
  JUNIORS,
  ensureJuniorRunning,
  recoverJuniorRunning,
  isJuniorWedgedWindowError
} from '../../engine/harness/antigravity.ts';
import {
  isJuniorHealthy,
  setJuniorUnhealthy
} from '../../engine/flow/junior-health.ts';
import { DEFAULT_JUNIOR_COOLDOWN_MS } from '../../engine/contract/constants.ts';
import { setAntigravityDriverOverride, getAntigravityDriver } from '../../engine/harness/antigravity-seam.ts';
import { drainSingleJob } from '../../runner/main.ts';
import { defineJob } from '../../engine/jobs/registry.ts';
import { z } from 'zod';

function sendWsText(socket: net.Socket, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

interface TestServer {
  server: http.Server;
  port: number;
  mode: 'wedged' | 'healthy';
  close: () => Promise<void>;
}

function createTestCdpServer(initialMode: 'wedged' | 'healthy' = 'wedged', sockets: Set<net.Socket>): Promise<TestServer> {
  return new Promise((resolve) => {
    let mode = initialMode;
    let serverPort = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Browser: 'Antigravity/1.0.0',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/devtools/browser`
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.on('upgrade', (req, socket: net.Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));

      const key = req.headers['sec-websocket-key'];
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      if (mode === 'healthy') {
        socket.on('data', () => {
          // Echo Runtime.evaluate response: 1 + 1 === 2
          sendWsText(socket, JSON.stringify({ id: 1, result: { result: { value: 2 } } }));
        });
      }
      // In 'wedged' mode, socket connects but never responds to Runtime.evaluate
    });

    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as net.AddressInfo).port;
      resolve({
        server,
        port: serverPort,
        get mode() { return mode; },
        set mode(m) { mode = m; },
        close: () => new Promise<void>(res => server.close(() => res()))
      });
    });
  });
}

describe('Integration: Junior Health Gate Admission (Socket-Layer Wedged Endpoint & Cooldown)', () => {
  let db: DbConnection & { close: () => void };
  let tmpDir: string;
  let serverA: TestServer;
  let serverB: TestServer;
  let origPortA: number;
  let origPortB: number;
  const sockets = new Set<net.Socket>();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junior-health-adm-'));
    db = createRealSqliteDb(path.join(tmpDir, 'test.db'));

    origPortA = JUNIORS.A.cdpPort;
    origPortB = JUNIORS.B.cdpPort;
    setAntigravityDriverOverride(null);
    sockets.clear();

    serverA = await createTestCdpServer('wedged', sockets);
    serverB = await createTestCdpServer('healthy', sockets);

    JUNIORS.A.cdpPort = serverA.port;
    JUNIORS.B.cdpPort = serverB.port;
  });

  afterEach(async () => {
    setAntigravityDriverOverride(null);
    JUNIORS.A.cdpPort = origPortA;
    JUNIORS.B.cdpPort = origPortB;
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
    if (serverA) await serverA.close();
    if (serverB) await serverB.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertTask(id: string, state = 'queued', junior: string | null = null): void {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO bureau_tasks (id, title, state, priority, work_uuid, assigned_junior, plan_rounds, verify_fixes, cycles, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, 0, 0, 0, 0, ?, ?)`,
      id,
      `Task ${id}`,
      state,
      `work-${id}`,
      junior,
      now,
      now
    );
  }

  it('Socket-layer wedged test: port open + /json/version 200, but WebSocket Runtime.evaluate hangs -> task stays queued, no plan.cycle, junior_unhealthy_hold span emitted', async () => {
    serverA.mode = 'wedged';
    // Occupy junior B so candidate is specifically junior A (the wedged endpoint)
    insertTask('occupant-b', 'claimed', 'B');
    insertTask('task-wedged-1', 'queued');

    const admitted = await reconcileQueuedTasks(db, { probeTimeoutMs: 300 });

    // 1. Task was NOT admitted
    expect(admitted).toEqual([]);

    // 2. Task state remains queued and unassigned
    const task = db.get<{ state: string; assigned_junior: string | null }>(
      'SELECT state, assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-wedged-1'
    );
    expect(task?.state).toBe('queued');
    expect(task?.assigned_junior).toBeNull();

    // 3. No plan.cycle job created
    const job = db.get<BureauJobRow>(
      "SELECT * FROM bureau_jobs WHERE task_id = 'task-wedged-1' AND kind = 'plan.cycle'"
    );
    expect(job).toBeUndefined();

    // 4. Guardrail span junior_unhealthy_hold recorded in journal (selected by
    //    action — a queue_probe_roster_exhausted span also follows once the whole
    //    free roster has failed the probe, so don't assume it's the last row).
    const span = db.get<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-wedged-1' AND json_extract(detail,'$.action') = 'junior_unhealthy_hold' ORDER BY id DESC LIMIT 1"
    );
    expect(span).toBeTruthy();
    const detail = JSON.parse(span!.detail);
    expect(detail.action).toBe('junior_unhealthy_hold');
    expect(detail.junior).toBe('A');
    expect(detail.reason).toBe('probe_failed');

    // 4b. And the whole-roster-exhausted signal is surfaced loudly (the brick
    //     visibility — a systematically-wrong probe can no longer stall silently).
    const exhausted = db.get<{ detail: string }>(
      "SELECT detail FROM bureau_journal WHERE kind = 'guardrail' AND task_id = 'task-wedged-1' AND json_extract(detail,'$.action') = 'queue_probe_roster_exhausted' ORDER BY id DESC LIMIT 1"
    );
    expect(exhausted).toBeTruthy();

    // 5. Junior A is marked unhealthy with cooldown in bureau_meta
    expect(isJuniorHealthy(db, 'A')).toBe(false);
  });

  it('Healthy junior flow: WebSocket echoes Runtime.evaluate (1 + 1 === 2) -> task admitted, assigned, plan.cycle enqueued', async () => {
    serverA.mode = 'healthy';
    // Occupy junior B so candidate is specifically junior A (the healthy endpoint)
    insertTask('occupant-b', 'claimed', 'B');
    insertTask('task-healthy-1', 'queued');

    const admitted = await reconcileQueuedTasks(db);

    // 1. Task is admitted
    expect(admitted).toEqual(['task-healthy-1']);

    // 2. Task is assigned junior A
    const task = db.get<{ state: string; assigned_junior: string | null }>(
      'SELECT state, assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-healthy-1'
    );
    expect(task?.state).toBe('queued');
    expect(task?.assigned_junior).toBe('A');

    // 3. Pending plan.cycle job is enqueued
    const job = db.get<{ state: string; kind: string }>(
      "SELECT state, kind FROM bureau_jobs WHERE task_id = 'task-healthy-1' AND kind = 'plan.cycle'"
    );
    expect(job?.state).toBe('pending');
    expect(job?.kind).toBe('plan.cycle');
  });

  it('R2 Multi-junior fallthrough: Wedged Junior A does NOT dam the queue when Junior B is free and healthy -> task assigned to B', async () => {
    serverA.mode = 'wedged';
    serverB.mode = 'healthy';

    // Both A and B are free in capacity, but A is wedged
    insertTask('task-fallthrough-1', 'queued');

    const admitted = await reconcileQueuedTasks(db, { probeTimeoutMs: 300 });

    // Task falls through from wedged A to healthy B and is admitted!
    expect(admitted).toEqual(['task-fallthrough-1']);

    const task = db.get<{ state: string; assigned_junior: string | null }>(
      'SELECT state, assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-fallthrough-1'
    );
    expect(task?.state).toBe('queued');
    expect(task?.assigned_junior).toBe('B');

    // Junior A probe failure was flagged
    expect(isJuniorHealthy(db, 'A')).toBe(false);
    expect(isJuniorHealthy(db, 'B')).toBe(true);
  });

  it('Terminal wedged failure in runner marks cooldown in bureau_meta via drainSingleJob', async () => {
    insertTask('task-active-1', 'claimed', 'A');

    // Register a failing dispatch job that throws a wedged CDP timeout error
    defineJob(
      'junior.dispatch',
      z.any(),
      async () => {
        throw new Error('CDP timeout: Runtime.evaluate');
      },
      { maxAttempts: 1, timeoutMs: 5000 }
    );

    db.run(
      `INSERT INTO bureau_jobs (id, kind, task_id, payload, state, attempts, max_attempts, created_at)
       VALUES ('dispatch-term-1', 'junior.dispatch', 'task-active-1', '{"taskId":"task-active-1","junior":"A"}', 'pending', 0, 1, '2026-09-06T00:00:00.000Z')`
    );

    await drainSingleJob(db, 'dispatch-term-1');

    // Verify runner executed terminal failure path and marked Junior A in cooldown
    expect(isJuniorHealthy(db, 'A')).toBe(false);
  });

  it('R1 Production recovery clears cooldown flag in bureau_meta without manual opts.db passing', async () => {
    // 1. Mark junior A unhealthy in cooldown
    setJuniorUnhealthy(db, 'A', DEFAULT_JUNIOR_COOLDOWN_MS);
    expect(isJuniorHealthy(db, 'A')).toBe(false);

    // 2. recoverJuniorRunning called with db in recovery path clears the cooldown flag
    serverA.mode = 'healthy';
    const fakeDeps = {
      isPortLive: async () => true,
      killProcesses: async () => {},
      spawn: () => ({ unref: () => {} } as any),
      sleep: async () => {}
    };

    const res = await recoverJuniorRunning(JUNIORS.A, { db, deps: fakeDeps });
    expect(res.launched).toBe(true);

    // Flag is cleared in production flow
    expect(isJuniorHealthy(db, 'A')).toBe(true);

    // 3. Subsequent reconcile now admits task on Junior A
    insertTask('occupant-b', 'claimed', 'B');
    insertTask('task-recovered-prod', 'queued');
    const admitted = await reconcileQueuedTasks(db);
    expect(admitted).toEqual(['task-recovered-prod']);

    const task = db.get<{ assigned_junior: string | null }>(
      'SELECT assigned_junior FROM bureau_tasks WHERE id = ?',
      'task-recovered-prod'
    );
    expect(task?.assigned_junior).toBe('A');
  });
});
