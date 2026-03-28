#!/usr/bin/env node
// create-agentic-adapter CLI - scaffold a new adapter project
// Usage: npx create-agentic-adapter <adapter-name> [output-dir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generateScaffold } from './template.js';

function run(): void {
  const args = process.argv.slice(2);
  const name = args[0];

  if (!name) {
    console.error('Usage: create-agentic-adapter <adapter-name> [output-dir]');
    console.error('Example: create-agentic-adapter my-service');
    process.exit(1);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    console.error(`Error: adapter name '${name}' must match [a-z0-9-] (lowercase, numbers, hyphens only)`);
    process.exit(1);
  }

  const outputDir = args[1] ?? join(process.cwd(), name);

  console.log(`Creating adapter '${name}' in ${outputDir} ...`);

  const files = generateScaffold({ name, outputDir });

  for (const file of files) {
    const fullPath = join(outputDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  created ${file.path}`);
  }

  console.log('');
  console.log('Done! Next steps:');
  console.log(`  cd ${outputDir}`);
  console.log(`  npm install`);
  console.log(`  # Edit src/${name}-adapter.ts to implement your adapter logic`);
  console.log(`  npm test`);
}

run();