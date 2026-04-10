#!/usr/bin/env node

// One-command startup: installs deps if needed, starts api-gateway + web dev server,
// opens browser to http://localhost:5173 (which redirects to /setup on first run).
//
// Usage:
//   node bin/start.js          # from repo root after tsc build
//   npx tsx bin/start.ts       # directly via tsx

import 'dotenv/config';
import { execSync, spawn } from 'child_process';
import { createServer } from 'net';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// -- Utilities

function log(msg: string) {
  process.stdout.write(`\x1b[36m[start]\x1b[0m ${msg}\n`);
}

function errorLog(msg: string) {
  process.stderr.write(`\x1b[31m[start]\x1b[0m ${msg}\n`);
}

function checkNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major! < 18) {
    errorLog(`Node.js >= 18 is required. You have ${process.versions.node}.`);
    process.exit(1);
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(); resolve(true); });
    srv.listen(port);
  });
}

async function requirePort(port: number): Promise<number> {
  if (await isPortAvailable(port)) return port;
  log(`Port ${port} in use — killing existing process...`);
  try {
    if (platform() === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`, { stdio: 'ignore', shell: 'cmd.exe' });
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
    // Wait briefly for port to free up
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // ignore — process may have already exited
  }
  if (await isPortAvailable(port)) return port;
  errorLog(`Port ${port} is still in use after kill attempt. Free it manually.`);
  process.exit(1);
}

function openBrowser(url: string) {
  const os = platform();
  try {
    if (os === 'win32') {
      execSync(`explorer "${url}"`, { stdio: 'ignore' });
    } else if (os === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch {
    log(`Could not open browser automatically. Visit ${url}`);
  }
}

// -- Main

async function main() {
  checkNodeVersion();

  log('Starting Agentic platform...');

  // Install dependencies if node_modules is missing
  if (!existsSync(join(ROOT, 'node_modules'))) {
    log('Installing dependencies (first run)...');
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  }

  const apiPort = await requirePort(3000);
  const webPort = await requirePort(5173);

  log(`API Gateway = http://localhost:${apiPort}`);

  // Start api-gateway
  const NODE_ENV = process.env['NODE_ENV'] ?? 'development';

  const apiProc = spawn(
    'node',
    ['packages/api-gateway/dist/main.js'],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  apiProc.stdout?.on('data', (d: Buffer) => process.stdout.write(`\x1b[34m[api]\x1b[0m ${d}`));
  apiProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`\x1b[34m[api]\x1b[0m ${d}`));

  // Start web dev server
  const webProc = spawn(
    'npx',
    ['vite', '--port', String(webPort), '--host'],
    {
      cwd: join(ROOT, 'packages', 'web'),
      env: {
        ...process.env,
        VITE_API_URL: `http://localhost:${apiPort}/api`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    },
  );

  webProc.stdout?.on('data', (d: Buffer) => process.stdout.write(`\x1b[32m[web]\x1b[0m ${d}`));
  webProc.stderr?.on('data', (d: Buffer) => process.stderr.write(`\x1b[32m[web]\x1b[0m ${d}`));

  // Open browser after short delay (let servers start)
  setTimeout(() => openBrowser(`http://localhost:${webPort}`), 2500);

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down...');
    apiProc.kill('SIGTERM');
    webProc.kill('SIGTERM');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  apiProc.on('exit', (code) => {
    if (code !== 0) { errorLog(`API Gateway exited with code ${code}`); }
  });

  webProc.on('exit', (code) => {
    if (code !== 0) { errorLog(`Web server exited with code ${code}`); }
  });
}

void main();
