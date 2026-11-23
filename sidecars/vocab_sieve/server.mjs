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
import { dirname, join, basename, resolve } from 'node:path';
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
    join(homeDir, 'Documents', '博士资料', 'PKM_Vault', 'English_Mastery', '02_Vocabulary_Bank', 'lexicon'),
    join(homeDir, 'Documents', 'English_Mastery', '02_Vocabulary_Bank', 'lexicon'),
    join(__dirname, 'lexicon')
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'user_progress.json'))) return c;
  }
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
const STATS_FILE = join(LEXICON_DIR, 'study_stats.json');
const STORIES_FILE = join(LEXICON_DIR, 'stories.json');
const MANIFEST_FILE = join(LEXICON_DIR, 'manifest.json');
const HTML_PATH = join(__dirname, 'index.html');
const STATS_HTML_PATH = join(__dirname, 'stats.html');
const CUTOFF_HOUR = 4;

if (!existsSync(LEXICON_DIR)) mkdirSync(LEXICON_DIR, { recursive: true });
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
if (!existsSync(AUDIO_US_DIR)) mkdirSync(AUDIO_US_DIR, { recursive: true });
if (!existsSync(AUDIO_UK_DIR)) mkdirSync(AUDIO_UK_DIR, { recursive: true });

// Optional wordbook discovery directories (prioritize active lexicon/, then wordbooks/)
const BOOK_DIRS = Array.from(
  new Set(
    [
      LEXICON_DIR,
      join(__dirname, '..', '..', 'wordbooks'),
      join(LEXICON_DIR, '..', 'wordbooks')
    ].map((d) => resolve(d))
  )
).filter((d) => existsSync(d));

function resolveBookFilePath(fileName) {
  const cleanName = basename(String(fileName || ''));
  if (!cleanName) return null;
  for (const dir of BOOK_DIRS) {
    const candidate = join(dir, cleanName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

// 2. Data helpers (lightweight manifest caching + single-book memory mount)
const metaMemCache = new Map(); // filePath -> { mtimeMs, meta }
const bookMemCache = new Map(); // holds at most 1 currently mounted book

function readBookMeta(filePath, fileName) {
  try {
    const mtimeMs = statSync(filePath).mtimeMs;
    const cached = metaMemCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.meta;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    let meta = null;
    if (parsed && Array.isArray(parsed.words)) {
      meta = {
        id: parsed.id || fileName.replace(/\.json$/, ''),
        title: parsed.title || fileName.replace(/\.json$/, ''),
        shortTitle: parsed.shortTitle || parsed.id || fileName.replace(/\.json$/, ''),
        description: parsed.description || `${parsed.words.length} 词`,
        totalWords: parsed.words.length,
        unitCount: Array.isArray(parsed.units) ? parsed.units.length : 0,
        file: fileName
      };
    }
    metaMemCache.set(filePath, { mtimeMs, meta });
    return meta;
  } catch (_) {
    return null;
  }
}

function loadManifest() {
  let manifest = { version: '1.0.0', books: [] };
  if (existsSync(MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf-8'));
    } catch (_) {}
  }
  if (!Array.isArray(manifest.books)) manifest.books = [];
  // Keep only entries whose JSON file actually exists in BOOK_DIRS
  manifest.books = manifest.books.filter(
    (b) => b && b.file && Boolean(resolveBookFilePath(basename(b.file)))
  );
  const knownFiles = new Set(manifest.books.map((b) => basename(b.file)));
  const knownIds = new Set(manifest.books.map((b) => b.id));

  // Auto-discover any extra wordbook JSON placed in BOOK_DIRS (cached by mtimeMs)
  for (const dir of BOOK_DIRS) {
    try {
      for (const f of readdirSync(dir).sort()) {
        if (
          !f.endsWith('.json') ||
          f === 'manifest.json' ||
          f === 'user_progress.json' ||
          f.endsWith('.tmp') ||
          knownFiles.has(f)
        ) {
          continue;
        }
        const meta = readBookMeta(join(dir, f), f);
        if (meta && !knownIds.has(meta.id)) {
          manifest.books.push({ ...meta });
          knownFiles.add(f);
          knownIds.add(meta.id);
        }
      }
    } catch (_) {}
  }

  // Prefer official/custom books ahead of demo sample when others exist
  if (manifest.books.some((b) => b.id !== 'sample')) {
    manifest.books = [
      ...manifest.books.filter((b) => b.id !== 'sample'),
      ...manifest.books.filter((b) => b.id === 'sample')
    ];
  }
  return manifest;
}

function loadBook(bookId) {
  const manifest = loadManifest();
  const defaultId = (manifest.books && manifest.books[0] && manifest.books[0].id) || 'sample';
  const cleanId = String(bookId || defaultId).replace(/[^a-zA-Z0-9_-]/g, '');
  const entry = (manifest.books || []).find((b) => b.id === cleanId);
  const fileName = entry ? basename(entry.file) : `${cleanId}.json`;
  const target = resolveBookFilePath(fileName);
  if (!target) {
    return null;
  }
  try {
    const mtimeMs = statSync(target).mtimeMs;
    const cached = bookMemCache.get(target);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.raw;
    }
    const raw = readFileSync(target, 'utf-8');
    // Mount only 1 book in backend memory at a time
    bookMemCache.clear();
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
        reviewDirection: 'en2zh',
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

const ACTION_KEYS = [
  'triage_known',
  'sieve2_mastered',
  'study_touch',
  'review_pass',
  'review_fail',
  'listen_pass',
  'listen_miss',
  'starred_add'
];

function createEmptyActions() {
  return {
    triage_known: 0,
    sieve2_mastered: 0,
    study_touch: 0,
    review_pass: 0,
    review_fail: 0,
    listen_pass: 0,
    listen_miss: 0,
    starred_add: 0
  };
}

function createEmptySnapshot() {
  return { known: 0, mastered: 0, learning: 0, starred: 0 };
}

function getLogicalDateStr(input = new Date(), cutoffHour = CUTOFF_HOUR) {
  if (!input) return null;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return null;
  const shifted = new Date(dt.getTime() - cutoffHour * 3600 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractBookIdFromWid(wid, fallbackBookId = '') {
  const parts = String(wid || '').split(':');
  return parts[0] || fallbackBookId || 'unknown';
}

function writeJsonAtomic(filePath, obj) {
  const str = JSON.stringify(obj, null, 2);
  const tmp = `${filePath}.tmp_${process.pid}_${Date.now()}`;
  writeFileSync(tmp, str, 'utf-8');
  renameSync(tmp, filePath);
  return str;
}

function computeSnapshotsFromWords(wordsObj) {
  const total = createEmptySnapshot();
  const byBook = {};
  for (const [wid, rec] of Object.entries(wordsObj || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const status = rec.status;
    const starred = Boolean(rec.starred);
    const hasStatus = status === 'known' || status === 'mastered' || status === 'learning';
    if (!hasStatus && !starred) continue;

    const bookId = extractBookIdFromWid(wid);
    if (!byBook[bookId]) byBook[bookId] = createEmptySnapshot();

    if (status === 'known') {
      total.known += 1;
      byBook[bookId].known += 1;
    } else if (status === 'mastered') {
      total.mastered += 1;
      byBook[bookId].mastered += 1;
    } else if (status === 'learning') {
      total.learning += 1;
      byBook[bookId].learning += 1;
    }
    if (starred) {
      total.starred += 1;
      byBook[bookId].starred += 1;
    }
  }
  return { total, byBook };
}

function computeWordActionDelta(prev, next, { allowUndoRevert = false } = {}) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const n = next && typeof next === 'object' ? next : {};
  const delta = createEmptyActions();

  const prevStatus = p.status || '';
  const nextStatus = n.status || '';
  const dReviewPass = (Number(n.review_pass_count) || 0) - (Number(p.review_pass_count) || 0);
  const dReviewFail = (Number(n.review_fail_count) || 0) - (Number(p.review_fail_count) || 0);
  const dListenPass = (Number(n.audio_pass_count) || 0) - (Number(p.audio_pass_count) || 0);
  const dListenMiss = (Number(n.audio_miss_count) || 0) - (Number(p.audio_miss_count) || 0);

  if (dReviewPass !== 0) delta.review_pass += allowUndoRevert ? dReviewPass : Math.max(0, dReviewPass);
  if (dReviewFail !== 0) delta.review_fail += allowUndoRevert ? dReviewFail : Math.max(0, dReviewFail);
  if (dListenPass !== 0) delta.listen_pass += allowUndoRevert ? dListenPass : Math.max(0, dListenPass);
  if (dListenMiss !== 0) delta.listen_miss += allowUndoRevert ? dListenMiss : Math.max(0, dListenMiss);

  const isUndoTransition =
    allowUndoRevert &&
    dReviewFail <= 0 &&
    (!n.updatedAt || (p.updatedAt && n.updatedAt < p.updatedAt));

  if (prevStatus !== 'known' && nextStatus === 'known') {
    delta.triage_known += 1;
  } else if (isUndoTransition && prevStatus === 'known' && nextStatus !== 'known') {
    delta.triage_known -= 1;
  }

  if (prevStatus !== 'mastered' && nextStatus === 'mastered') {
    delta.sieve2_mastered += 1;
  } else if (isUndoTransition && prevStatus === 'mastered' && nextStatus !== 'mastered') {
    delta.sieve2_mastered -= 1;
  }

  const prevHasMnemonic = Boolean((p.mnemonic || '').trim());
  const nextHasMnemonic = Boolean((n.mnemonic || '').trim());
  const enteredLearning = prevStatus !== 'learning' && nextStatus === 'learning' && dReviewFail <= 0;
  const addedMnemonic = !prevHasMnemonic && nextHasMnemonic;
  if (!isUndoTransition && (enteredLearning || addedMnemonic)) {
    delta.study_touch += 1;
  } else if (isUndoTransition && prevStatus === 'learning' && nextStatus !== 'learning') {
    delta.study_touch -= 1;
  }

  if (!p.starred && n.starred) {
    delta.starred_add += 1;
  } else if (isUndoTransition && p.starred && !n.starred) {
    delta.starred_add -= 1;
  }

  return delta;
}

function hasNonZeroAction(delta) {
  return ACTION_KEYS.some((k) => Number(delta[k]) !== 0);
}

function ensureDayBucket(stats, dateStr) {
  if (!stats.vocab.days[dateStr]) {
    stats.vocab.days[dateStr] = {
      actions: createEmptyActions(),
      snapshot: createEmptySnapshot(),
      byBook: {}
    };
  }
  const day = stats.vocab.days[dateStr];
  if (!day.actions) day.actions = createEmptyActions();
  if (!day.snapshot) day.snapshot = createEmptySnapshot();
  if (!day.byBook) day.byBook = {};
  return day;
}

function applyDeltaToActions(targetActions, delta) {
  for (const k of ACTION_KEYS) {
    if (delta[k]) {
      targetActions[k] = Math.max(0, (Number(targetActions[k]) || 0) + Number(delta[k]));
    }
  }
}

function createEmptyStatsDoc() {
  return {
    version: 1,
    cutoffHour: CUTOFF_HOUR,
    backfilledAt: null,
    updatedAt: null,
    vocab: { days: {} },
    dictation: {},
    recitation: {},
    listening: {}
  };
}

function backfillStudyStatsFromBackups() {
  const stats = createEmptyStatsDoc();
  const snapshots = [];

  if (existsSync(BACKUP_DIR)) {
    try {
      const files = readdirSync(BACKUP_DIR)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(join(BACKUP_DIR, f), 'utf-8'));
          const fallbackDate = getLogicalDateStr(data.updatedAt) || f.replace('.json', '');
          snapshots.push({ fallbackDate, words: (data && data.words) || {} });
        } catch (_) {}
      }
    } catch (_) {}
  }

  if (existsSync(PROGRESS_FILE)) {
    try {
      const cur = JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
      const fallbackDate = getLogicalDateStr(cur.updatedAt) || getLogicalDateStr(new Date());
      snapshots.push({ fallbackDate, words: (cur && cur.words) || {} });
    } catch (_) {}
  }

  let prevWords = {};
  const events = [];
  for (const snap of snapshots) {
    const curWords = snap.words || {};
    const allIds = new Set([...Object.keys(prevWords), ...Object.keys(curWords)]);
    for (const wid of allIds) {
      const prevRec = prevWords[wid] || null;
      const nextRec = curWords[wid] || null;
      if (JSON.stringify(prevRec) === JSON.stringify(nextRec)) continue;

      const delta = computeWordActionDelta(prevRec, nextRec, { allowUndoRevert: false });
      const eventDate =
        (nextRec && getLogicalDateStr(nextRec.updatedAt)) ||
        snap.fallbackDate ||
        getLogicalDateStr(new Date());
      const ts = (nextRec && nextRec.updatedAt) || '';
      events.push({ eventDate, ts, wid, nextRec, delta });
    }
    prevWords = curWords;
  }

  events.sort((a, b) => {
    const dCmp = a.eventDate.localeCompare(b.eventDate);
    if (dCmp !== 0) return dCmp;
    return String(a.ts).localeCompare(String(b.ts));
  });

  const eventsByDate = new Map();
  for (const ev of events) {
    if (!eventsByDate.has(ev.eventDate)) eventsByDate.set(ev.eventDate, []);
    eventsByDate.get(ev.eventDate).push(ev);
  }

  const replayWords = {};
  for (const dateStr of Array.from(eventsByDate.keys()).sort()) {
    const dayEvents = eventsByDate.get(dateStr);
    const day = ensureDayBucket(stats, dateStr);
    for (const ev of dayEvents) {
      const bookId = extractBookIdFromWid(ev.wid);
      if (!day.byBook[bookId]) {
        day.byBook[bookId] = { actions: createEmptyActions(), snapshot: createEmptySnapshot() };
      }
      if (hasNonZeroAction(ev.delta)) {
        applyDeltaToActions(day.actions, ev.delta);
        applyDeltaToActions(day.byBook[bookId].actions, ev.delta);
      }
      if (ev.nextRec && typeof ev.nextRec === 'object' && Object.keys(ev.nextRec).length > 0) {
        replayWords[ev.wid] = ev.nextRec;
      } else {
        delete replayWords[ev.wid];
      }
    }
    const snaps = computeSnapshotsFromWords(replayWords);
    day.snapshot = snaps.total;
    for (const bId of new Set([...Object.keys(day.byBook), ...Object.keys(snaps.byBook)])) {
      if (!day.byBook[bId]) {
        day.byBook[bId] = { actions: createEmptyActions(), snapshot: createEmptySnapshot() };
      }
      day.byBook[bId].snapshot = snaps.byBook[bId] || createEmptySnapshot();
    }
  }

  const nowIso = new Date().toISOString();
  stats.backfilledAt = nowIso;
  stats.updatedAt = nowIso;
  return stats;
}

function ensureAndLoadStudyStats() {
  if (existsSync(STATS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
      if (parsed && parsed.backfilledAt && parsed.vocab && parsed.vocab.days) {
        if (!parsed.dictation) parsed.dictation = {};
        if (!parsed.recitation) parsed.recitation = {};
        if (!parsed.listening) parsed.listening = {};
        return parsed;
      }
    } catch (_) {}
  }
  const backfilled = backfillStudyStatsFromBackups();
  try {
    writeJsonAtomic(STATS_FILE, backfilled);
  } catch (_) {}
  return backfilled;
}

function saveProgress(incoming) {
  const current = loadProgress();
  const stats = ensureAndLoadStudyStats();
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...(current.settings || {}), ...(incoming.settings || {}) },
    words: incoming.replaceWords
      ? (incoming.words || {})
      : { ...(current.words || {}), ...(incoming.words || {}) }
  };

  const str = writeJsonAtomic(PROGRESS_FILE, next);

  // Daily snapshot backup
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  try {
    writeFileSync(join(BACKUP_DIR, `${y}-${m}-${d}.json`), str, 'utf-8');
  } catch (_) {}

  // Update incremental daily learning stats
  const hasIncomingWords =
    Boolean(incoming.replaceWords) ||
    (incoming.words && Object.keys(incoming.words).length > 0);
  if (hasIncomingWords) {
    const today = getLogicalDateStr(now);
    const changedIds = incoming.replaceWords
      ? new Set([...Object.keys(current.words || {}), ...Object.keys(next.words || {})])
      : new Set(Object.keys(incoming.words || {}));
    const activeBookFallback = next.settings?.activeBook || '';
    let statsChanged = false;
    let statusChanged = false;

    for (const wid of changedIds) {
      const prevRec = (current.words && current.words[wid]) || null;
      const nextRec = (next.words && next.words[wid]) || null;
      if (JSON.stringify(prevRec) === JSON.stringify(nextRec)) continue;
      statusChanged = true;

      const allowSameDayUndo =
        !prevRec || !prevRec.updatedAt || getLogicalDateStr(prevRec.updatedAt) === today;
      const delta = computeWordActionDelta(prevRec, nextRec, {
        allowUndoRevert: allowSameDayUndo
      });

      if (hasNonZeroAction(delta)) {
        const day = ensureDayBucket(stats, today);
        const bookId = extractBookIdFromWid(wid, activeBookFallback);
        if (!day.byBook[bookId]) {
          day.byBook[bookId] = { actions: createEmptyActions(), snapshot: createEmptySnapshot() };
        }
        applyDeltaToActions(day.actions, delta);
        applyDeltaToActions(day.byBook[bookId].actions, delta);
        statsChanged = true;
      }
    }

    if (statsChanged || (statusChanged && stats.vocab.days[today])) {
      const day = ensureDayBucket(stats, today);
      const snaps = computeSnapshotsFromWords(next.words);
      day.snapshot = snaps.total;
      for (const bId of new Set([...Object.keys(day.byBook), ...Object.keys(snaps.byBook)])) {
        if (!day.byBook[bId]) {
          day.byBook[bId] = { actions: createEmptyActions(), snapshot: createEmptySnapshot() };
        }
        day.byBook[bId].snapshot = snaps.byBook[bId] || createEmptySnapshot();
      }
      stats.updatedAt = next.updatedAt;
      try {
        writeJsonAtomic(STATS_FILE, stats);
      } catch (_) {}
    }
  }

  return { status: 'ok', updatedAt: next.updatedAt, wordCount: Object.keys(next.words).length };
}

function loadStories() {
  const candidates = [
    STORIES_FILE,
    join(__dirname, '..', '..', 'lexicon', 'stories.json')
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, 'utf-8'));
      if (data && Array.isArray(data.stories)) {
        return {
          version: data.version || 1,
          updatedAt: data.updatedAt || null,
          stories: data.stories
        };
      }
    } catch (_) {}
  }
  return { version: 1, updatedAt: null, stories: [] };
}

function saveStories(incoming = {}) {
  const current = loadStories();
  const stories = Array.isArray(current.stories) ? [...current.stories] : [];
  const action = incoming.action || (incoming.story ? 'upsert' : '');

  if (action === 'delete' && incoming.id) {
    const filtered = stories.filter((s) => s.id !== incoming.id);
    const next = {
      version: 1,
      updatedAt: new Date().toISOString(),
      stories: filtered
    };
    writeJsonAtomic(STORIES_FILE, next);
    return { status: 'ok', ...next };
  }

  if (action === 'upsert' && incoming.story) {
    const st = incoming.story;
    const cleanId = String(st.id || `story-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-');
    const nowIso = new Date().toISOString();
    const record = {
      id: cleanId,
      book: String(st.book || ''),
      unit: String(st.unit || ''),
      title: String(st.title || '未命名情景故事').trim(),
      words: Array.isArray(st.words)
        ? Array.from(new Set(st.words.map((w) => String(w).trim().toLowerCase()).filter(Boolean)))
        : [],
      markdown: String(st.markdown || ''),
      updatedAt: nowIso
    };
    const idx = stories.findIndex((s) => s.id === cleanId);
    if (idx >= 0) stories[idx] = { ...stories[idx], ...record };
    else stories.unshift(record);
    const next = {
      version: 1,
      updatedAt: nowIso,
      stories
    };
    writeJsonAtomic(STORIES_FILE, next);
    return { status: 'ok', story: record, ...next };
  }

  return { status: 'noop', ...current };
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

const bookStatsIndexCache = new Map(); // filePath -> { mtimeMs, units, wordIndexById }

function loadBookStatsIndex(bookMeta) {
  if (!bookMeta || !bookMeta.file) return null;
  const target = resolveBookFilePath(basename(bookMeta.file));
  if (!target) return null;
  try {
    const mtimeMs = statSync(target).mtimeMs;
    const cached = bookStatsIndexCache.get(target);
    if (cached && cached.mtimeMs === mtimeMs) return cached;

    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    const wordIndexById = new Map();
    const unitCounts = new Map();
    for (const w of parsed.words || []) {
      if (!w || !w.id) continue;
      wordIndexById.set(w.id, {
        id: w.id,
        unit: w.unit || '',
        word: w.word || '',
        cleanWord: w.cleanWord || w.word || '',
        zhMeaning: w.zhMeaning || '',
        enMeaning: w.enMeaning || '',
        rootBreakdown: w.rootBreakdown || '',
        phonetics: w.phonetics || null
      });
      if (w.unit) {
        unitCounts.set(w.unit, (unitCounts.get(w.unit) || 0) + 1);
      }
    }
    const units = (parsed.units || []).map((u) => ({
      id: u.id,
      title: u.title || u.id,
      total: typeof u.wordCount === 'number' ? u.wordCount : (unitCounts.get(u.id) || 0)
    }));
    const entry = { mtimeMs, units, wordIndexById };
    bookStatsIndexCache.set(target, entry);
    return entry;
  } catch (_) {
    return null;
  }
}

function resolveEnglishMasteryDir() {
  const candidates = [
    resolve(LEXICON_DIR, '..', '..'),
    join(homeDir, 'Documents', '博士资料', 'PKM_Vault', 'English_Mastery'),
    resolve(__dirname, '..', '..', '..')
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, '01_Daily_Practice')) || existsSync(join(dir, '04_Recitation_Bank'))) {
      return dir;
    }
  }
  return null;
}

function scanReservedModules() {
  const rootDir = resolveEnglishMasteryDir();
  const result = {
    rootFound: Boolean(rootDir),
    dictation: { label: '句子默写', dir: '01_Daily_Practice', fileCount: 0, latestFile: null },
    recitation: { label: '骨架背诵', dir: '04_Recitation_Bank', fileCount: 0, dayCount: 0, sentenceCount: 0 },
    listening: { label: '精听训练', dir: '05_Listening_Bank', fileCount: 0, audioCount: 0, latestFile: null }
  };
  if (!rootDir) return result;

  try {
    const dpDir = join(rootDir, '01_Daily_Practice');
    if (existsSync(dpDir)) {
      const mdFiles = readdirSync(dpDir).filter((f) => f.endsWith('.md')).sort();
      result.dictation.fileCount = mdFiles.length;
      result.dictation.latestFile = mdFiles.length ? mdFiles[mdFiles.length - 1] : null;
    }
  } catch (_) {}

  try {
    const rbDir = join(rootDir, '04_Recitation_Bank');
    if (existsSync(rbDir)) {
      const mdFiles = readdirSync(rbDir).filter((f) => f.endsWith('.md')).sort();
      result.recitation.fileCount = mdFiles.length;
      const dailyFile = join(rbDir, 'Daily_Recitations.md');
      if (existsSync(dailyFile)) {
        const text = readFileSync(dailyFile, 'utf-8');
        result.recitation.dayCount = (text.match(/^##\s+📅/gm) || []).length;
        result.recitation.sentenceCount = (text.match(/^###\s+📌/gm) || []).length;
      }
    }
  } catch (_) {}

  try {
    const lbDir = join(rootDir, '05_Listening_Bank');
    if (existsSync(lbDir)) {
      const mdFiles = readdirSync(lbDir).filter((f) => f.endsWith('.md')).sort();
      result.listening.fileCount = mdFiles.length;
      result.listening.latestFile = mdFiles.length ? mdFiles[mdFiles.length - 1] : null;
      const audioDir = join(lbDir, 'audio');
      if (existsSync(audioDir)) {
        result.listening.audioCount = readdirSync(audioDir)
          .filter((f) => /\.(mp3|wav|m4a)$/i.test(f)).length;
      }
    }
  } catch (_) {}

  return result;
}

function buildStatsPayload() {
  const manifest = loadManifest();
  const progress = loadProgress();
  const stats = ensureAndLoadStudyStats();
  const wordsMap = progress.words || {};
  const today = getLogicalDateStr(new Date());

  const bookSummaries = [];
  const unitBreakdowns = {};
  const bookIndexById = new Map();
  const bookTitleById = new Map();

  for (const b of manifest.books || []) {
    const idx = loadBookStatsIndex(b);
    bookIndexById.set(b.id, idx);
    bookTitleById.set(b.id, b.shortTitle || b.title || b.id);

    const totalWords = typeof b.totalWords === 'number'
      ? b.totalWords
      : (idx ? idx.wordIndexById.size : 0);
    let known = 0;
    let mastered = 0;
    let learning = 0;
    let starred = 0;

    const unitAccMap = new Map();
    if (idx) {
      for (const u of idx.units) {
        unitAccMap.set(u.id, {
          id: u.id,
          title: u.title,
          total: u.total,
          known: 0,
          mastered: 0,
          learning: 0,
          untouched: u.total,
          starred: 0
        });
      }
    }

    for (const [wid, rec] of Object.entries(wordsMap)) {
      if (!rec || typeof rec !== 'object') continue;
      const belongsToBook = idx
        ? (idx.wordIndexById.has(wid) || wid.startsWith(`${b.id}:`))
        : wid.startsWith(`${b.id}:`);
      if (!belongsToBook) continue;

      const status = rec.status;
      if (status === 'known') known += 1;
      else if (status === 'mastered') mastered += 1;
      else if (status === 'learning') learning += 1;
      if (rec.starred) starred += 1;

      const metaWord = idx ? idx.wordIndexById.get(wid) : null;
      const unitId = (metaWord && metaWord.unit) || wid.split(':')[1] || '';
      if (unitId) {
        if (!unitAccMap.has(unitId)) {
          unitAccMap.set(unitId, {
            id: unitId,
            title: unitId,
            total: 0,
            known: 0,
            mastered: 0,
            learning: 0,
            untouched: 0,
            starred: 0
          });
        }
        const uRow = unitAccMap.get(unitId);
        if (status === 'known') uRow.known += 1;
        else if (status === 'mastered') uRow.mastered += 1;
        else if (status === 'learning') uRow.learning += 1;
        if (rec.starred) uRow.starred += 1;
      }
    }

    const unitRows = Array.from(unitAccMap.values()).map((u) => ({
      ...u,
      untouched: Math.max(0, u.total - u.known - u.mastered - u.learning)
    }));
    unitBreakdowns[b.id] = unitRows;

    const untouched = Math.max(0, totalWords - known - mastered - learning);
    const donePct = totalWords ? Math.round(((known + mastered) / totalWords) * 100) : 0;
    bookSummaries.push({
      id: b.id,
      title: b.title || b.id,
      shortTitle: b.shortTitle || b.title || b.id,
      totalWords,
      known,
      mastered,
      learning,
      untouched,
      starred,
      donePct
    });
  }

  const hardWords = [];
  for (const [wid, rec] of Object.entries(wordsMap)) {
    if (!rec || typeof rec !== 'object') continue;
    const audioMiss = Number(rec.audio_miss_count) || 0;
    const reviewFail = Number(rec.review_fail_count) || 0;
    const isStarred = Boolean(rec.starred);
    const isLearning = rec.status === 'learning';
    if (!isLearning && !isStarred && audioMiss <= 0 && reviewFail <= 0) continue;

    const parts = wid.split(':');
    const bookId = parts[0] || '';
    const idx = bookIndexById.get(bookId);
    const metaWord = idx ? idx.wordIndexById.get(wid) : null;
    const weight = reviewFail * 3 + audioMiss * 2 + (isStarred ? 2 : 0) + (isLearning ? 1 : 0);

    hardWords.push({
      wid,
      bookId,
      bookTitle: bookTitleById.get(bookId) || bookId,
      unit: (metaWord && metaWord.unit) || parts[1] || '',
      word: (metaWord && metaWord.word) || parts.slice(2).join(':') || wid,
      cleanWord: (metaWord && metaWord.cleanWord) || parts.slice(2).join(':') || wid,
      status: rec.status || 'learning',
      starred: isStarred,
      audio_miss_count: audioMiss,
      audio_pass_count: Number(rec.audio_pass_count) || 0,
      review_fail_count: reviewFail,
      review_pass_count: Number(rec.review_pass_count) || 0,
      mnemonic: rec.mnemonic || '',
      zhMeaning: (metaWord && metaWord.zhMeaning) || '',
      enMeaning: (metaWord && metaWord.enMeaning) || '',
      rootBreakdown: (metaWord && metaWord.rootBreakdown) || '',
      phonetics: (metaWord && metaWord.phonetics) || null,
      updatedAt: rec.updatedAt || '',
      weight
    });
  }

  hardWords.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });

  const sortedDays = {};
  for (const dKey of Object.keys((stats.vocab && stats.vocab.days) || {}).sort()) {
    sortedDays[dKey] = stats.vocab.days[dKey];
  }

  return {
    manifest,
    cutoffHour: CUTOFF_HOUR,
    today,
    activeBook: (progress.settings && progress.settings.activeBook) || (manifest.books[0] && manifest.books[0].id) || '',
    listenVoice: (progress.settings && progress.settings.listenVoice) || 'Samantha',
    vocab: {
      days: sortedDays,
      bookSummaries,
      unitBreakdowns,
      hardWords: hardWords.slice(0, 200),
      hardWordsTotal: hardWords.length
    },
    reservedModules: scanReservedModules()
  };
}

function buildHtml(token = '') {
  if (!existsSync(HTML_PATH)) {
    return '<h1>vocab_sieve index.html not found</h1>';
  }
  let html = readFileSync(HTML_PATH, 'utf-8');
  const manifest = loadManifest();
  const progress = loadProgress();
  const stories = loadStories();
  const inject = `<script>
window.__INITIAL_MANIFEST__ = ${JSON.stringify(manifest).replace(/<\//g, '<\\/')};
window.__INITIAL_PROGRESS__ = ${JSON.stringify(progress).replace(/<\//g, '<\\/')};
window.__INITIAL_STORIES__ = ${JSON.stringify(stories).replace(/<\//g, '<\\/')};
window.__LEXICON_DIR__ = ${JSON.stringify(LEXICON_DIR)};
window.__SIDECAR_TOKEN__ = ${JSON.stringify(token)};
</script>\n</head>`;
  return html.replace('</head>', inject);
}

function buildStatsHtml(token = '') {
  if (!existsSync(STATS_HTML_PATH)) {
    return '<h1>vocab_sieve stats.html not found</h1>';
  }
  let html = readFileSync(STATS_HTML_PATH, 'utf-8');
  const statsPayload = buildStatsPayload();
  const inject = `<script>
window.__INITIAL_STATS__ = ${JSON.stringify(statsPayload).replace(/<\//g, '<\\/')};
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
    if (req.method === 'GET' && (pathname === '/stats' || pathname === '/stats.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_CACHE_HEADERS });
      res.end(buildStatsHtml(''));
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
    if (req.method === 'GET' && pathname === '/api/stories') {
      sendJson(loadStories());
      return;
    }
    if (req.method === 'GET' && pathname === '/api/stats') {
      sendJson(buildStatsPayload());
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
      if (pathname === '/api/stories') {
        sendJson(saveStories(body));
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

  const serveStats = () =>
    new Response(buildStatsHtml(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || ''), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_CACHE_HEADERS
    });

  app.page('/', serveIndex);
  app.page('/index.html', serveIndex);
  app.page('/stats', serveStats);
  app.page('/stats.html', serveStats);

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

  app.api('/api/stories', async () => loadStories(), 'GET');

  app.api('/api/stats', async () => buildStatsPayload(), 'GET');

  app.api('/api/progress', async (data) => {
    const body = data && data.body && (data.body.words || data.body.settings) ? data.body : (data || {});
    return saveProgress(body);
  }, 'POST');

  app.api('/api/stories', async (data) => {
    const body = data && data.body && (data.body.action || data.body.story || data.body.id) ? data.body : (data || {});
    return saveStories(body);
  }, 'POST');

  app.api('/api/tts', async (data) => {
    const body = data && data.body && data.body.text ? data.body : (data || {});
    return resolveWordAudio(body.text, body.voice, body.rate);
  }, 'POST');

  app.run();
}
