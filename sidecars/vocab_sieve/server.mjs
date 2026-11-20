import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  unlinkSync,
  statSync
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const homeDir = os.homedir();

// 1. Resolve decoupled lexicon directory
function resolveLexiconDir() {
  if (process.env.VOCAB_LEXICON_DIR && existsSync(process.env.VOCAB_LEXICON_DIR)) {
    return process.env.VOCAB_LEXICON_DIR;
  }
  const cfgPath = join(homeDir, '.gemini', 'config', 'vocab_lexicon_path.txt');
  if (existsSync(cfgPath)) {
    try {
      const custom = readFileSync(cfgPath, 'utf-8').trim();
      if (custom && existsSync(custom)) return custom;
    } catch (_) {}
  }
  const candidates = [
    join(__dirname, '..', '..', 'lexicon'),
    join(__dirname, 'lexicon')
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

const LEXICON_DIR = resolveLexiconDir();
const BACKUP_DIR = join(LEXICON_DIR, 'backup');
const AUDIO_CACHE_DIR = join(LEXICON_DIR, 'audio_cache');
const AUDIO_US_DIR = join(AUDIO_CACHE_DIR, 'us');
const AUDIO_UK_DIR = join(AUDIO_CACHE_DIR, 'uk');
const PROGRESS_FILE = join(LEXICON_DIR, 'user_progress.json');
const MANIFEST_FILE = join(LEXICON_DIR, 'manifest.json');
const HTML_PATH = join(__dirname, 'index.html');

if (!existsSync(LEXICON_DIR)) mkdirSync(LEXICON_DIR, { recursive: true });
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
if (!existsSync(AUDIO_US_DIR)) mkdirSync(AUDIO_US_DIR, { recursive: true });
if (!existsSync(AUDIO_UK_DIR)) mkdirSync(AUDIO_UK_DIR, { recursive: true });

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

// 2. Data helpers
function loadManifest() {
  let manifest = { version: '1.0.0', books: [] };
  if (existsSync(MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
    } catch (_) {}
  }
  if (!Array.isArray(manifest.books)) manifest.books = [];
  // Keep only entries whose JSON file actually exists in LEXICON_DIR
  manifest.books = manifest.books.filter(
    (b) => b && b.file && existsSync(join(LEXICON_DIR, basename(b.file)))
  );
  const knownFiles = new Set(manifest.books.map((b) => basename(b.file)));
  // Auto-discover any extra wordbook JSON placed in LEXICON_DIR
  try {
    for (const f of readdirSync(LEXICON_DIR).sort()) {
      if (
        !f.endsWith('.json') ||
        f === 'manifest.json' ||
        f === 'user_progress.json' ||
        f.endsWith('.tmp') ||
        knownFiles.has(f)
      ) {
        continue;
      }
      try {
        const parsed = JSON.parse(readFileSync(join(LEXICON_DIR, f), 'utf-8'));
        if (parsed && Array.isArray(parsed.words)) {
          manifest.books.push({
            id: parsed.id || f.replace(/\.json$/, ''),
            title: parsed.title || f.replace(/\.json$/, ''),
            shortTitle: parsed.shortTitle || parsed.id || f.replace(/\.json$/, ''),
            description: parsed.description || `${parsed.words.length} 词`,
            totalWords: parsed.words.length,
            unitCount: Array.isArray(parsed.units) ? parsed.units.length : 0,
            file: f
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return manifest;
}

const bookMemCache = new Map();

function loadBook(bookId) {
  const manifest = loadManifest();
  const defaultId = (manifest.books && manifest.books[0] && manifest.books[0].id) || 'sample';
  const cleanId = String(bookId || defaultId).replace(/[^a-zA-Z0-9_-]/g, '');
  const entry = (manifest.books || []).find((b) => b.id === cleanId);
  const fileName = entry ? basename(entry.file) : `${cleanId}.json`;
  const target = join(LEXICON_DIR, fileName);
  if (!existsSync(target)) {
    return null;
  }
  try {
    const mtimeMs = statSync(target).mtimeMs;
    const cached = bookMemCache.get(target);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.raw;
    }
    const raw = readFileSync(target, 'utf-8');
    bookMemCache.set(target, { mtimeMs, raw });
    return raw;
  } catch (_) {
    return readFileSync(target, 'utf-8');
  }
}

function loadProgress() {
  const manifest = loadManifest();
  const defaultBook = (manifest.books && manifest.books[0] && manifest.books[0].id) || 'sample';
  if (!existsSync(PROGRESS_FILE)) {
    return {
      version: 1,
      updatedAt: null,
      settings: {
        activeBook: defaultBook,
        activeStage: 'triage',
        activeUnit: 'ALL',
        density: 'compact',
        sieve2Direction: 'en2zh',
        listenIntervalSec: 2.0,
        listenRepeat: 1,
        listenVoice: 'Samantha',
        listenBlind: true,
        listenFlashOnMiss: true
      },
      words: {}
    };
  }
  try {
    const data = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
    if (!data.words) data.words = {};
    if (!data.settings) data.settings = {};
    return data;
  } catch (_) {
    return { version: 1, updatedAt: null, settings: {}, words: {} };
  }
}

function saveProgress(incoming) {
  const current = loadProgress();
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...(current.settings || {}), ...(incoming.settings || {}) },
    words: incoming.replaceWords
      ? (incoming.words || {})
      : { ...(current.words || {}), ...(incoming.words || {}) }
  };

  const str = JSON.stringify(next, null, 2);
  const tmp = `${PROGRESS_FILE}.tmp`;
  writeFileSync(tmp, str, 'utf-8');
  renameSync(tmp, PROGRESS_FILE);

  // Daily snapshot backup
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  try {
    writeFileSync(join(BACKUP_DIR, `${y}-${m}-${d}.json`), str, 'utf-8');
  } catch (_) {}

  return { status: 'ok', updatedAt: next.updatedAt, wordCount: Object.keys(next.words).length };
}

// 3. 4-tier Word Audio Engine: Memory LRU -> Disk Cache -> Oxford/Youdao MP3 -> macOS Enhanced Say
const ttsCache = new Map();
const MAX_TTS_CACHE = 160;

function setTtsCache(key, entry) {
  if (ttsCache.size >= MAX_TTS_CACHE) {
    const oldestKey = ttsCache.keys().next().value;
    ttsCache.delete(oldestKey);
  }
  ttsCache.set(key, entry);
}

function isValidMp3Buffer(buf) {
  if (!buf || buf.length <= 600) return false;
  const hasId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const hasMpegSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  return hasId3 || hasMpegSync;
}

async function fetchRemoteDictAudio(cleanText, accent) {
  const candidates = [];
  if (!/\s/.test(cleanText)) {
    const oxAcc = accent === 'uk' ? 'gb' : 'us';
    candidates.push(
      `https://ssl.gstatic.com/dictionary/static/sounds/oxford/${encodeURIComponent(cleanText.toLowerCase())}--_${oxAcc}_1.mp3`
    );
  }
  if (cleanText.length <= 40) {
    const ydType = accent === 'uk' ? '1' : '2';
    candidates.push(
      `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(cleanText)}&type=${ydType}`
    );
  }

  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(4000)
      });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (isValidMp3Buffer(buf)) return buf;
    } catch (_) {}
  }
  return null;
}

async function runMacSay(voiceName, safeRate, cleanText) {
  if (process.platform !== 'darwin') return null;
  const tmpWav = join(
    os.tmpdir(),
    `vocab_tts_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`
  );
  try {
    await execFileAsync(
      '/usr/bin/say',
      [
        '-v',
        voiceName,
        '-r',
        String(safeRate),
        '--file-format=WAVE',
        '--data-format=LEI16',
        '-o',
        tmpWav,
        cleanText
      ],
      { timeout: 8000 }
    );
    if (!existsSync(tmpWav)) return null;
    return readFileSync(tmpWav).toString('base64');
  } catch (_) {
    return null;
  } finally {
    try {
      if (existsSync(tmpWav)) unlinkSync(tmpWav);
    } catch (_) {}
  }
}

async function resolveWordAudio(text, voice = 'Samantha', rate = 175) {
  const cleanText = String(text || '').replace(/\([^)]*\)/g, '').trim().slice(0, 200);
  if (!cleanText) return { status: 'fallback' };

  const accent = voice === 'Daniel' || voice === 'uk' ? 'uk' : 'us';
  const safeRate = Math.max(110, Math.min(280, Number(rate) || 175));
  const wordKey = cleanText.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const cacheKey = `${accent}|${safeRate}|${wordKey || cleanText}`;

  // Tier 1: Memory LRU cache
  if (ttsCache.has(cacheKey)) {
    const val = ttsCache.get(cacheKey);
    ttsCache.delete(cacheKey);
    ttsCache.set(cacheKey, val);
    return { status: 'ok', audioBase64: val.audioBase64, mimeType: val.mimeType, source: 'mem' };
  }

  // Tier 2: Persistent local disk cache
  const dir = accent === 'uk' ? AUDIO_UK_DIR : AUDIO_US_DIR;
  const cacheFile = wordKey ? join(dir, `${wordKey}.mp3`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const stat = statSync(cacheFile);
      if (stat.size > 500) {
        const audioBase64 = readFileSync(cacheFile).toString('base64');
        setTtsCache(cacheKey, { audioBase64, mimeType: 'audio/mpeg' });
        return { status: 'ok', audioBase64, mimeType: 'audio/mpeg', source: 'disk' };
      }
    } catch (_) {}
  }

  // Tier 3: Fetch Oxford / Youdao human MP3 and persist to disk cache
  if (cleanText.length <= 40 && wordKey) {
    const mp3Buf = await fetchRemoteDictAudio(cleanText, accent);
    if (mp3Buf) {
      if (cacheFile) {
        const tmpMp3 = `${cacheFile}.tmp_${process.pid}_${Date.now()}`;
        try {
          writeFileSync(tmpMp3, mp3Buf);
          renameSync(tmpMp3, cacheFile);
        } catch (_) {
          try { if (existsSync(tmpMp3)) unlinkSync(tmpMp3); } catch (_) {}
        }
      }
      const audioBase64 = mp3Buf.toString('base64');
      setTtsCache(cacheKey, { audioBase64, mimeType: 'audio/mpeg' });
      return { status: 'ok', audioBase64, mimeType: 'audio/mpeg', source: 'dict' };
    }
  }

  // Tier 4: macOS Enhanced speech fallback (non-macOS falls back to browser Web Speech API)
  const fallbackVoices =
    accent === 'uk' ? ['Daniel', 'Samantha'] : ['Evan (Enhanced)', 'Samantha'];
  for (const vName of fallbackVoices) {
    const b64 = await runMacSay(vName, safeRate, cleanText);
    if (b64) {
      setTtsCache(cacheKey, { audioBase64: b64, mimeType: 'audio/wav' });
      return { status: 'ok', audioBase64: b64, mimeType: 'audio/wav', source: 'say' };
    }
  }

  return { status: 'fallback' };
}

function buildHtml(token = '') {
  if (!existsSync(HTML_PATH)) {
    return '<h1>vocab_sieve index.html not found</h1>';
  }
  let html = readFileSync(HTML_PATH, 'utf-8');
  const manifest = loadManifest();
  const progress = loadProgress();
  const inject = `<script>
window.__INITIAL_MANIFEST__ = ${JSON.stringify(manifest).replace(/<\//g, '<\\/')};
window.__INITIAL_PROGRESS__ = ${JSON.stringify(progress).replace(/<\//g, '<\\/')};
window.__LEXICON_DIR__ = ${JSON.stringify(LEXICON_DIR)};
window.__SIDECAR_TOKEN__ = ${JSON.stringify(token)};
</script>\n</head>`;
  return html.replace('</head>', inject);
}

// 4. Dual-mode startup: Standalone HTTP (`--standalone`) or Antigravity Sidecar
const isStandalone = process.argv.includes('--standalone');

if (isStandalone) {
  const port = Number(process.env.VOCAB_SIEVE_PORT) || 3899;
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const pathname = urlObj.pathname;

    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE_HEADERS });
      res.end(buildHtml(''));
      return;
    }
    if (req.method === 'GET' && pathname === '/api/manifest') {
      sendJson(loadManifest());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/book') {
      const id = urlObj.searchParams.get('id') || '';
      const raw = loadBook(id);
      if (!raw) {
        sendJson({ status: 'not_found', id }, 404);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE_HEADERS });
      res.end(raw);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/progress') {
      sendJson(loadProgress());
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
      } catch (_) {}

      if (pathname === '/api/progress') {
        sendJson(saveProgress(body));
        return;
      }
      if (pathname === '/api/tts') {
        const result = await resolveWordAudio(body.text, body.voice, body.rate);
        sendJson(result);
        return;
      }
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[vocab_sieve] Standalone server running at http://127.0.0.1:${port}`);
    console.log(`[vocab_sieve] Lexicon dir: ${LEXICON_DIR}`);
  });
} else {
  let SidecarApp, Response;
  const sdkCandidates = [
    'sidecar_sdk',
    join(homeDir, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    '/Applications/Antigravity.app/Contents/Resources/app/node_modules/sidecar_sdk/index.mjs',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'resources', 'app', 'node_modules', 'sidecar_sdk', 'index.mjs')
      : ''
  ].filter(Boolean);

  for (const candidate of sdkCandidates) {
    try {
      const specifier = candidate === 'sidecar_sdk' ? candidate : pathToFileURL(candidate).href;
      const mod = await import(specifier);
      if (mod.SidecarApp && mod.Response) {
        SidecarApp = mod.SidecarApp;
        Response = mod.Response;
        break;
      }
    } catch (_) {}
  }

  if (!SidecarApp || !Response) {
    console.error('[vocab_sieve] 无法加载 sidecar_sdk，可使用 --standalone 启动独立服务器');
    process.exit(1);
  }

  const app = new SidecarApp();

  const serveIndex = () =>
    new Response(buildHtml(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || ''), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_CACHE_HEADERS
    });

  app.page('/', serveIndex);
  app.page('/index.html', serveIndex);

  app.api('/api/manifest', async () => loadManifest(), 'GET');

  app.api('/api/book', async (ctx) => {
    const id = (ctx && ctx.query && ctx.query.id) || (ctx && ctx.id) || '';
    const raw = loadBook(id);
    if (!raw) {
      return new Response(JSON.stringify({ status: 'not_found', id }), {
        status: 404,
        contentType: 'application/json; charset=utf-8'
      });
    }
    return new Response(raw, {
      contentType: 'application/json; charset=utf-8',
      headers: NO_CACHE_HEADERS
    });
  }, 'GET');

  app.api('/api/progress', async () => loadProgress(), 'GET');

  app.api('/api/progress', async (data) => {
    const body = data && data.body && (data.body.words || data.body.settings) ? data.body : (data || {});
    return saveProgress(body);
  }, 'POST');

  app.api('/api/tts', async (data) => {
    const body = data && data.body && data.body.text ? data.body : (data || {});
    return resolveWordAudio(body.text, body.voice, body.rate);
  }, 'POST');

  app.run();
}
