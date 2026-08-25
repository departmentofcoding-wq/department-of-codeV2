import { parseArgs } from 'node:util';
import type { AttributionTuple } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { fileTask } from '../engine/filing/file_task.ts';
import { confirmVerify, createSession, getOpenSessions, getSessionWithMessages, updateSessionDraft, appendIntakeMessage } from '../engine/intake/index.ts';
import { getProject, listProjects } from '../engine/projects/index.ts';
import { enqueueJob } from '../engine/jobs/jobs.ts';
import { drainSingleJob } from '../runner/main.ts';

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      answer: { type: 'string', short: 'a' },
      'confirm-verify': { type: 'boolean', short: 'c' },
      show: { type: 'boolean', short: 's' },
      session: { type: 'string' },
      file: { type: 'boolean', short: 'f' },
      project: { type: 'string', short: 'p' }
    },
    allowPositionals: true
  });

  const db = openDbConnection();
  let sessionId = values.session;

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

  if (!sessionId) {
    const openSessions = getOpenSessions(db);
    if (openSessions.length > 0) {
      sessionId = openSessions[0].id;
      if (resolvedProjectId) {
        updateSessionDraft(db, sessionId, { projectId: resolvedProjectId });
      }
    } else {
      const initialPrompt = positionals[0] ?? 'New intake task';
      const session = createSession(db, {
        title: initialPrompt,
        projectId: resolvedProjectId,
        attribution: humanAttr
      });
      sessionId = session.id;
      appendIntakeMessage(db, sessionId, {
        role: 'human',
        content: initialPrompt,
        attribution: humanAttr
      });
    }
  } else if (resolvedProjectId) {
    updateSessionDraft(db, sessionId, { projectId: resolvedProjectId });
  }

  if (positionals.length > 0 && !values.session && getOpenSessions(db).length > 0) {
    const prompt = positionals.join(' ');
    appendIntakeMessage(db, sessionId, {
      role: 'human',
      content: prompt,
      attribution: humanAttr
    });
  }

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

void main();
