import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AttributionTuple, DbConnection } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { fileTask, drainFilingNotifications } from '../engine/filing/file_task.ts';
import { confirmVerify, createSession, getOpenSessions, getSessionWithMessages, updateSessionDraft, appendIntakeMessage } from '../engine/intake/index.ts';
import { getProject, listProjects } from '../engine/projects/index.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { drainSingleJob } from '../runner/main.ts';

export const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

export interface IntakeSessionResolution {
  mode: 'explicit' | 'continue' | 'fresh';
  sessionId: string;
  isNew: boolean;
}

export function resolveIntakeSession(
  db: DbConnection,
  options: { session?: string; continue?: boolean },
  positionals: string[] = [],
  resolvedProjectId: string | null = null,
  attribution: AttributionTuple = humanAttr
): IntakeSessionResolution {
  let sessionId = options.session;

  if (!sessionId) {
    if (options.continue) {
      const openSessions = getOpenSessions(db);
      if (openSessions.length > 0) {
        sessionId = openSessions[0].id;
        if (resolvedProjectId) {
          updateSessionDraft(db, sessionId, { projectId: resolvedProjectId });
        }
        if (positionals.length > 0) {
          const prompt = positionals.join(' ');
          appendIntakeMessage(db, sessionId, {
            role: 'human',
            content: prompt,
            attribution
          });
        }
        return { mode: 'continue', sessionId, isNew: false };
      }
    }

    const initialPrompt = positionals.length > 0 ? positionals.join(' ') : 'New intake task';
    const session = createSession(db, {
      title: initialPrompt,
      projectId: resolvedProjectId,
      attribution
    });
    sessionId = session.id;
    appendIntakeMessage(db, sessionId, {
      role: 'human',
      content: initialPrompt,
      attribution
    });
    return { mode: 'fresh', sessionId, isNew: true };
  } else {
    if (resolvedProjectId) {
      updateSessionDraft(db, sessionId, { projectId: resolvedProjectId });
    }
    if (positionals.length > 0) {
      const prompt = positionals.join(' ');
      appendIntakeMessage(db, sessionId, {
        role: 'human',
        content: prompt,
        attribution
      });
    }
    return { mode: 'explicit', sessionId, isNew: false };
  }
}

export async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      answer: { type: 'string', short: 'a' },
      'confirm-verify': { type: 'boolean', short: 'c' },
      show: { type: 'boolean', short: 's' },
      session: { type: 'string' },
      continue: { type: 'boolean' },
      file: { type: 'boolean', short: 'f' },
      project: { type: 'string', short: 'p' }
    },
    allowPositionals: true
  });

  const db = openDbConnection();

  let resolvedProjectId: string | null = null;
  if (values.project) {
    const proj = getProject(db, values.project);
    if (!proj) {
      console.error(`Project '${values.project}' not found.`);
      db.close();
      process.exit(1);
    }
    resolvedProjectId = proj.id;
  }

  const { sessionId } = resolveIntakeSession(
    db,
    { session: values.session, continue: values.continue },
    positionals,
    resolvedProjectId,
    humanAttr
  );

  if (values.answer) {
    appendIntakeMessage(db, sessionId, {
      role: 'human',
      content: values.answer,
      attribution: humanAttr
    });
  }

  if (values['confirm-verify']) {
    try {
      confirmVerify(db, sessionId, humanAttr);
      console.log(`Verify command confirmed by human operator.`);
    } catch (err: any) {
      console.error(`Confirmation failed: ${err.message}`);
    }
  }

  if (values.file) {
    try {
      const task = fileTask(db, sessionId, humanAttr);
      console.log(`Task filed successfully: ID ${task.id}, state ${task.state}`);
      // Wait out the fire-and-forget filing push so its journal span is not
      // lost to the close below (short-lived CLI — see drainFilingNotifications).
      await drainFilingNotifications();
      db.close();
      return;
    } catch (err: any) {
      console.error(`Filing failed: ${err.message}`);
    }
  }

  // Enqueue intake.turn job and drain via runner engine
  const job = enqueueJob(db, {
    kind: 'intake.turn',
    payload: { sessionId }
  });

  await drainSingleJob(db, job.id);

  // The officer's file_task tool files synchronously inside the drained job —
  // its fire-and-forget push must be waited out before the close below, or
  // the span is lost (same race as the --file branch above).
  await drainFilingNotifications();

  if (values.show || true) {
    const details = getSessionWithMessages(db, sessionId);
    if (details) {
      let projectName = '<root>';
      if (details.session.project_id) {
        const proj = getProject(db, details.session.project_id);
        if (proj) {
          projectName = `${proj.name} (${proj.path_to_repo})`;
        }
      }
      console.log('\n--- SESSION DETAILS ---');
      console.log(`ID: ${details.session.id}`);
      console.log(`State: ${details.session.state}`);
      console.log(`Project: ${projectName}`);
      console.log(`Title: ${details.session.title ?? '<none>'}`);
      console.log(`Intent: ${details.session.intent ?? '<none>'}`);
      console.log(`Verify Command: ${details.session.verify_cmd ?? '<none>'}`);
      console.log(`Verify Confirmed: ${details.session.verify_confirmed_at ? `YES by ${details.session.verify_confirmed_by}` : 'NO'}`);
      console.log(`Model Calls: ${details.session.model_calls}`);

      const allProjects = listProjects(db);
      if (allProjects.length > 0 && !details.session.project_id) {
        console.log('\nAvailable Projects (use --project <name> to associate):');
        for (const p of allProjects) {
          console.log(`  - ${p.name} (${p.path_to_repo})`);
        }
      }

      console.log('\n--- MESSAGES ---');
      for (const m of details.messages) {
        console.log(`[${m.role.toUpperCase()}] ${m.content}`);
      }
    }
  }

  db.close();
}

if (typeof process !== 'undefined' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
