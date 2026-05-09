#!/usr/bin/env node
/**
 * Build the `@syntropize/rounds` npm package.
 *
 * Produces a self-contained distribution in packages/cli/ containing:
 *
 *   dist/server.mjs   — esbuild-bundled api-gateway + all @agentic-obs/*
 *                       workspace source. External deps (native modules,
 *                       heavy runtime libs) remain as real npm dependencies
 *                       declared in packages/cli/package.json.
 *   web-dist/         — built React frontend (static files served by the
 *                       api-gateway at /).
 *
 * Afterwards `cd packages/cli && npm pack` produces the publishable tarball.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages', 'cli');

function log(msg) {
  process.stdout.write(`\x1b[36m[dist]\x1b[0m ${msg}\n`);
}

// -- 1. Build workspaces + web ---------------------------------------------

log('Building workspaces (tsc --build + vite build)...');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

// -- 2. Clean prior output -------------------------------------------------

const distDir = join(CLI, 'dist');
const webDistDir = join(CLI, 'web-dist');
rmSync(distDir, { recursive: true, force: true });
rmSync(webDistDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// -- 3. Bundle server ------------------------------------------------------

// Everything under @agentic-obs/* is workspace-local and gets bundled INTO
// server.mjs. External deps are the real npm packages that stay as runtime
// dependencies in packages/cli/package.json — keeping the bundle small and
// letting npm handle platform-specific native binaries (better-sqlite3).
//
// Keep this list in sync with packages/cli/package.json `dependencies` +
// `optionalDependencies`.
const externals = [
  // Native / platform-specific — MUST be external; has prebuilt binaries.
  'better-sqlite3',
  // Heavy runtime libs that are cheaper to leave as real npm deps.
  'express', 'cors', 'socket.io',
  'pino', 'pino-pretty',
  'bullmq', 'ioredis',
  'prom-client',
  'jsonwebtoken',
  // Optional auth providers loaded via dynamic import only when configured.
  'ldapjs', '@iarna/toml', '@node-saml/node-saml',
  // NOTE: drizzle-orm is intentionally bundled. Its top-level package index
  // cross-imports every SQL dialect driver (pg, mysql2, …) even when only
  // `drizzle-orm/better-sqlite3` is used at runtime. Leaving it external
  // makes Node resolve those peers at startup and crash with ERR_MODULE_NOT_FOUND.
  // esbuild treeshakes the unused dialects away when bundled.
];

log(`esbuild bundling → ${join('packages', 'cli', 'dist', 'server.mjs')}`);
await build({
  entryPoints: [join(ROOT, 'packages', 'api-gateway', 'dist', 'main.js')],
  outfile: join(distDir, 'server.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: externals,
  // ESM bundle that uses require() for some deps (pino, yaml) needs a
  // createRequire shim in the banner.
  banner: {
    js: [
      `import { createRequire as __createRequire } from 'node:module';`,
      `const require = __createRequire(import.meta.url);`,
    ].join('\n'),
  },
  // Keep the bundle readable for debug and don't minify — dist size
  // matters less than stack-trace legibility for a self-hosted tool.
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

// -- 4. Copy SQL schema files ------------------------------------------
//
// The data-layer's schema loaders read SQL relative to their own module URL.
// After esbuild, every bundled file collapses into server.mjs, so
// `import.meta.url` resolves to packages/cli/dist/server.mjs. The loaders
// then read `packages/cli/dist/*.sql`, so the files must live there.

const { copyFileSync } = await import('node:fs');
const schemaFiles = [
  join(ROOT, 'packages', 'data-layer', 'src', 'db', 'sqlite-schema.sql'),
  join(ROOT, 'packages', 'data-layer', 'src', 'repository', 'postgres', 'schema.sql'),
];
for (const file of schemaFiles) {
  copyFileSync(file, join(distDir, basename(file)));
}
log(`Copied ${schemaFiles.length} SQL schema files → packages/cli/dist/`);

// -- 4b. Copy demo fixtures -------------------------------------------
// The demo router resolves fixtures relative to its own module URL. After
// bundling that's packages/cli/dist/server.mjs; mirroring the source-tree
// `demo/fixtures/` here lets `loadFixture()` find them in either layout.
const demoFixturesSrc = join(ROOT, 'demo', 'fixtures');
if (existsSync(demoFixturesSrc)) {
  cpSync(demoFixturesSrc, join(distDir, 'demo', 'fixtures'), { recursive: true });
  log('Copied demo fixtures → packages/cli/dist/demo/fixtures/');
}

// -- 5. Copy web static bundle --------------------------------------------

const webSrc = join(ROOT, 'packages', 'web', 'dist');
if (!existsSync(webSrc)) {
  throw new Error(`web bundle missing: ${webSrc}. did 'npm run build' in packages/web succeed?`);
}
log(`Copying web bundle → packages/cli/web-dist/`);
cpSync(webSrc, webDistDir, { recursive: true });

// -- 5. Write a minimal README for the published package ------------------

const readme = `# Rounds

AI does rounds on your production. Self-hosted AI SRE — investigate, dashboard, alert, remediate.

\`\`\`bash
npx @syntropize/rounds
# or
npm install -g @syntropize/rounds && rounds
\`\`\`

- Opens a browser to the setup wizard on first run
- Auto-generates persistent crypto secrets in \`~/.rounds/\`
- No configuration files required

For Kubernetes deployment, see the Helm chart:
\`helm install rounds oci://ghcr.io/syntropize/charts/rounds\`.

Rounds is a product of Syntropize. Source, docs, and issues: https://github.com/syntropize/rounds
`;
const { writeFileSync } = await import('node:fs');
writeFileSync(join(CLI, 'README.md'), readme);

log('Done.');
log('  Tarball:  cd packages/cli && npm pack');
log('  Publish:  cd packages/cli && npm publish');
