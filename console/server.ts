import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';
import crypto from 'node:crypto';
import type { DbConnection, BureauTaskRow, BureauWatchdogFindingRow, BureauJournalRow, BureauAssetRow } from '../engine/contract/types.ts';
import { redactOutput } from '../engine/contract/tools.ts';
import { journal } from '../engine/journal/writer.ts';
import { dashboardSnapshot, workerRoster } from '../engine/dashboards/views.ts';
import { timeline } from '../engine/journal/queries.ts';
import { approveTask } from '../engine/state/machine.ts';
import { enqueueJobIfAbsent, enqueueJob } from '../engine/jobs/jobs.ts';
import { taskGaps, isVacuousVerify } from '../engine/contract/validation.ts';
import { createSession, appendIntakeMessage, getSession, getSessionWithMessages } from '../engine/intake/index.ts';
import { confirmVerify } from '../engine/intake/confirm.ts';
import { fileTask } from '../engine/filing/file_task.ts';
import { saveGoogleKeys, googleKeyStatus } from '../engine/llm/google_keys.ts';
import { applyGoogleRoster } from '../engine/models/seed.ts';
import { drainSingleJob } from '../runner/main.ts';
import type { AttributionTuple, BureauJobRow, BureauIntakeMessageRow } from '../engine/contract/types.ts';
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
  type WorkerDTO,
  type AssetDTO,
  type CreateAssetRequest,
  type UpdateAssetRequest,
  type DeleteAssetResult,
  type ApproveTaskRequest,
  type ApproveTaskResult,
  type TriggerActionRequest,
  type TriggerActionResult,
  type ApiErrorResponse,
  type IntakeMessageDTO,
  type IntakeStateDTO,
  type StartIntakeRequest,
  type IntakeReplyRequest,
  type ConfirmFileResult,
  type GoogleKeyStatusDTO,
  type SaveGoogleKeysRequest,
  type NtfySettingsDTO,
  type SaveNtfySettingsRequest
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

/** Attribution for every operator-originated act on the console. */
const CONSOLE_HUMAN_ATTR: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'human',
  model: 'operator',
  account: 'operator'
};

/**
 * Flatten one intake message into a redacted, human-readable chat line.
 * Returns '' for messages the operator should not see (internal tool spans,
 * empty officer turns) so the frontend can skip them.
 */
function flattenIntakeMessage(msg: BureauIntakeMessageRow): string {
  if (msg.role === 'human') {
    // Human content is stored as a raw string (or JSON of an object).
    try {
      const raw = JSON.parse(msg.content);
      if (typeof raw === 'string') return redactOutput(raw);
      const text = raw?.text ?? raw?.content;
      return typeof text === 'string' ? redactOutput(text) : redactOutput(msg.content);
    } catch {
      return redactOutput(msg.content);
    }
  }
  if (msg.role === 'officer') {
    try {
      const raw = JSON.parse(msg.content);
      const parts: string[] = [];
      if (typeof raw?.text === 'string' && raw.text.trim()) parts.push(raw.text.trim());
      // The operator-facing question lives in the ask_human tool call arguments.
      for (const tc of raw?.toolCalls ?? []) {
        if (tc?.name === 'ask_human') {
          const q = tc.arguments?.question ?? tc.arguments?.text;
          if (typeof q === 'string' && q.trim()) parts.push(q.trim());
        }
      }
      return parts.length ? redactOutput(parts.join('\n')) : '';
    } catch {
      return '';
    }
  }
  // 'tool' and anything else: internal, not surfaced in the chat.
  return '';
}

/** Build the live intake snapshot + derived gates for a session. */
function buildIntakeState(db: DbConnection, sessionId: string): IntakeStateDTO | null {
  const res = getSessionWithMessages(db, sessionId);
  if (!res) return null;
  const { session, messages } = res;

  const dtoMessages: IntakeMessageDTO[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    display: flattenIntakeMessage(m),
    created_at: m.created_at
  }));

  const gaps = taskGaps(session);

  // Latest officer line awaiting the operator.
  let latestQuestion: string | null = null;
  for (let i = dtoMessages.length - 1; i >= 0; i--) {
    if (dtoMessages[i].role === 'officer' && dtoMessages[i].display) {
      latestQuestion = dtoMessages[i].display;
      break;
    }
  }

  const hasRealVerify = Boolean(session.verify_cmd) && !isVacuousVerify(session.verify_cmd);
  const awaitingVerifyConfirmation =
    session.state === 'open' && hasRealVerify && !session.verify_confirmed_at;

  // can_file: every field the officer must draft is present, verify is
  // confirmable, and the session is still open. Confirmation itself is the
  // operator's click — so treat a pending confirm as fileable.
  const gapsIgnoringConfirm = gaps.filter((g) => g !== 'verify_confirmed');
  const canFile = session.state === 'open' && gapsIgnoringConfirm.length === 0 && hasRealVerify;

  const filedTask = session.state === 'filed'
    ? db.get<{ id: string }>('SELECT id FROM bureau_tasks WHERE intake_session_id = ?', sessionId)
    : null;

  return {
    session_id: session.id,
    state: session.state,
    title: session.title ? redactOutput(session.title) : null,
    intent: session.intent ? redactOutput(session.intent) : null,
    spec: session.spec ? redactOutput(session.spec) : null,
    acceptance: session.acceptance ? redactOutput(session.acceptance) : null,
    verify_cmd: session.verify_cmd ? redactOutput(session.verify_cmd) : null,
    verify_confirmed_at: session.verify_confirmed_at,
    verify_confirmed_by: session.verify_confirmed_by,
    model_calls: session.model_calls,
    messages: dtoMessages,
    gaps,
    latest_question: latestQuestion,
    awaiting_verify_confirmation: awaitingVerifyConfirmation,
    can_file: canFile,
    task_id: filedTask?.id ?? null
  };
}

/**
 * Run a single intake officer turn synchronously and report whether it landed.
 * The console has no background runner loop, so the turn must be drained inline
 * (do NOT copy the enqueue-only trigger pattern). drainSingleJob swallows
 * handler failures into the job row, so we re-read it and surface non-'done'.
 */
async function runIntakeTurn(db: DbConnection, sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const job = enqueueJob(db, { kind: 'intake.turn', payload: { sessionId } });
  await drainSingleJob(db, job.id);
  const row = db.get<BureauJobRow>('SELECT state, last_error FROM bureau_jobs WHERE id = ?', job.id);
  if (!row || row.state !== 'done') {
    return { ok: false, error: row?.last_error || 'Intake officer turn did not complete' };
  }
  return { ok: true };
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

      if (req.method === 'GET' && pathname === '/api/workers') {
        const roster = workerRoster(db);
        const dtos: WorkerDTO[] = roster.map(w => ({
          role: w.role,
          backend: w.backend,
          model_id: w.model_id,
          provider: w.provider,
          display: w.display,
          active: w.active,
          active_leases: w.active_leases,
          running_dispatches: w.running_dispatches,
          last_activity_ts: w.last_activity_ts,
          last_activity_kind: w.last_activity_kind
        }));
        sendJson(res, 200, dtos);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/assets') {
        const rows = db.all<BureauAssetRow>('SELECT * FROM bureau_assets ORDER BY updated_at DESC');
        const dtos: AssetDTO[] = rows.map(r => ({
          id: r.id,
          name: redactOutput(r.name),
          category: redactOutput(r.category),
          url: redactOutput(r.url),
          description: r.description ? redactOutput(r.description) : null,
          owner: r.owner ? redactOutput(r.owner) : null,
          status: r.status,
          created_at: r.created_at,
          updated_at: r.updated_at
        }));
        sendJson(res, 200, dtos);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/assets') {
        let body: CreateAssetRequest;
        try {
          body = (await parseJsonBody(req)) as CreateAssetRequest;
        } catch {
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        const name = body.name?.trim();
        const url = body.url?.trim();
        if (!name || !url) {
          sendError(res, 400, 'VALIDATION_ERROR', "'name' and 'url' are required and cannot be blank");
          return;
        }

        const id = crypto.randomUUID();
        const category = body.category?.trim() || 'Other';
        const description = body.description?.trim() || null;
        const owner = body.owner?.trim() || null;
        const status = body.status === 'Inactive' ? 'Inactive' : 'Active';
        const nowIso = new Date().toISOString();

        db.run(
          `INSERT INTO bureau_assets (id, name, category, url, description, owner, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          name,
          category,
          url,
          description,
          owner,
          status,
          nowIso,
          nowIso
        );

        journal(db, {
          kind: 'human',
          attribution: {
            actor_role: 'human-operator',
            provider: 'human',
            model: 'operator',
            account: 'operator'
          },
          detail: { action: 'asset_create', id, name }
        });

        const dto: AssetDTO = {
          id,
          name: redactOutput(name),
          category: redactOutput(category),
          url: redactOutput(url),
          description: description ? redactOutput(description) : null,
          owner: owner ? redactOutput(owner) : null,
          status,
          created_at: nowIso,
          updated_at: nowIso
        };
        sendJson(res, 201, dto);
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/assets/') && pathname.endsWith('/update')) {
        const parts = pathname.split('/');
        const assetId = parts[3];
        if (!assetId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing asset ID in path');
          return;
        }

        const existing = db.get<BureauAssetRow>('SELECT * FROM bureau_assets WHERE id = ?', assetId);
        if (!existing) {
          sendError(res, 404, 'NOT_FOUND', `Asset '${assetId}' not found`);
          return;
        }

        let body: UpdateAssetRequest;
        try {
          body = (await parseJsonBody(req)) as UpdateAssetRequest;
        } catch {
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        if (body.name !== undefined && !body.name.trim()) {
          sendError(res, 400, 'VALIDATION_ERROR', "'name' cannot be blank");
          return;
        }
        if (body.url !== undefined && !body.url.trim()) {
          sendError(res, 400, 'VALIDATION_ERROR', "'url' cannot be blank");
          return;
        }

        const name = body.name !== undefined ? body.name.trim() : existing.name;
        const category = body.category !== undefined ? (body.category.trim() || 'Other') : existing.category;
        const url = body.url !== undefined ? body.url.trim() : existing.url;
        const description = body.description !== undefined ? (body.description.trim() || null) : existing.description;
        const owner = body.owner !== undefined ? (body.owner.trim() || null) : existing.owner;
        const status = body.status !== undefined ? (body.status === 'Inactive' ? 'Inactive' : 'Active') : existing.status;
        const nowIso = new Date().toISOString();

        db.run(
          `UPDATE bureau_assets
           SET name = ?, category = ?, url = ?, description = ?, owner = ?, status = ?, updated_at = ?
           WHERE id = ?`,
          name,
          category,
          url,
          description,
          owner,
          status,
          nowIso,
          assetId
        );

        journal(db, {
          kind: 'human',
          attribution: {
            actor_role: 'human-operator',
            provider: 'human',
            model: 'operator',
            account: 'operator'
          },
          detail: { action: 'asset_update', id: assetId }
        });

        const dto: AssetDTO = {
          id: assetId,
          name: redactOutput(name),
          category: redactOutput(category),
          url: redactOutput(url),
          description: description ? redactOutput(description) : null,
          owner: owner ? redactOutput(owner) : null,
          status,
          created_at: existing.created_at,
          updated_at: nowIso
        };
        sendJson(res, 200, dto);
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/api/assets/') && pathname.endsWith('/delete')) {
        const parts = pathname.split('/');
        const assetId = parts[3];
        if (!assetId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing asset ID in path');
          return;
        }

        const existing = db.get<BureauAssetRow>('SELECT * FROM bureau_assets WHERE id = ?', assetId);
        if (!existing) {
          sendError(res, 404, 'NOT_FOUND', `Asset '${assetId}' not found`);
          return;
        }

        db.run('DELETE FROM bureau_assets WHERE id = ?', assetId);

        journal(db, {
          kind: 'human',
          attribution: {
            actor_role: 'human-operator',
            provider: 'human',
            model: 'operator',
            account: 'operator'
          },
          detail: { action: 'asset_delete', id: assetId }
        });

        const result: DeleteAssetResult = {
          ok: true,
          id: assetId
        };
        sendJson(res, 200, result);
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

      // --- Conversational intake: start a session (officer's first turn) ---
      if (req.method === 'POST' && pathname === '/api/intake') {
        let body: StartIntakeRequest;
        try {
          body = (await parseJsonBody(req)) as StartIntakeRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          sendError(res, 400, 'BAD_REQUEST', 'Field "prompt" is required');
          return;
        }

        const attribution: AttributionTuple = { ...CONSOLE_HUMAN_ATTR, account: body.startedBy || 'operator' };
        const session = createSession(db, {
          title: (body.title && body.title.trim()) || prompt,
          attribution
        });
        appendIntakeMessage(db, session.id, { role: 'human', content: prompt, attribution });

        const turn = await runIntakeTurn(db, session.id);
        if (!turn.ok) {
          journal(db, {
            kind: 'guardrail',
            attribution,
            detail: { action: 'intake_turn_failed', sessionId: session.id, reason: turn.error }
          });
          sendError(res, 502, 'INTAKE_TURN_FAILED', turn.error);
          return;
        }

        const state = buildIntakeState(db, session.id);
        sendJson(res, 200, state);
        return;
      }

      // --- Conversational intake: reply to the officer's question ---
      if (req.method === 'POST' && pathname.startsWith('/api/intake/') && pathname.endsWith('/reply')) {
        const sessionId = pathname.split('/')[3];
        if (!sessionId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing session ID in path');
          return;
        }

        let body: IntakeReplyRequest;
        try {
          body = (await parseJsonBody(req)) as IntakeReplyRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) {
          sendError(res, 400, 'BAD_REQUEST', 'Field "message" is required');
          return;
        }

        const session = getSession(db, sessionId);
        if (!session) {
          sendError(res, 404, 'NOT_FOUND', `Intake session ${sessionId} not found`);
          return;
        }
        if (session.state !== 'open') {
          sendError(res, 409, 'SESSION_NOT_OPEN', `Cannot reply to session in state '${session.state}'`);
          return;
        }

        appendIntakeMessage(db, sessionId, { role: 'human', content: message, attribution: CONSOLE_HUMAN_ATTR });

        const turn = await runIntakeTurn(db, sessionId);
        if (!turn.ok) {
          journal(db, {
            kind: 'guardrail',
            attribution: CONSOLE_HUMAN_ATTR,
            detail: { action: 'intake_turn_failed', sessionId, reason: turn.error }
          });
          sendError(res, 502, 'INTAKE_TURN_FAILED', turn.error);
          return;
        }

        const state = buildIntakeState(db, sessionId);
        sendJson(res, 200, state);
        return;
      }

      // --- Conversational intake: confirm verify + file the task (human gate) ---
      if (req.method === 'POST' && pathname.startsWith('/api/intake/') && pathname.endsWith('/confirm-file')) {
        const sessionId = pathname.split('/')[3];
        if (!sessionId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing session ID in path');
          return;
        }

        // Drain any oversized/garbage body but ignore contents (no fields needed).
        try {
          await parseJsonBody(req);
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          // A malformed body is harmless here; proceed.
        }

        try {
          confirmVerify(db, sessionId, CONSOLE_HUMAN_ATTR);
          const task = fileTask(db, sessionId, CONSOLE_HUMAN_ATTR);
          const result: ConfirmFileResult = {
            ok: true,
            task_id: task.id,
            state: task.state,
            title: task.title ? redactOutput(task.title) : null,
            created_at: task.created_at
          };
          sendJson(res, 200, result);
        } catch (err: any) {
          journal(db, {
            kind: 'guardrail',
            attribution: CONSOLE_HUMAN_ATTR,
            detail: { action: 'intake_confirm_file_refused', sessionId, reason: err.message }
          });
          sendError(res, 400, 'FILE_REFUSED', err.message);
        }
        return;
      }

      // --- Conversational intake: poll session state ---
      if (req.method === 'GET' && pathname.startsWith('/api/intake/')) {
        const sessionId = pathname.split('/')[3];
        if (!sessionId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing session ID in path');
          return;
        }
        const state = buildIntakeState(db, sessionId);
        if (!state) {
          sendError(res, 404, 'NOT_FOUND', `Intake session ${sessionId} not found`);
          return;
        }
        sendJson(res, 200, state);
        return;
      }

      // --- Settings: masked status of configured Google keys ---
      if (req.method === 'GET' && pathname === '/api/settings/google-keys') {
        const status: GoogleKeyStatusDTO = googleKeyStatus();
        sendJson(res, 200, status);
        return;
      }

      // --- Settings: save Google keys (env + gitignored file, never the DB) ---
      if (req.method === 'POST' && pathname === '/api/settings/google-keys') {
        let body: SaveGoogleKeysRequest;
        try {
          body = (await parseJsonBody(req)) as SaveGoogleKeysRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        if (!Array.isArray(body.keys)) {
          sendError(res, 400, 'BAD_REQUEST', 'Field "keys" must be an array of API keys');
          return;
        }

        try {
          const status = saveGoogleKeys(body.keys);
          // Keys now available: enable the Google roster live (no restart).
          applyGoogleRoster(db, 1);
          // Journal COUNT ONLY — never any key material (T18 hygiene).
          journal(db, {
            kind: 'human',
            attribution: CONSOLE_HUMAN_ATTR,
            detail: { action: 'settings_keys_updated', provider: 'google', count: status.count }
          });
          sendJson(res, 200, status);
        } catch (err: any) {
          journal(db, {
            kind: 'guardrail',
            attribution: CONSOLE_HUMAN_ATTR,
            detail: { action: 'settings_keys_refused', provider: 'google', reason: err.message }
          });
          sendError(res, 400, 'INVALID_KEYS', err.message);
        }
        return;
      }

      // --- Settings: Ntfy notifications config ---
      if (req.method === 'GET' && pathname === '/api/settings/ntfy') {
        const serverUrlRow = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'ntfy_server_url');
        const topicRow = db.get<{ value: string }>('SELECT value FROM bureau_meta WHERE key = ?', 'ntfy_topic');
        const ntfy_server_url = serverUrlRow?.value ?? 'https://ntfy.sh';
        const ntfy_topic = topicRow?.value ?? '';
        const dto: NtfySettingsDTO = {
          ntfy_server_url,
          ntfy_topic,
          enabled: Boolean(ntfy_topic.trim())
        };
        sendJson(res, 200, dto);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/settings/ntfy') {
        let body: SaveNtfySettingsRequest;
        try {
          body = (await parseJsonBody(req)) as SaveNtfySettingsRequest;
        } catch (err: any) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'JSON payload exceeds 1MB cap');
            return;
          }
          sendError(res, 400, 'BAD_REQUEST', 'Invalid JSON body');
          return;
        }

        const serverUrl = body.ntfy_server_url !== undefined ? body.ntfy_server_url.trim() : 'https://ntfy.sh';
        const topic = body.ntfy_topic !== undefined ? body.ntfy_topic.trim() : '';

        if (serverUrl) {
          try {
            const parsed = new URL(serverUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              sendError(res, 400, 'INVALID_URL', 'Server URL must use http or https protocol');
              return;
            }
          } catch {
            sendError(res, 400, 'INVALID_URL', 'Invalid server URL format');
            return;
          }
        }

        db.execTransaction(() => {
          db.run(`
            INSERT INTO bureau_meta (key, value) VALUES ('ntfy_server_url', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `, serverUrl || 'https://ntfy.sh');
          db.run(`
            INSERT INTO bureau_meta (key, value) VALUES ('ntfy_topic', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `, topic);
        });

        journal(db, {
          kind: 'human',
          attribution: CONSOLE_HUMAN_ATTR,
          detail: { action: 'settings_ntfy_updated', serverUrl: serverUrl || 'https://ntfy.sh', topic: topic ? 'configured' : 'empty' }
        });

        const dto: NtfySettingsDTO = {
          ntfy_server_url: serverUrl || 'https://ntfy.sh',
          ntfy_topic: topic,
          enabled: Boolean(topic)
        };
        sendJson(res, 200, dto);
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
