import { parseArgs } from 'node:util';
import type { AttributionTuple } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { fileTask } from '../filing/file_task.ts';
import { confirmVerify, createSession, getOpenSessions, getSessionWithMessages, updateSessionDraft, appendIntakeMessage } from '../engine/intake/index.ts';
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
      file: { type: 'boolean', short: 'f' }
    },
    allowPositionals: true
  });

  const db = openDbConnection();
  let sessionId = values.session;

  if (!sessionId) {
    const openSessions = getOpenSessions(db);
    if (openSessions.length > 0) {
      sessionId = openSessions[0].id;
    } else {
      const initialPrompt = positionals[0] ?? 'New intake task';
      const session = createSession(db, {
        title: initialPrompt,
        attribution: humanAttr
      });
      sessionId = session.id;
      appendIntakeMessage(db, sessionId, {
        role: 'human',
        content: initialPrompt,
        attribution: humanAttr
      });
    }
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
      console.log('\n--- SESSION DETAILS ---');
      console.log(`ID: ${details.session.id}`);
      console.log(`State: ${details.session.state}`);
      console.log(`Title: ${details.session.title ?? '<none>'}`);
      console.log(`Intent: ${details.session.intent ?? '<none>'}`);
      console.log(`Verify Command: ${details.session.verify_cmd ?? '<none>'}`);
      console.log(`Verify Confirmed: ${details.session.verify_confirmed_at ? `YES by ${details.session.verify_confirmed_by}` : 'NO'}`);
      console.log(`Model Calls: ${details.session.model_calls}`);
      console.log('\n--- MESSAGES ---');
      for (const m of details.messages) {
        console.log(`[${m.role.toUpperCase()}] ${m.content}`);
      }
    }
  }

  db.close();
}

void main();
