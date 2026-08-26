import { parseArgs } from 'node:util';
import type { AttributionTuple, BureauJobRow } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { getProject, listProjects, registerProject, getRepoPrefix } from '../engine/projects/index.ts';
import { projectProvisionJobId } from '../engine/jobs/ids.ts';
import { enqueueJobIfAbsent } from '../engine/jobs/jobs.ts';
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
      name: { type: 'string', short: 'n' },
      path: { type: 'string', short: 'p' },
      description: { type: 'string', short: 'd' },
      public: { type: 'boolean' },
      actor: { type: 'string' }
    },
    allowPositionals: true
  });

  const command = positionals[0] ?? 'list';
  const db = openDbConnection();

  try {
    if (command === 'create') {
      const name = values.name ?? positionals[1];
      const description = values.description;
      const visibility = values.public ? 'public' : 'private';
      const actorRole = (values.actor ?? 'human-operator') as any;

      if (!name) {
        console.error('Usage: npm run project create -- --name <name> [--description <desc>] [--public] [--actor <role>]');
        db.close();
        process.exit(1);
      }

      const prefix = getRepoPrefix(db);
      const canonicalName = name.startsWith(prefix) ? name : `${prefix}${name}`;
      const jobId = projectProvisionJobId(canonicalName);

      enqueueJobIfAbsent(db, {
        id: jobId,
        kind: 'project.provision',
        payload: {
          name,
          description,
          visibility,
          attribution: {
            ...humanAttr,
            actor_role: actorRole
          }
        },
        max_attempts: 3
      });

      console.log(`[project-create] Enqueued job ${jobId} — draining...`);
      await drainSingleJob(db, jobId);

      const job = db.get<BureauJobRow>('SELECT * FROM bureau_jobs WHERE id = ?', jobId);
      if (job?.state === 'done') {
        const project = getProject(db, canonicalName);
        console.log(`\nProject provisioned successfully:`);
        console.log(`  ID: ${project?.id}`);
        console.log(`  Name: ${project?.name}`);
        console.log(`  Path: ${project?.path_to_repo}`);
        console.log(`  GitHub: ${project?.github_url ?? '<none>'}`);
        console.log(`  Visibility: ${project?.visibility ?? 'private'}`);
        console.log(`  Provisioned By: ${project?.provisioned_by ?? actorRole}`);
        if (project?.description) {
          console.log(`  Description: ${project.description}`);
        }
      } else {
        console.error(`\nProvisioning job failed: ${job?.last_error ?? 'Job state: ' + job?.state}`);
        db.close();
        process.exit(1);
      }
    } else if (command === 'register') {
      const name = values.name ?? positionals[1];
      const pathToRepo = values.path ?? positionals[2];
      const description = values.description;

      if (!name || !pathToRepo) {
        console.error('Usage: npm run project register -- --name <name> --path <path> [--description <desc>]');
        db.close();
        process.exit(1);
      }

      const project = registerProject(db, {
        name,
        pathToRepo,
        description,
        attribution: humanAttr
      });

      console.log(`\nProject registered successfully:`);
      console.log(`  ID: ${project.id}`);
      console.log(`  Name: ${project.name}`);
      console.log(`  Path: ${project.path_to_repo}`);
      if (project.description) {
        console.log(`  Description: ${project.description}`);
      }
      console.log(`  Created: ${project.created_at}`);
    } else if (command === 'list') {
      const projects = listProjects(db);
      console.log(`\n--- REGISTERED PROJECTS (${projects.length}) ---`);
      if (projects.length === 0) {
        console.log('No registered projects found. Defaulting to bureau root.');
      } else {
        for (const p of projects) {
          console.log(`- [${p.name}] (ID: ${p.id})`);
          console.log(`    Path: ${p.path_to_repo}`);
          if (p.github_url) {
            console.log(`    GitHub: ${p.github_url}`);
          }
          if (p.description) {
            console.log(`    Description: ${p.description}`);
          }
          console.log(`    Registered: ${p.created_at}`);
        }
      }
    } else if (command === 'show') {
      const target = positionals[1] ?? values.name;
      if (!target) {
        console.error('Usage: npm run project show -- <idOrName>');
        db.close();
        process.exit(1);
      }

      const project = getProject(db, target);
      if (!project) {
        console.error(`Project '${target}' not found.`);
        db.close();
        process.exit(1);
      }

      console.log(`\n--- PROJECT DETAILS ---`);
      console.log(`ID: ${project.id}`);
      console.log(`Name: ${project.name}`);
      console.log(`Path: ${project.path_to_repo}`);
      console.log(`GitHub: ${project.github_url ?? '<none>'}`);
      console.log(`Visibility: ${project.visibility ?? '<none>'}`);
      console.log(`Provisioned By: ${project.provisioned_by ?? '<none>'}`);
      console.log(`Description: ${project.description ?? '<none>'}`);
      console.log(`Created At: ${project.created_at}`);
      console.log(`Updated At: ${project.updated_at}`);
    } else {
      console.error(`Unknown project subcommand '${command}'. Available: create, register, list, show`);
      db.close();
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    db.close();
    process.exit(1);
  }

  db.close();
}

void main();
