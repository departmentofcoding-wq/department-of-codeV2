import { parseArgs } from 'node:util';
import fs from 'node:fs';
import type { AttributionTuple } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import {
  fileAgentTask,
  AgentFileError,
  AGENT_IDENTITIES,
  isAgentAutofileEnabled,
  setAgentAutofile
} from '../engine/filing/index.ts';
import { journal } from '../engine/journal/writer.ts';
import { planCycleJobId } from '../engine/jobs/ids.ts';

const USAGE = `Usage:
  npm run task:file -- --enable | --disable            # operator: toggle the agent-autofile opt-in
  npm run task:file -- --title T --intent I --verify V # flags mode
              [--spec S] [--acceptance A] [--project P]
              [--agent claude|glm] [--idempotency-key K]
  cat proposal.json | npm run task:file -- --json -    # stdin relay (GLM path)
JSON fields: title, intent, spec?, acceptance?, verifyCmd (or verify),
             projectId?, idempotencyKey?, agent? ("claude" | "glm")`;

const humanAttr: AttributionTuple = {
  actor_role: 'human-operator',
  provider: 'deterministic',
  model: 'core',
  account: 'operator'
};

interface RelayProposal {
  title?: string;
  intent?: string;
  spec?: string;
  acceptance?: string;
  verifyCmd?: string;
  verify?: string;
  projectId?: string;
  idempotencyKey?: string;
  agent?: string;
}

function resolveAgent(name: string | undefined): AttributionTuple {
  const key = (name ?? 'claude').trim().toLowerCase();
  const identity = AGENT_IDENTITIES[key as keyof typeof AGENT_IDENTITIES];
  if (!identity) {
    throw new Error(`Unknown agent '${String(name)}'. Known: ${Object.keys(AGENT_IDENTITIES).join(', ')}`);
  }
  return { ...identity };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      title: { type: 'string' },
      intent: { type: 'string' },
      spec: { type: 'string' },
      acceptance: { type: 'string' },
      verify: { type: 'string' },
      project: { type: 'string' },
      agent: { type: 'string' },
      'idempotency-key': { type: 'string' },
      json: { type: 'string' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' }
    },
    allowPositionals: false
  });

  const db = openDbConnection();

  try {
    // Operator door: toggle the fail-closed opt-in (journaled as a human act).
    if (values.enable || values.disable) {
      const on = Boolean(values.enable);
      setAgentAutofile(db, on);
      journal(db, {
        kind: 'human',
        attribution: humanAttr,
        detail: { action: on ? 'agent-autofile-enabled' : 'agent-autofile-disabled' }
      });
      console.log(`[task:file] Agent autofile is now ${on ? 'ENABLED' : 'DISABLED'}.`);
      db.close();
      return;
    }

    let proposal: RelayProposal;
    if (values.json === '-') {
      const raw = fs.readFileSync(0, 'utf8');
      try {
        proposal = JSON.parse(raw) as RelayProposal;
      } catch (err: any) {
        console.error(`[task:file] stdin is not valid JSON: ${err.message}`);
        db.close();
        process.exit(1);
      }
    } else {
      proposal = {
        title: values.title,
        intent: values.intent,
        spec: values.spec,
        acceptance: values.acceptance,
        verifyCmd: values.verify,
        projectId: values.project,
        idempotencyKey: values['idempotency-key'],
        agent: values.agent
      };
    }

    // An explicit --agent flag wins over the JSON body's "agent" field.
    const attribution = resolveAgent(values.agent ?? proposal.agent);
    const verifyCmd = proposal.verifyCmd ?? proposal.verify;

    if (!proposal.title || !proposal.intent || !verifyCmd) {
      console.error(`[task:file] Missing required fields (title, intent, verifyCmd).\n${USAGE}`);
      db.close();
      process.exit(1);
    }

    try {
      const task = fileAgentTask(db, {
        title: proposal.title,
        intent: proposal.intent,
        spec: proposal.spec ?? null,
        acceptance: proposal.acceptance ?? null,
        verifyCmd,
        projectId: proposal.projectId ?? null,
        idempotencyKey: proposal.idempotencyKey ?? null,
        attribution
      });

      console.log(`Task filed through the agent door:`);
      console.log(`  Task ID: ${task.id}`);
      console.log(`  Title: ${task.title}`);
      console.log(`  State: ${task.state}`);
      console.log(`  Filed by: ${attribution.actor_role}/${attribution.provider} (${attribution.model})`);
      console.log(`  Plan kickoff job: ${planCycleJobId(task.id)} (pending — drained by the runner)`);
      if (!isAgentAutofileEnabled(db)) {
        console.log(`  WARNING: autofile flag reads OFF after filing — unexpected state.`);
      }
    } catch (err: any) {
      if (err instanceof AgentFileError) {
        console.error(`[task:file] REFUSED (${err.code}): ${err.message}`);
      } else {
        console.error(`[task:file] Error: ${err.message}`);
      }
      db.close();
      process.exit(1);
    }
  } finally {
    try {
      db.close();
    } catch {}
  }
}

void main();
