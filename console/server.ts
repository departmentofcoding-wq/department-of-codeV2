import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import type { DbConnection, BureauTaskRow, BureauWatchdogFindingRow, BureauJournalRow } from '../engine/contract/types.ts';
import { redactOutput } from '../engine/contract/tools.ts';
import { journal } from '../engine/journal/writer.ts';
import { dashboardSnapshot } from '../engine/dashboards/views.ts';
import { timeline } from '../engine/journal/queries.ts';
import { approveTask } from '../engine/state/machine.ts';
import { enqueueJobIfAbsent } from '../engine/jobs/jobs.ts';
import {
  CONSOLE_BIND_HOST,
  CONSOLE_TOKEN_HEADER,
  CONSOLE_QUERY_TOKEN_PARAM,
  CONSOLE_DEFAULT_PORT,
  MAX_JSON_BODY_BYTES,
  type HealthDTO,
  type DashboardDTO,
  type TaskSummaryDTO,
  type FindingDTO,
  type JournalEntryDTO,
  type ApproveTaskRequest,
  type ApproveTaskResult,
  type TriggerActionRequest,
  type TriggerActionResult,
  type ApiErrorResponse
} from './contract.ts';

export interface ConsoleServerOptions {
  port?: number;
  host?: string;
  token: string;
  db: DbConnection;
  publicDir?: string;
}

export interface ConsoleServerHandle {
  server: http.Server;
  port: number;
  host: string;
  token: string;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const jsonStr = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(jsonStr),
    'Cache-Control': 'no-store'
  });
  res.end(jsonStr);
}

function sendError(res: http.ServerResponse, statusCode: number, code: string, message: string): void {
  const body: ApiErrorResponse = { error: message, code };
  sendJson(res, statusCode, body);
}

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytesRead = 0;

    req.on('data', (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > MAX_JSON_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStaticFile(reqPath: string, publicDir: string, res: http.ServerResponse): void {
  const normalizedPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  let relativePath = normalizedPath.startsWith('/') || normalizedPath.startsWith('\\') ? normalizedPath.slice(1) : normalizedPath;
  if (!relativePath || relativePath === '.') {
    relativePath = 'index.html';
  }

  const safePath = path.join(publicDir, relativePath);

  // Prevent path traversal outside publicDir
  if (!safePath.startsWith(path.resolve(publicDir))) {
    res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(safePath).pipe(res);
  });
}

export async function createConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServerHandle> {
  const host = options.host ?? CONSOLE_BIND_HOST;
  if (host !== CONSOLE_BIND_HOST && host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Security refusal: Console server must bind to loopback ${CONSOLE_BIND_HOST}, received ${host}`);
  }

  const publicDir = options.publicDir ?? path.join(process.cwd(), 'console', 'public');
  const token = options.token;
  const db = options.db;
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    // Remove Server header if default node header is attached
    res.removeHeader('Server');

    const reqUrl = new URL(req.url || '/', `http://${CONSOLE_BIND_HOST}`);
    const pathname = reqUrl.pathname || '/';

    // Static assets serving vs API
    if (!pathname.startsWith('/api/')) {
      serveStaticFile(pathname, publicDir, res);
      return;
    }

    // Auth verification for all /api/** endpoints
    const reqToken = (req.headers[CONSOLE_TOKEN_HEADER] as string) || reqUrl.searchParams.get(CONSOLE_QUERY_TOKEN_PARAM);
    if (!reqToken || reqToken !== token) {
      // Record guardrail journal span
      journal(db, {
        kind: 'guardrail',
        attribution: {
          actor_role: 'human-operator',
          provider: 'human',
          model: 'operator',
          account: 'unauthenticated'
        },
        detail: { action: 'console_auth_refusal', path: pathname, method: req.method }
      });

      sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid console authentication token');
      return;
    }

    try {
      // Endpoint routing
      if (req.method === 'GET' && pathname === '/api/health') {
        const data: HealthDTO = {
          ok: true,
          timestamp: new Date().toISOString(),
          uptime_ms: Date.now() - startTime
        };
        sendJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/dashboard') {
        const rawSnap = dashboardSnapshot(db);
        const redactedSnap: DashboardDTO = {
          statePopulations: rawSnap.statePopulations,
          budgetSpend: rawSnap.budgetSpend.map(b => ({ ...b, title: redactOutput(b.title) })),
          verifyFailureRate: rawSnap.verifyFailureRate,
          spanKindCounts: rawSnap.spanKindCounts,
          guardrailCount: rawSnap.guardrailCount
        };
        sendJson(res, 200, redactedSnap);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/tasks') {
        const tasks = db.all<BureauTaskRow>('SELECT * FROM bureau_tasks ORDER BY created_at DESC');
        const dtos: TaskSummaryDTO[] = tasks.map(t => ({
          id: t.id,
          title: redactOutput(t.title),
          state: t.state,
          verifier_exit_code: t.verifier_exit_code,
          approved_at: t.approved_at,
          approved_by: t.approved_by,
          merged_at: t.merged_at,
          merged_by: t.merged_by,
          priority: t.priority,
          work_uuid: t.work_uuid,
          work_title: t.work_title ? redactOutput(t.work_title) : null,
          plan_rounds: t.plan_rounds,
          verify_fixes: t.verify_fixes,
          cycles: t.cycles,
          attempts: t.attempts,
          recover_attempts: t.recover_attempts,
          pull_request_url: t.pull_request_url,
          created_at: t.created_at,
          updated_at: t.updated_at
        }));
        sendJson(res, 200, dtos);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/findings') {
        const findings = db.all<BureauWatchdogFindingRow>(
          "SELECT * FROM bureau_watchdog_findings WHERE status = 'active' ORDER BY detected_at DESC"
        );
        const dtos: FindingDTO[] = findings.map(f => ({
          id: f.id,
          task_id: f.task_id,
          subject_kind: f.subject_kind,
          subject_id: f.subject_id,
          finding_class: f.finding_class,
          status: f.status,
          recovery_job_id: f.recovery_job_id,
          detail: f.detail ? redactOutput(f.detail) : null,
          recover_attempts: f.recover_attempts,
          detected_at: f.detected_at,
          resolved_at: f.resolved_at
        }));
        sendJson(res, 200, dtos);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/journal') {
        const taskId = reqUrl.searchParams.get('taskId') ?? undefined;
        const kind = (reqUrl.searchParams.get('kind') ?? undefined) as any;
        const limitStr = reqUrl.searchParams.get('limit');
        const limit = limitStr ? parseInt(limitStr, 10) : undefined;

        const rows = timeline(db, { taskId, kind, limit });
        const dtos: JournalEntryDTO[] = rows.map(r => ({
          id: r.id,
          ts: r.ts,
          kind: r.kind,
          actor_role: r.actor_role,
          provider: r.provider,
          model: r.model,
          account: r.account,
          task_id: r.task_id,
          work_uuid: r.work_uuid,
          work_title: r.work_title ? redactOutput(r.work_title) : null,
          job_id: r.job_id,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          cost_usd: r.cost_usd,
          latency_ms: r.latency_ms,
          detail: redactOutput(r.detail)
        }));
        sendJson(res, 200, dtos);
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/approve')) {
        const parts = pathname.split('/');
        const taskId = parts[3];
        if (!taskId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing task ID in path');
          return;
        }

        let body: ApproveTaskRequest = {};
        try {
          body = (await parseJsonBody(req)) as ApproveTaskRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        const attribution = {
          actor_role: 'human-operator' as const,
          provider: 'human',
          model: 'operator',
          account: body.approvedBy || 'operator'
        };

        try {
          const updatedRow = approveTask(db, taskId, attribution);
          const result: ApproveTaskResult = {
            ok: true,
            task_id: updatedRow.id,
            state: updatedRow.state,
            approved_at: updatedRow.approved_at!,
            approved_by: updatedRow.approved_by!
          };
          sendJson(res, 200, result);
        } catch (err: any) {
          // Journal guardrail span on approval refusal
          journal(db, {
            kind: 'guardrail',
            attribution,
            taskId,
            detail: { action: 'approve_refused', reason: err.message }
          });
          sendError(res, 400, 'APPROVAL_REFUSED', err.message);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/actions/trigger') {
        let body: TriggerActionRequest;
        try {
          body = (await parseJsonBody(req)) as TriggerActionRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        if (!body.kind || (body.kind !== 'watchdog.sweep' && body.kind !== 'backup.push')) {
          const attribution = {
            actor_role: 'human-operator' as const,
            provider: 'human',
            model: 'operator',
            account: 'operator'
          };
          journal(db, {
            kind: 'guardrail',
            attribution,
            detail: { action: 'trigger_refused', reason: `Invalid action kind: ${body.kind}` }
          });
          sendError(res, 400, 'INVALID_ACTION_KIND', "Action kind must be 'watchdog.sweep' or 'backup.push'");
          return;
        }

        const jobId = body.target ? `console-${body.kind}-${body.target}` : `console-${body.kind}-latest`;
        const { job } = enqueueJobIfAbsent(db, {
          id: jobId,
          kind: body.kind,
          payload: { target: body.target ?? null, triggered_by: 'console' }
        });

        const attribution = {
          actor_role: 'human-operator' as const,
          provider: 'human',
          model: 'operator',
          account: 'operator'
        };
        journal(db, {
          kind: 'human',
          attribution,
          jobId: job.id,
          detail: { action: 'trigger_action', kind: body.kind, jobId: job.id }
        });

        const result: TriggerActionResult = {
          ok: true,
          job_id: job.id,
          kind: body.kind,
          state: job.state,
          created_at: job.created_at
        };
        sendJson(res, 200, result);
        return;
      }

      sendError(res, 404, 'NOT_FOUND', `Endpoint not found: ${req.method} ${pathname}`);
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error');
    }
  });

  const requestedPort = options.port ?? CONSOLE_DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(requestedPort, CONSOLE_BIND_HOST, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : requestedPort;

      resolve({
        server,
        port: actualPort,
        host: CONSOLE_BIND_HOST,
        token,
        close: () => {
          return new Promise<void>((resClose) => {
            server.close(() => resClose());
          });
        }
      });
    });
  });
}
