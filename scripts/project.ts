import { parseArgs } from 'node:util';
import type { AttributionTuple } from '../engine/contract/index.ts';
import { openDbConnection } from '../engine/db/index.ts';
import { getProject, listProjects, registerProject } from '../engine/projects/index.ts';

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
      description: { type: 'string', short: 'd' }
    },
    allowPositionals: true
  });

  const command = positionals[0] ?? 'list';
  const db = openDbConnection();

  try {
    if (command === 'register') {
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
      console.log(`Description: ${project.description ?? '<none>'}`);
      console.log(`Created At: ${project.created_at}`);
      console.log(`Updated At: ${project.updated_at}`);
    } else {
      console.error(`Unknown project subcommand '${command}'. Available: register, list, show`);
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
