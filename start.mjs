#!/usr/bin/env node
/**
 * Cross-platform standalone launcher for Vocab Sieve.
 * Starts the HTTP server and opens a clean browser app window (unless --no-open or --check).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, 'sidecars', 'vocab_sieve', 'server.mjs');

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const isCheck = args.includes('--check');

function parsePort() {
  const idx = args.indexOf('--port');
  if (idx !== -1 && args[idx + 1]) {
    const p = Number(args[idx + 1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  const envPort = Number(process.env.VOCAB_SIEVE_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) return envPort;
  return isCheck ? 13899 : 3899;
}

const port = parsePort();
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/api/manifest`);
      if (resp.ok) {
        return await resp.json();
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not respond within ${timeoutMs}ms at ${baseUrl}`);
}

function tryDetachedSpawn(cmd, cmdArgs) {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, cmdArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function openAppWindow(url) {
  const plat = process.platform;
  if (plat === 'darwin') {
    const appCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
    for (const bin of appCandidates) {
      if (existsSync(bin) && (await tryDetachedSpawn(bin, [`--app=${url}`]))) {
        return;
      }
    }
    await tryDetachedSpawn('open', [url]);
    return;
  }

  if (plat === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localApp = process.env.LOCALAPPDATA || '';
    const winCandidates = [
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localApp ? join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
    ].filter(Boolean);

    for (const bin of winCandidates) {
      if (existsSync(bin) && (await tryDetachedSpawn(bin, [`--app=${url}`]))) {
        return;
      }
    }
    await tryDetachedSpawn('cmd', ['/c', 'start', '', url]);
    return;
  }

  // Linux / others
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    if (await tryDetachedSpawn(bin, [`--app=${url}`])) return;
  }
  await tryDetachedSpawn('xdg-open', [url]);
}

const childEnv = {
  ...process.env,
  VOCAB_SIEVE_PORT: String(port)
};

const child = spawn(process.execPath, [serverScript, '--standalone'], {
  env: childEnv,
  stdio: isCheck ? 'pipe' : 'inherit'
});

const shutdown = (code = 0) => {
  if (!child.killed) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(code);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

child.on('exit', (code) => {
  if (!isCheck) process.exit(code ?? 0);
});

try {
  const manifest = await waitForServer();
  const books = Array.isArray(manifest.books) ? manifest.books : [];
  if (isCheck) {
    console.log(`[check] Server OK at ${baseUrl}`);
    console.log(`[check] Active books (${books.length}): ${books.map((b) => b.id).join(', ') || '(none)'}`);
    shutdown(0);
  } else {
    console.log(`[vocab-sieve] Ready at ${baseUrl} (${books.length} book(s) loaded)`);
    if (!noOpen) {
      await openAppWindow(baseUrl);
    }
  }
} catch (err) {
  console.error('[vocab-sieve] Startup failed:', err.message);
  shutdown(1);
}
