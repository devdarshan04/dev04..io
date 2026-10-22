/* ==========================================================================
   StudyBuddy 3D — script.js  (ES module, no build step)

   Sections
     1. Configuration
     2. Pure logic (chunking, BM25, validation, spaced repetition) — DOM-free
     3. Storage (window.storage with in-memory fallback — never localStorage)
     4. DOM helpers, toasts, API client
     5. 3D background (Three.js) and card tilt
     6. PDF ingestion
     7. Views: login, dashboard, chat, exam, flashcards
     8. Boot
   ========================================================================== */

(function () {
'use strict';

/* -------------------------------------------------------------------------
   1. Configuration
   ------------------------------------------------------------------------- */
const CONFIG = {
  CHUNK_WORDS: 500,          // approximate words per chunk
  CHUNK_OVERLAP: 80,         // words shared between neighbouring chunks
  TOP_K: 4,                  // chunks sent to the AI
  BM25_K1: 1.2,
  BM25_B: 0.75,
  // Retrieval gate. Normalised BM25 is score / (sum of idf*(k1+1)) for the query terms
  // found in the notes, so it lies between 0 and 1. A chunk must clear BOTH numbers or
  // the question is refused locally and the AI API is never called.
  MIN_RELEVANCE: 0.22,
  MIN_TERM_MATCH: 0.5,       // share of the question's terms that the best chunk must contain
  METER_FULL: 0.6,           // relevance that fills the meter to 100 %
  EXAM_QUESTIONS: 5,
  CARD_BATCH: 8,
  REVIEW_DAYS: [1, 3, 7],    // spaced-repetition intervals
  MAX_PDF_BYTES: 25 * 1024 * 1024,
  MAX_PDF_PAGES: 400,
  MIN_WORDS: 30,             // fewer words than this means the PDF has no usable text layer
  REQUEST_TIMEOUT_MS: 70000
};

const DAY_MS = 86400000;

/* -------------------------------------------------------------------------
   2. Pure logic
   ------------------------------------------------------------------------- */

// Words that carry no topic information. English + common Hinglish + Hindi question words.
const STOPWORDS = new Set((
  'a an the and or but if then else of to in on at by for with from as is are was were be been being am do does did done ' +
  'have has had having this that these those it its they them their he she his her we you your i me my our us ' +
  'what which who whom whose when where why how can could should would will shall may might must not no yes ' +
  'about into over under between during also than too very so such there here any some all each both more most other ' +
  'tell explain define describe give please show say mean meaning example difference ' +
  'kya hai hain ho hota hoti hote tha thi the ka ki ke ko mein me se par pe aur ya yeh ye woh wo isme isko iska ' +
  'kaise kyun kyu kaun kab kahan kitna kitne kitni batao bataiye btao batana samjhao samjhaiye samjha ' +
  'kar karo kare karna kiya liye lie bhi hi toh to jo jab tab ek koi kuch mujhe mujhko hume humein apne ' +
  'क्या है हैं का की के को में से पर और या यह वह कैसे क्यों कौन कब कहाँ कहां बताओ बताइए समझाओ समझाइए ' +
  'कर करो होता होती होते था थी एक कोई कुछ मुझे हमें अपने'
).split(/\s+/).filter(Boolean));

/** Very light plural stemmer so "networks" matches "network". Applied to both sides. */
function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 4) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Lower-case, split on anything that is not a letter/mark/number (works for Devanagari), drop stopwords. */
function tokenize(text) {
  const out = [];
  const parts = String(text || '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
  for (const p of parts) {
    if (!p || STOPWORDS.has(p)) continue;
    if (p.length < 2 && !/\d/.test(p)) continue;
    out.push(stem(p));
  }
  return out;
}

/** "p. 3" or "pp. 3–5" from an array of page numbers. */
function pageLabel(pages) {
  const list = [...new Set((pages || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!list.length) return '';
  if (list.length === 1) return `p. ${list[0]}`;
  const contiguous = list.every((v, i) => i === 0 || v === list[i - 1] + 1);
  return contiguous ? `pp. ${list[0]}–${list[list.length - 1]}` : `pp. ${list.join(', ')}`;
}

/**
 * Split extracted pages into ~CHUNK_WORDS-word chunks with CHUNK_OVERLAP words of overlap.
 * Every chunk records which pages it touches and has "[p. N]" markers inside the text at each
 * page boundary, so the AI (and our citation checker) can tell exactly where a sentence came from.
 * @param {{page:number,text:string}[]} pages
 */
function chunkPages(pages, size = CONFIG.CHUNK_WORDS, overlap = CONFIG.CHUNK_OVERLAP) {
  const words = [];
  for (const p of pages) {
    const ws = String(p.text || '').split(/\s+/).filter(Boolean);
    for (const w of ws) words.push({ w, page: p.page });
  }
  const chunks = [];
  if (!words.length) return chunks;
  const step = Math.max(1, size - overlap);
  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(words.length, start + size);
    const parts = [];
    const pageSet = [];
    let prevPage = null;
    for (let i = start; i < end; i++) {
      const { w, page } = words[i];
      if (page !== prevPage) { parts.push(`[p. ${page}]`); prevPage = page; if (!pageSet.includes(page)) pageSet.push(page); }
      parts.push(w);
    }
    chunks.push({
      id: chunks.length,
      text: parts.join(' '),
      pages: pageSet,
      pageStart: pageSet[0],
      pageEnd: pageSet[pageSet.length - 1],
      words: end - start
    });
    if (end === words.length) break;
  }
  return chunks;
}

/** Build a BM25 index. The page markers are removed before indexing. */
function buildIndex(chunks) {
  const docs = chunks.map(c => {
    const tokens = tokenize(c.text.replace(/\[p\. \d+\]/g, ' '));
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: tokens.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { chunks, docs, df, avgdl: avgdl || 1, N: docs.length };
}

/**
 * BM25 retrieval. Returns the top-k chunks plus a normalised relevance for the best one and
 * `passes`, the verdict of the local gate.
 */
function retrieve(index, query, k = CONFIG.TOP_K) {
  const qAll = [...new Set(tokenize(query))];
  const empty = { results: [], relevance: 0, termMatch: 0, passes: false, terms: qAll };
  if (!qAll.length || !index || !index.N) return empty;

  const inVocab = qAll.filter(t => index.df.has(t));
  if (!inVocab.length) return empty;

  const idf = t => {
    const n = index.df.get(t) || 0;
    return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
  };
  const maxScore = inVocab.reduce((s, t) => s + idf(t) * (CONFIG.BM25_K1 + 1), 0);

  const scored = index.docs.map((d, i) => {
    let score = 0, matched = 0;
    for (const t of inVocab) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched++;
      score += idf(t) * (f * (CONFIG.BM25_K1 + 1)) /
        (f + CONFIG.BM25_K1 * (1 - CONFIG.BM25_B + CONFIG.BM25_B * d.len / index.avgdl));
    }
    return { chunk: index.chunks[i], score, matched };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);

  if (!scored.length) return empty;
  const top = scored[0];
  // Terms of the question that are absent from the whole document lower the relevance a little.
  const unmatchedShare = (qAll.length - inVocab.length) / qAll.length;
  const relevance = Math.min(1, (top.score / maxScore) * (1 - 0.5 * unmatchedShare));
  const termMatch = top.matched / qAll.length;
  const results = scored.map(r => ({ chunk: r.chunk, score: r.score, relevance: Math.min(1, (r.score / maxScore) * (1 - 0.5 * unmatchedShare)) }));
  return {
    results, relevance, termMatch, terms: qAll,
    passes: relevance >= CONFIG.MIN_RELEVANCE && termMatch >= CONFIG.MIN_TERM_MATCH
  };
}

/** Relevance as a 0-100 value for the meter. */
function meterPercent(relevance) {
  return Math.max(0, Math.min(100, Math.round((relevance / CONFIG.METER_FULL) * 100)));
}

/** Pull the first JSON value out of a model reply, tolerating code fences and chatter. */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  const open = s.search(/[\[{]/);
  if (open < 0) return null;
  const closeCh = s[open] === '[' ? ']' : '}';
  const close = s.lastIndexOf(closeCh);
  if (close <= open) return null;
  try { return JSON.parse(s.slice(open, close + 1)); } catch (_) { return null; }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Validate an AI-written exam. Questions that are malformed, or that cite a page that was not
 * in the material we sent, are discarded. Options are shuffled so the answer is not predictable.
 */
function validateExam(raw, validPages, want = CONFIG.EXAM_QUESTIONS, rnd = Math.random) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : null);
  if (!list) return { ok: false, error: 'The AI reply was not a list of questions.', questions: [] };
  const pages = new Set(validPages);
  const questions = [];
  const seen = new Set();
  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const question = str(q.question, 400);
    const explanation = str(q.explanation, 700);
    const topic = str(q.topic, 80) || 'General';
    const page = Number(q.page);
    let options = Array.isArray(q.options) ? q.options.map(o => str(typeof o === 'string' ? o : '', 300)) : [];
    if (!question || !explanation || options.length !== 4 || options.some(o => !o)) continue;
    if (new Set(options.map(o => o.toLowerCase())).size !== 4) continue;
    if (!Number.isInteger(page) || !pages.has(page)) continue;
    let ai = q.answerIndex;
    if (typeof ai === 'string' && /^[A-Da-d]$/.test(ai.trim())) ai = 'abcd'.indexOf(ai.trim().toLowerCase());
    if (!Number.isInteger(ai) || ai < 0 || ai > 3) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const order = shuffle([0, 1, 2, 3], rnd);
    options = order.map(i => options[i]);
    questions.push({ question, options, answerIndex: order.indexOf(ai), explanation, topic, page });
    if (questions.length === want) break;
  }
  if (questions.length < want) {
    return { ok: false, error: `Only ${questions.length} of ${want} questions were usable. Please try again.`, questions };
  }
  return { ok: true, questions };
}

/** Validate AI-written flashcards (same rules: real page, no duplicates, sane lengths). */
function validateCards(raw, validPages, minOk = 3) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.cards) ? raw.cards : null);
  if (!list) return { ok: false, error: 'The AI reply was not a list of flashcards.', cards: [] };
  const pages = new Set(validPages);
  const cards = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const front = str(c.front, 300), back = str(c.back, 600), topic = str(c.topic, 80) || 'General';
    const page = Number(c.page);
    if (!front || !back || !Number.isInteger(page) || !pages.has(page)) continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push({ front, back, topic, page });
  }
  if (cards.length < minOk) return { ok: false, error: `Only ${cards.length} usable flashcards came back. Please try again.`, cards };
  return { ok: true, cards };
}

/** Page numbers cited in an answer as "[p. 3]" / "[pp. 3-4]" / "[p. 3, 5]". */
function parseCitations(text) {
  const pages = new Set();
  const re = /\[(?:p|pp|page|pages)\.?\s*([\d,\s\-–]+)\]/gi;
  let m;
  while ((m = re.exec(text))) {
    for (const part of m[1].split(',')) {
      const r = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (r) { for (let i = +r[1]; i <= Math.min(+r[2], +r[1] + 50); i++) pages.add(i); }
      else if (/^\d+$/.test(part.trim())) pages.add(+part.trim());
    }
  }
  return [...pages];
}

/** Spaced repetition: known -> next interval (1, 3, 7 days); not known -> back to stage 0, due now. */
function scheduleCard(card, known, now = Date.now()) {
  const stage = known ? Math.min(card.stage + 1, CONFIG.REVIEW_DAYS.length) : 0;
  return {
    ...card,
    stage,
    due: known ? now + CONFIG.REVIEW_DAYS[stage - 1] * DAY_MS : now,
    reviews: (card.reviews || 0) + 1,
    lapses: (card.lapses || 0) + (known ? 0 : 1),
    lastReviewed: now
  };
}

/** Evenly spaced chunk picks so an exam or deck covers the whole document. */
function sampleChunks(chunks, n) {
  if (chunks.length <= n) return chunks.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(chunks[Math.floor((i * chunks.length) / n)]);
  return out;
}


/* -------------------------------------------------------------------------
   3. Storage — window.storage when the host provides it, otherwise memory.
      localStorage / sessionStorage are deliberately never used.
   ------------------------------------------------------------------------- */
const memoryStore = new Map();
const hasWindowStorage = () =>
  typeof window !== 'undefined' && window.storage &&
  typeof window.storage.get === 'function' && typeof window.storage.set === 'function';

const storageStatus = { persistent: false, lastSaveFailed: false };

async function storeGet(key, fallback) {
  if (hasWindowStorage()) {
    try {
      const r = await window.storage.get(key);
      const raw = r && typeof r === 'object' && 'value' in r ? r.value : r;
      if (raw != null) {
        storageStatus.persistent = true;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
      storageStatus.persistent = true;
    } catch (_) { /* key missing or storage unavailable: use memory */ }
  }
  if (memoryStore.has(key)) {
    try { return JSON.parse(memoryStore.get(key)); } catch (_) { /* ignore */ }
  }
  return fallback;
}

async function storeSet(key, value) {
  let text;
  try { text = JSON.stringify(value, (k, v) => (k.startsWith('_') ? undefined : v)); } catch (_) { return false; }
  memoryStore.set(key, text);                 // always keep an in-memory copy
  if (!hasWindowStorage()) return false;
  try {
    await window.storage.set(key, text);
    storageStatus.persistent = true;
    storageStatus.lastSaveFailed = false;
    return true;
  } catch (_) {
    storageStatus.lastSaveFailed = true;      // e.g. quota exceeded; data stays in memory
    return false;
  }
}

const KEYS = { docs: 'sb:docs', cards: 'sb:cards', activity: 'sb:activity' };
const saveTimers = {};
/** Debounced save of one slice of state. */
function persist(name) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(async () => {
    await storeSet(KEYS[name], state[name]);
    if (state.view === 'dashboard') renderStorageNote();
  }, 250);
}

/* -------------------------------------------------------------------------
   4. State, DOM helpers, toasts, API client
   ------------------------------------------------------------------------- */
const state = {
  user: null,
  view: 'login',
  docs: [],                                   // {id,name,size,pages,words,script,addedAt,chunks[]}
  cards: [],                                  // flashcards, see generateCards()
  activity: { questions: 0, cardReviews: 0, exams: [], weak: {} },
  chats: {},                                  // docId -> message[] (memory only)
  activeDocId: null,
  serverOK: null,                             // null = unknown, true/false after health check
  exam: { status: 'idle', docId: null, questions: [], answers: [], current: 0, error: '' },
  study: { queue: [], flipped: false, busy: false, docId: null },
  busy: { chat: false, exam: false, cards: false, upload: false }
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Build a DOM node. All text goes through textContent, so notes and AI replies can never inject HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function btn(label, cls, onClick, extra = {}) {
  return h('button', { type: 'button', class: `btn3d ${cls}`, onclick: onClick, ...extra }, h('span', { class: 'btn-label', text: label }));
}

function toast(message, type = 'info', ms = 4800) {
  const region = $('#toast-region');
  if (!region) return;
  const el = h('div', { class: `toast ${type === 'err' ? 'err' : type === 'ok' ? 'ok' : ''}`, text: message });
  region.append(el);
  setTimeout(() => el.remove(), ms);
}

function setBusy(button, on) {
  if (!button) return;
  button.classList.toggle('is-busy', on);
  button.disabled = on;
  button.setAttribute('aria-busy', on ? 'true' : 'false');
}

const timeAgo = ms => {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

function dayLabel(ms) {
  const start = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((start(ms) - start(Date.now())) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/* ---- API client (talks only to our own Express server; no keys in the browser) ---- */
const apiMeta = typeof document !== 'undefined' ? document.querySelector('meta[name="studybuddy-api"]') : null;
const API_BASE = ((apiMeta && apiMeta.content) || '').trim().replace(/\/+$/, '');

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ApiError'; this.status = status; }
}

async function request(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new ApiError('The request took too long. Please try again.');
    throw new ApiError("Can't reach the StudyBuddy server. Make sure it is running and that the API address in index.html is correct.");
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON body */ }
  if (!res.ok) {
    const fallback = res.status === 404 || res.status === 405
      ? 'The AI endpoint was not found. Is the StudyBuddy server running?'
      : `Server error (${res.status}). Please try again.`;
    throw new ApiError((data && data.error) || fallback, res.status);
  }
  return data || {};
}
const api = (path, body) => request('POST', path, body);

async function checkServer() {
  try {
    const r = await request('GET', '/api/health');
    state.serverOK = !!(r && r.ok && r.configured);
    state.serverMsg = state.serverOK ? '' : 'The server is running but ANTHROPIC_API_KEY is not set.';
  } catch (e) {
    state.serverOK = false;
    state.serverMsg = e.message;
  }
  if (state.view === 'dashboard') renderStorageNote();
  return state.serverOK;
}

/* -------------------------------------------------------------------------
   5. 3D background (Three.js, loaded on demand) and card tilt
   ------------------------------------------------------------------------- */
let burstBackground = () => {};

async function initBackground() {
  const canvas = $('#bg-canvas');
  const fallback = $('#bg-fallback');
  const useFallback = () => { canvas.hidden = true; fallback.hidden = false; };

  try {
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl');
  } catch (_) { useFallback(); return; }

  let THREE;
  try {
    THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js');
  } catch (_) { useFallback(); return; }

  try {
    const small = window.innerWidth < 700;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.z = 9;

    const CYAN = 0x22d3ee, VIOLET = 0x8b5cf6;

    // Knowledge sphere: wireframe shell + glowing point cloud
    const sphere = new THREE.Group();
    sphere.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 2),
      new THREE.MeshBasicMaterial({ color: CYAN, wireframe: true, transparent: true, opacity: 0.28 })
    ));
    sphere.add(new THREE.Points(
      new THREE.IcosahedronGeometry(2.25, small ? 3 : 4),
      new THREE.PointsMaterial({ color: VIOLET, size: 0.045, transparent: true, opacity: 0.9 })
    ));
    scene.add(sphere);

    // Holographic books orbiting the sphere
    const books = [];
    const bookGeo = new THREE.BoxGeometry(0.9, 1.2, 0.2);
    const edgeGeo = new THREE.EdgesGeometry(bookGeo);
    const bookCount = small ? 5 : 8;
    for (let i = 0; i < bookCount; i++) {
      const color = i % 2 ? VIOLET : CYAN;
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bookGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1 })));
      g.add(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })));
      const angle = (i / bookCount) * Math.PI * 2;
      g.userData = { angle, radius: 4.1 + (i % 3) * 0.7, y: (Math.random() - 0.5) * 3.2, speed: 0.12 + Math.random() * 0.1, phase: Math.random() * 6 };
      scene.add(g);
      books.push(g);
    }

    // Floating particles
    const pCount = small ? 140 : 320;
    const pos = new Float32Array(pCount * 3);
    for (let i = 0; i < pCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 26;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 14;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: CYAN, size: 0.05, transparent: true, opacity: 0.65 }));
    scene.add(particles);

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    window.addEventListener('pointermove', e => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });

    let boost = 0;
    burstBackground = () => { boost = 1; };

    const resize = () => {
      const w = window.innerWidth, hgt = window.innerHeight;
      renderer.setSize(w, hgt, false);
      camera.aspect = w / hgt;
      camera.updateProjectionMatrix();
      sphere.position.x = w > 900 ? -2.4 : 0;     // keep the sphere beside the login card on wide screens
      if (still) draw(0);
    };

    const still = reduceMotion();
    const clock = new THREE.Clock();
    let t = 0;
    function draw(dt) {
      t += dt;
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      boost *= 0.96;
      sphere.rotation.y += dt * (0.18 + boost * 2.2);
      sphere.rotation.x = mouse.y * 0.35 + Math.sin(t * 0.3) * 0.1;
      sphere.rotation.z = mouse.x * 0.2;
      books.forEach(b => {
        const d = b.userData;
        d.angle += dt * d.speed * (1 + boost * 4);
        b.position.set(Math.cos(d.angle) * d.radius, d.y + Math.sin(t + d.phase) * 0.25, Math.sin(d.angle) * d.radius * 0.6 - 1);
        b.rotation.y += dt * 0.6;
        b.rotation.x = Math.sin(t * 0.7 + d.phase) * 0.3;
      });
      particles.rotation.y = mouse.x * 0.12 + t * 0.01;
      particles.rotation.x = mouse.y * 0.08;
      camera.position.x += (mouse.x * 0.9 - camera.position.x) * 0.04;
      camera.position.y += (-mouse.y * 0.6 - camera.position.y) * 0.04;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    }

    window.addEventListener('resize', resize);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); useFallback(); });
    resize();
    fallback.hidden = true;

    if (still) { draw(0); return; }               // reduced motion: one calm static frame
    let running = true;
    document.addEventListener('visibilitychange', () => {
      running = !document.hidden;
      if (running) { clock.getDelta(); loop(); }
    });
    function loop() {
      if (!running) return;
      draw(Math.min(clock.getDelta(), 0.05));
      requestAnimationFrame(loop);
    }
    loop();
  } catch (_) {
    useFallback();
  }
}

/** Cards tilt toward the cursor (skipped on touch screens and for reduced motion). */
function initTilt() {
  if (reduceMotion() || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) return;
  let current = null;
  const reset = el => { if (el) el.style.transform = ''; };
  document.addEventListener('pointermove', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tilt]') : null;
    if (current && current !== el) reset(current);
    current = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(900px) rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 9).toFixed(2)}deg) translateZ(6px)`;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { reset(current); current = null; });
}

/* -------------------------------------------------------------------------
   6. PDF ingestion (PDF.js, entirely in the browser)
   ------------------------------------------------------------------------- */
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let pdfReady = null;

function ensurePdfJs() {
  if (pdfReady) return pdfReady;
  pdfReady = (async () => {
    for (let i = 0; i < 50 && !window.pdfjsLib; i++) await wait(100);   // the script tag is deferred
    if (!window.pdfjsLib) throw new Error('The PDF reader (PDF.js) could not be loaded. Check your internet connection and reload the page.');
    try {
      // Load the worker as a same-origin blob so cross-origin worker rules cannot block it.
      const res = await fetch(PDFJS_WORKER);
      if (!res.ok) throw new Error('worker fetch failed');
      const blob = new Blob([await res.text()], { type: 'text/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    } catch (_) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;     // PDF.js falls back to a main-thread worker
    }
  })().catch(e => { pdfReady = null; throw e; });
  return pdfReady;
}

/** Read a PDF and return {pages:[{page,text}], numPages}. Throws Errors with student-friendly messages. */
async function extractPdf(file, onProgress) {
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) throw new Error('This is not a PDF file.');
  if (!file.size) throw new Error('This file is empty.');
  if (file.size > CONFIG.MAX_PDF_BYTES) throw new Error(`This PDF is larger than ${Math.round(CONFIG.MAX_PDF_BYTES / 1048576)} MB.`);
  await ensurePdfJs();

  const buf = await file.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (head !== '%PDF-') throw new Error('This file does not look like a valid PDF.');

  let pdf;
  try {
    pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.');
    throw new Error('This PDF is damaged or could not be opened.');
  }
  try {
    if (pdf.numPages > CONFIG.MAX_PDF_PAGES) throw new Error(`This PDF has ${pdf.numPages} pages; the limit is ${CONFIG.MAX_PDF_PAGES}.`);
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/\s+/g, ' ').trim();
      pages.push({ page: p, text });
      page.cleanup();
      onProgress && onProgress(p / pdf.numPages);
    }
    return { pages, numPages: pdf.numPages };
  } finally {
    pdf.destroy && pdf.destroy();
  }
}

async function ingestFile(file, row) {
  const bar = $('i', row);
  const label = $('.up-label', row);
  const { pages, numPages } = await extractPdf(file, f => { bar.style.width = `${Math.round(f * 90)}%`; });
  const text = pages.map(p => p.text).join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < CONFIG.MIN_WORDS) {
    throw new Error('No selectable text was found. Scanned or image-only PDFs are not supported — try a PDF exported from a document or slides.');
  }
  label.textContent = `${file.name} — building search index…`;
  await wait(0);
  const chunks = chunkPages(pages);
  const dev = (text.match(/[ऀ-ॿ]/g) || []).length;
  const doc = {
    id: uid(), name: file.name, size: file.size, pages: numPages, words,
    script: dev / Math.max(1, text.length) > 0.25 ? 'dev' : 'latin',
    addedAt: Date.now(), chunks
  };
  state.docs.unshift(doc);
  state.activeDocId = doc.id;
  persist('docs');
  bar.style.width = '100%';
  return doc;
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (state.busy.upload) { toast('An upload is already in progress.', 'err'); return; }
  state.busy.upload = true;
  const box = $('#upload-status');
  box.replaceChildren();
  let added = 0;
  for (const file of files) {
    const row = h('div', { class: 'up-item' }, h('span', { class: 'up-label', text: `${file.name} — reading…` }), h('div', { class: 'up-bar' }, h('i')));
    box.append(row);
    try {
      if (state.docs.some(d => d.name === file.name && d.size === file.size)) throw new Error('This file is already in your library.');
      const doc = await ingestFile(file, row);
      $('.up-label', row).textContent = `${file.name} — ready (${doc.pages} pages, ${doc.words.toLocaleString()} words)`;
      added++;
    } catch (e) {
      row.classList.add('err');
      $('.up-label', row).textContent = `${file.name} — ${e.message || 'could not be read.'}`;
      $('.up-bar', row).remove();
    }
  }
  state.busy.upload = false;
  $('#file-input').value = '';
  if (added) {
    toast(added === 1 ? 'Notes added. Ask a question, take an exam or make flashcards.' : `${added} PDFs added.`, 'ok');
    renderDashboard();
  }
}

function getDoc(id) { return state.docs.find(d => d.id === id) || null; }
function activeDoc() { return getDoc(state.activeDocId) || state.docs[0] || null; }
function getIndex(doc) { if (!doc._index) doc._index = buildIndex(doc.chunks); return doc._index; }

/* -------------------------------------------------------------------------
   7a. Activity helpers (weak topics, card stats) shared by several views
   ------------------------------------------------------------------------- */
const weakKey = (docId, topic) => `${docId}::${String(topic).toLowerCase()}`;

function noteMiss(docId, topic) {
  const k = weakKey(docId, topic);
  const w = state.activity.weak[k] || { docId, topic, misses: 0, at: 0 };
  w.misses += 1; w.at = Date.now();
  state.activity.weak[k] = w;
  persist('activity');
}

function noteHit(docId, topic) {
  const k = weakKey(docId, topic);
  const w = state.activity.weak[k];
  if (!w) return;
  w.misses -= 1;
  if (w.misses <= 0) delete state.activity.weak[k];
  persist('activity');
}

const weakTopics = docId => Object.values(state.activity.weak)
  .filter(w => !docId || w.docId === docId)
  .sort((a, b) => b.misses - a.misses || b.at - a.at);

function cardsFor(docId) { return state.cards.filter(c => !docId || c.docId === docId); }
const isDue = c => c.due <= Date.now();

function updateDueBadge() {
  const n = state.cards.filter(isDue).length;
  const b = $('#nav-due');
  b.hidden = n === 0;
  b.textContent = String(n);
  b.setAttribute('aria-label', `${n} cards due`);
}

/* -------------------------------------------------------------------------
   7b. Navigation (3D card-flip transition between views)
   ------------------------------------------------------------------------- */
const VIEW_NAMES = ['dashboard', 'chat', 'exam', 'cards'];
let navToken = 0;

function go(view) {
  if (!state.user || !VIEW_NAMES.includes(view)) return;
  closeMenu();
  if (view === state.view) { RENDERERS[view](); return; }
  const token = ++navToken;
  const prev = $(`#view-${state.view}`);
  const swap = () => {
    if (token !== navToken) return;
    VIEW_NAMES.forEach(v => { const el = $(`#view-${v}`); el.hidden = v !== view; el.classList.remove('exit', 'enter'); });
    const next = $(`#view-${view}`);
    void next.offsetWidth;
    next.classList.add('enter');
    state.view = view;
    $$('.nav-item').forEach(b => {
      const on = b.dataset.go === view;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    RENDERERS[view]();
    window.scrollTo(0, 0);
    $('#app-main').focus({ preventScroll: true });
  };
  if (prev && !prev.hidden && !reduceMotion()) { prev.classList.add('exit'); setTimeout(swap, 260); } else swap();
}

function closeMenu() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}
function toggleMenu() {
  const open = !$('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}

/* -------------------------------------------------------------------------
   7c. Login
   ------------------------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function setFieldError(input, errEl, message) {
  errEl.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

function validateLogin() {
  const email = $('#email'), pw = $('#password');
  let ok = true;
  if (!email.value.trim()) { setFieldError(email, $('#email-err'), 'Enter your email address.'); ok = false; }
  else if (!EMAIL_RE.test(email.value.trim())) { setFieldError(email, $('#email-err'), 'That does not look like a valid email address.'); ok = false; }
  else setFieldError(email, $('#email-err'), '');
  if (!pw.value) { setFieldError(pw, $('#pw-err'), 'Enter a password.'); ok = false; }
  else if (pw.value.length < 6) { setFieldError(pw, $('#pw-err'), 'Use at least 6 characters.'); ok = false; }
  else setFieldError(pw, $('#pw-err'), '');
  if (!ok) ($('[aria-invalid="true"]') || email).focus();
  return ok;
}

function displayNameFromEmail(email) {
  const local = email.split('@')[0].split(/[._\-+]/)[0] || 'Student';
  return local.charAt(0).toUpperCase() + local.slice(1, 30);
}

async function enterApp(name, isGuest) {
  await ready;                                  // saved notes and progress finish loading first
  state.user = { name, guest: isGuest };
  burstBackground();
  const login = $('#login-screen');
  login.classList.add('leaving');
  await wait(reduceMotion() ? 0 : 650);
  login.hidden = true;
  login.classList.remove('leaving');
  document.body.classList.replace('is-login', 'is-app');
  $('#app').hidden = false;
  $('#who-line').textContent = isGuest ? 'Signed in as guest' : `Signed in as ${name}`;
  state.view = 'login';
  go('dashboard');
}

function signOut() {
  state.user = null;
  navToken++;
  $('#app').hidden = true;
  closeMenu();
  VIEW_NAMES.forEach(v => { $(`#view-${v}`).hidden = true; });
  $('#login-form').reset();
  setFieldError($('#email'), $('#email-err'), '');
  setFieldError($('#password'), $('#pw-err'), '');
  document.body.classList.replace('is-app', 'is-login');
  $('#login-screen').hidden = false;
  state.view = 'login';
  $('#email').focus();
}

function initLogin() {
  const form = $('#login-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!validateLogin()) return;
    const b = $('#login-btn');
    setBusy(b, true);
    await enterApp(displayNameFromEmail($('#email').value.trim()), false);
    setBusy(b, false);
  });
  $('#guest-btn').addEventListener('click', async () => {
    const b = $('#guest-btn');
    setBusy(b, true);
    await enterApp('Guest', true);
    setBusy(b, false);
  });
  const toggle = $('#pw-toggle');
  toggle.addEventListener('click', () => {
    const pw = $('#password');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  ['email', 'password'].forEach(id => $(`#${id}`).addEventListener('input', () => {
    if ($(`#${id}`).hasAttribute('aria-invalid')) validateLogin();
  }));
}

/* -------------------------------------------------------------------------
   7d. Dashboard
   ------------------------------------------------------------------------- */
function renderStorageNote() {
  const box = $('#storage-note');
  box.replaceChildren();
  box.className = 'banner';
  const msgs = [];
  if (state.serverOK === false) {
    box.classList.add('err');
    msgs.push(h('span', { text: `AI features are offline: ${state.serverMsg || 'the server is not reachable.'} PDF upload and flashcard review still work. ` }),
      h('button', { type: 'button', class: 'mini-btn', onclick: async e => { e.target.disabled = true; await checkServer(); toast(state.serverOK ? 'AI server connected.' : 'Still offline.', state.serverOK ? 'ok' : 'err'); } , text: 'Check again' }));
  } else if (storageStatus.lastSaveFailed) {
    msgs.push(h('span', { text: 'Your library is too large to save in this browser storage, so it will be lost when you close the page.' }));
  } else if (!hasWindowStorage()) {
    msgs.push(h('span', { text: 'Browser storage is not available here, so your notes, cards and progress last only until you close this page.' }));
  }
  box.hidden = msgs.length === 0;
  box.append(...msgs);
}

function stats() {
  const a = state.activity;
  const exams = a.exams;
  const avg = exams.length ? Math.round(exams.reduce((s, e) => s + (e.score / e.total) * 100, 0) / exams.length) : null;
  const mastered = state.cards.filter(c => c.stage >= CONFIG.REVIEW_DAYS.length).length;
  return { docs: state.docs.length, questions: a.questions, exams: exams.length, avg, reviews: a.cardReviews, cards: state.cards.length, mastered };
}

function renderDashboard() {
  const s = stats();
  $('#welcome-name').textContent = state.user ? state.user.name : 'there';
  const due = state.cards.filter(isDue).length;
  $('#welcome-sub').textContent = !state.docs.length
    ? 'Upload your first PDF to get started.'
    : due ? `You have ${due} flashcard${due === 1 ? '' : 's'} due for review.` : 'You are all caught up. Ask a question or take an exam.';
  renderStorageNote();

  // Progress ring: share of cards that have completed the 1-3-7 day ladder.
  const pct = s.cards ? Math.round((s.mastered / s.cards) * 100) : 0;
  $('#ring-fg').style.strokeDashoffset = String(326.73 * (1 - pct / 100));
  $('#ring-text').textContent = `${pct}%`;
  $('#ring').setAttribute('aria-label', `Cards mastered: ${pct} percent`);
  $('#ring-caption').textContent = s.cards ? `${s.mastered} of ${s.cards} cards mastered` : 'No flashcards yet';
  const list = $('#stat-list');
  list.replaceChildren(...[
    ['Documents', s.docs], ['Questions asked', s.questions], ['Exams taken', s.exams],
    ['Avg. exam score', s.avg === null ? '—' : `${s.avg}%`], ['Cards reviewed', s.reviews], ['Cards due', due]
  ].map(([k, v]) => h('div', null, h('dt', { text: k }), h('dd', { text: String(v) }))));

  // Recent documents
  const rec = $('#recent-docs');
  rec.replaceChildren();
  if (!state.docs.length) rec.append(h('li', { class: 'plain', text: 'No documents yet. Drop a PDF above.' }));
  state.docs.slice(0, 5).forEach(d => {
    let armed = false;
    const del = h('button', { type: 'button', class: 'mini-btn', text: 'Remove', 'aria-label': `Remove ${d.name}` });
    del.addEventListener('click', () => {
      if (!armed) { armed = true; del.textContent = 'Sure?'; setTimeout(() => { armed = false; del.textContent = 'Remove'; }, 3000); return; }
      removeDoc(d.id);
    });
    rec.append(h('li', null,
      h('span', { class: 'li-main' }, d.name, h('span', { class: 'li-sub', text: `${d.pages} pages · ${timeAgo(d.addedAt)}` })),
      h('span', { style: 'display:flex;gap:6px;flex:none' },
        h('button', { type: 'button', class: 'mini-btn', text: 'Chat', onclick: () => { state.activeDocId = d.id; go('chat'); } }), del)));
  });

  // Weak topics
  const wk = $('#weak-list');
  wk.replaceChildren();
  const weak = weakTopics().slice(0, 6);
  if (!weak.length) wk.append(h('li', { class: 'plain', text: 'None yet. Topics you miss in exams or flashcards appear here.' }));
  weak.forEach(w => {
    const doc = getDoc(w.docId);
    wk.append(h('li', null,
      h('span', { class: 'li-main' }, w.topic, h('span', { class: 'li-sub' }, doc ? doc.name : '', ' · ', h('span', { class: 'tag-weak', text: `missed ${w.misses}×` }))),
      doc ? h('button', { type: 'button', class: 'mini-btn', text: 'Make cards', onclick: e => generateCards(w.docId, { topics: [w.topic], button: e.currentTarget, thenGo: true }) }) : null));
  });

  // Reminders
  const rv = $('#reminder-list');
  rv.replaceChildren();
  if (due) rv.append(h('li', null, h('span', { class: 'li-main', text: `${due} flashcard${due === 1 ? '' : 's'} due now` }), h('button', { type: 'button', class: 'mini-btn', text: 'Review', onclick: () => go('cards') })));
  const byDay = new Map();
  state.cards.filter(c => !isDue(c)).sort((a, b) => a.due - b.due).forEach(c => { const k = dayLabel(c.due); byDay.set(k, (byDay.get(k) || 0) + 1); });
  [...byDay].slice(0, 3).forEach(([day, n]) => rv.append(h('li', null, h('span', { class: 'li-main', text: `${n} card${n === 1 ? '' : 's'} to revise` }), h('span', { class: 'li-sub', text: day }))));
  if (weak.length) rv.append(h('li', null, h('span', { class: 'li-main', text: `Revisit: ${weak[0].topic}` }), h('span', { class: 'tag-weak', text: 'weakest topic' })));
  if (!rv.children.length) rv.append(h('li', { class: 'plain', text: 'Nothing scheduled. Generate flashcards to build a revision plan.' }));
  updateDueBadge();
}

function removeDoc(id) {
  state.docs = state.docs.filter(d => d.id !== id);
  state.cards = state.cards.filter(c => c.docId !== id);
  for (const k of Object.keys(state.activity.weak)) if (state.activity.weak[k].docId === id) delete state.activity.weak[k];
  state.activity.exams = state.activity.exams.filter(e => e.docId !== id);
  delete state.chats[id];
  if (state.activeDocId === id) state.activeDocId = state.docs[0] ? state.docs[0].id : null;
  if (state.exam.docId === id) state.exam = { status: 'idle', docId: null, questions: [], answers: [], current: 0, error: '' };
  persist('docs'); persist('cards'); persist('activity');
  toast('Document removed.', 'ok');
  renderDashboard();
}

function initDropzone() {
  const dz = $('#dropzone'), input = $('#file-input');
  const open = () => input.click();
  dz.addEventListener('click', open);
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  input.addEventListener('change', () => handleFiles(input.files));
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => handleFiles(e.dataTransfer ? e.dataTransfer.files : []));
  // A missed drop must not make the browser navigate to the dropped file.
  ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => e.preventDefault()));
}

/* Populate a <select> with documents and keep the active one selected. */
function fillDocSelect(sel) {
  sel.replaceChildren(...state.docs.map(d => h('option', { value: d.id, text: d.name })));
  const cur = activeDoc();
  if (cur) sel.value = cur.id;
  sel.disabled = !state.docs.length;
}

/* -------------------------------------------------------------------------
   7e. Chat with notes
   ------------------------------------------------------------------------- */
const CITE_RE = /\[(?:p|pp|page|pages)\.?\s*[\d,\s\-–]+\]/gi;
const chatLog = id => (state.chats[id] = state.chats[id] || []);

function msgNode(m) {
  if (m.pending) {
    return h('div', { class: 'msg msg-bot', 'aria-label': 'Thinking' }, h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  }
  if (m.role === 'user') return h('div', { class: 'msg msg-user' }, h('p', { text: m.text }));
  const node = h('div', { class: `msg msg-bot${m.kind === 'error' ? ' err' : ''}` }, h('p', { text: m.text }));
  const meta = h('div', { class: 'msg-meta' });
  (m.pages || []).forEach(p => meta.append(h('span', { class: 'cite', text: `p. ${p}` })));
  if (typeof m.relevance === 'number') {
    const pct = meterPercent(m.relevance);
    meta.append(h('span', { class: 'meter', role: 'img', 'aria-label': `Retrieval relevance ${pct} percent` },
      'Relevance', h('span', { class: 'meter-track' }, h('i', { style: `width:${pct}%` })), `${pct}%`));
  }
  if (meta.children.length) node.append(meta);
  if (m.retry) node.append(btn('Try again', 'btn-ghost retry-btn', () => ask(m.retry.question, m)));
  return node;
}

function scrollChat() { const l = $('#chat-log'); l.scrollTop = l.scrollHeight; }

function renderChat() {
  const doc = activeDoc();
  const has = !!doc;
  $('#chat-empty').hidden = has;
  $('#chat-panel').hidden = !has;
  $('#chat-doc').hidden = !has;
  if (!has) return;
  fillDocSelect($('#chat-doc'));
  const log = $('#chat-log');
  log.replaceChildren(h('div', { class: 'msg msg-bot' },
    h('p', { text: `Ask me anything about “${doc.name}”. I answer only from your notes and cite the page numbers. You can ask in English, हिन्दी or Hinglish.` })));
  chatLog(doc.id).forEach(m => { m._el = msgNode(m); log.append(m._el); });
  scrollChat();
}

function setChatBusy(on) {
  state.busy.chat = on;
  setBusy($('#chat-send'), on);
  $('#chat-input').disabled = on;
  if (!on) $('#chat-input').focus({ preventScroll: true });
}

function refusalText(doc, r) {
  const near = r.results && r.results[0] ? ` The closest passage (${pageLabel(r.results[0].chunk.pages)}) is only a weak match.` : '';
  return `I couldn't find this in “${doc.name}”, so I won't guess.${near} Try rephrasing with words that appear in your notes, or pick another document.`;
}

async function ask(question, retryMsg) {
  const doc = activeDoc();
  if (!doc || state.busy.chat) return;
  const msgs = chatLog(doc.id);
  const log = $('#chat-log');
  if (retryMsg) {
    const i = msgs.indexOf(retryMsg);
    if (i >= 0) msgs.splice(i, 1);
    if (retryMsg._el) retryMsg._el.remove();
  } else {
    const um = { role: 'user', text: question };
    msgs.push(um); um._el = msgNode(um); log.append(um._el);
    state.activity.questions += 1;
    persist('activity');
  }
  const pending = { role: 'bot', pending: true };
  msgs.push(pending); pending._el = msgNode(pending); log.append(pending._el);
  scrollChat();
  setChatBusy(true);

  const finish = reply => {
    const i = msgs.indexOf(pending);
    if (i >= 0) msgs[i] = reply;
    reply._el = msgNode(reply);
    pending._el.replaceWith(reply._el);
    scrollChat();
  };

  try {
    // Questions written in Devanagari cannot be matched against English notes, so ask the
    // server for English search keywords first. (This is not an answer, and is skipped for Latin text.)
    let query = question;
    if (/[ऀ-ॿ]/.test(question) && doc.script !== 'dev') {
      const k = await api('/api/keywords', { question });
      query = (k.keywords || '').trim() || question;
    }
    const r = retrieve(getIndex(doc), query);
    if (!r.passes) {
      // Below the calibrated threshold: refuse locally, never call the AI.
      finish({ role: 'bot', kind: 'refusal', text: refusalText(doc, r), relevance: r.relevance });
      return;
    }
    const allowed = new Set(r.results.flatMap(x => x.chunk.pages));
    const res = await api('/api/chat', { question, chunks: r.results.map(x => ({ pages: x.chunk.pages, text: x.chunk.text })) });
    const raw = String(res.text || '').trim();
    if (!raw) throw new ApiError('The AI returned an empty reply.');
    if (/^NOT_IN_NOTES\b/.test(raw)) {
      finish({ role: 'bot', kind: 'refusal', relevance: r.relevance, text: `The passages I found don't actually answer this, so I won't guess. Try rephrasing, or check the closest pages: ${pageLabel([...allowed].slice(0, 4))}.` });
      return;
    }
    // Keep only citations that point at pages we really sent; strip any other marker.
    const cited = parseCitations(raw).filter(p => allowed.has(p));
    const text = raw.replace(CITE_RE, m => (parseCitations(m).every(p => allowed.has(p)) ? m : '')).replace(/[ \t]{2,}/g, ' ').trim();
    if (!cited.length) throw new ApiError('The AI answered without citing a page from your notes, so I discarded the answer. Please try again.');
    finish({ role: 'bot', kind: 'answer', text, pages: cited.sort((a, b) => a - b), relevance: r.relevance });
  } catch (e) {
    finish({ role: 'bot', kind: 'error', text: e.message || 'Something went wrong.', retry: { question } });
  } finally {
    setChatBusy(false);
  }
}

function initChat() {
  const input = $('#chat-input');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.busy.chat) return;
    input.value = ''; grow();
    ask(q);
  });
  $('#chat-doc').addEventListener('change', e => { state.activeDocId = e.target.value; renderChat(); });
}

/* -------------------------------------------------------------------------
   7f. AI generation shared by Exam Mode and Flashcards
   ------------------------------------------------------------------------- */
function shuf(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Choose up to n chunks: first the best match for each weak topic, then random others for coverage. */
function pickChunks(doc, n, topics = []) {
  const idx = getIndex(doc);
  const picked = new Map();
  for (const t of topics.slice(0, 2)) {
    const r = retrieve(idx, t, 1);
    if (r.results[0]) picked.set(r.results[0].chunk.id, r.results[0].chunk);
  }
  for (const c of shuf(doc.chunks)) {
    if (picked.size >= n) break;
    if (!picked.has(c.id)) picked.set(c.id, c);
  }
  return [...picked.values()].sort((a, b) => a.id - b.id);
}

const chunkPayload = chunks => chunks.map(c => ({ pages: c.pages, text: c.text }));

async function generateCards(docId, { topics = [], button = null, thenGo = false } = {}) {
  const doc = getDoc(docId);
  if (!doc) { toast('Upload a PDF first.', 'err'); return; }
  if (state.busy.cards) return;
  state.busy.cards = true;
  setBusy(button, true);
  const status = $('#cards-status');
  status.hidden = false; status.className = 'banner'; status.textContent = 'Writing flashcards from your notes…';
  try {
    const use = topics.length ? topics : weakTopics(docId).slice(0, 3).map(w => w.topic);
    const chunks = pickChunks(doc, 4, use);
    const existing = cardsFor(docId).map(c => c.front);
    const res = await api('/api/generate', { kind: 'cards', count: CONFIG.CARD_BATCH, chunks: chunkPayload(chunks), weakTopics: use, avoid: existing.slice(-40) });
    const raw = extractJson(res.text);
    if (raw == null) throw new ApiError('The AI reply could not be read as JSON. Please try again.');
    const v = validateCards(raw, chunks.flatMap(c => c.pages));
    if (!v.ok) throw new ApiError(v.error);
    const have = new Set(existing.map(f => f.toLowerCase()));
    const fresh = v.cards.filter(c => !have.has(c.front.toLowerCase()));
    if (!fresh.length) throw new ApiError('Those cards duplicated ones you already have. Try again for new ones.');
    const now = Date.now();
    fresh.forEach(c => state.cards.push({ id: uid(), docId, topic: c.topic, front: c.front, back: c.back, page: c.page, stage: 0, due: now, reviews: 0, lapses: 0, createdAt: now }));
    persist('cards');
    state.activeDocId = docId;
    status.hidden = true;
    toast(`${fresh.length} flashcards added.`, 'ok');
    updateDueBadge();
    if (thenGo || state.view === 'cards') go('cards');
  } catch (e) {
    status.hidden = false; status.className = 'banner err';
    status.textContent = `Could not create flashcards: ${e.message}`;
    toast(e.message || 'Could not create flashcards.', 'err', 7000);
  } finally {
    state.busy.cards = false;
    setBusy(button, false);
  }
}

/* -------------------------------------------------------------------------
   7g. Exam mode
   ------------------------------------------------------------------------- */
const LETTERS = ['A', 'B', 'C', 'D'];
const resetExam = () => { state.exam = { status: 'idle', docId: null, questions: [], answers: [], current: 0, error: '' }; };

async function startExam(docId) {
  const E = state.exam;
  const doc = getDoc(docId);
  if (!doc || E.status === 'loading') return;
  Object.assign(E, { status: 'loading', docId, questions: [], answers: [], current: 0, error: '', justAnswered: -1 });
  renderExam();
  try {
    const topics = weakTopics(docId).map(w => w.topic);
    const chunks = pickChunks(doc, 6, topics);
    const res = await api('/api/generate', { kind: 'exam', count: CONFIG.EXAM_QUESTIONS, chunks: chunkPayload(chunks), weakTopics: topics.slice(0, 3) });
    const raw = extractJson(res.text);
    if (raw == null) throw new ApiError('The AI reply could not be read as JSON. Please try again.');
    const v = validateExam(raw, chunks.flatMap(c => c.pages));
    if (!v.ok) throw new ApiError(v.error);
    Object.assign(E, { status: 'running', questions: v.questions, answers: v.questions.map(() => null), current: 0 });
  } catch (e) {
    Object.assign(E, { status: 'error', error: e.message || 'Could not create the exam.' });
  }
  renderExam();
}

function answerQuestion(idx) {
  const E = state.exam;
  if (E.status !== 'running' || E.answers[E.current] !== null) return;
  const q = E.questions[E.current];
  E.answers[E.current] = idx;
  E.justAnswered = E.current;
  if (idx === q.answerIndex) noteHit(E.docId, q.topic); else noteMiss(E.docId, q.topic);
  renderExam();
  const ex = $('#explain');
  if (ex) ex.focus({ preventScroll: true });
}

function finishExam() {
  const E = state.exam;
  const left = E.answers.map((a, i) => (a === null ? i + 1 : null)).filter(Boolean);
  if (left.length) { toast(`Answer every question first. Still open: ${left.join(', ')}.`, 'err'); return; }
  const score = E.questions.reduce((s, q, i) => s + (E.answers[i] === q.answerIndex ? 1 : 0), 0);
  E.score = score;
  E.status = 'done';
  state.activity.exams.push({ docId: E.docId, score, total: E.questions.length, at: Date.now() });
  persist('activity');
  renderExam();
}

function navExam(delta) {
  const E = state.exam;
  if (E.status !== 'running') return;
  const n = Math.max(0, Math.min(E.questions.length - 1, E.current + delta));
  if (n === E.current) return;
  E.current = n; E.justAnswered = -1;
  renderExam();
}

function renderExam() {
  const root = $('#exam-root');
  const E = state.exam;
  root.replaceChildren();

  if (!state.docs.length) {
    root.append(h('div', { class: 'empty glass' }, h('h2', { text: 'No notes yet' }), h('p', { class: 'muted', text: 'Upload a PDF to generate an exam.' }),
      btn('Go to upload', 'btn-primary', () => go('dashboard'))));
    return;
  }

  if (E.status === 'loading') {
    root.append(h('div', { class: 'exam-card glass loading-card', role: 'status' }, h('div', { class: 'loader3d' }), h('p', { text: 'Writing five questions from your notes…' }), h('p', { class: 'muted small', text: 'This usually takes 10–20 seconds.' })));
    return;
  }

  if (E.status === 'error') {
    root.append(h('div', { class: 'exam-card glass' }, h('h2', { text: 'The exam could not be created' }), h('p', { class: 'banner err', role: 'alert', text: E.error }),
      h('div', { class: 'exam-nav' }, btn('Back', 'btn-ghost', () => { resetExam(); renderExam(); }), btn('Try again', 'btn-primary', () => startExam(E.docId)))));
    return;
  }

  if (E.status === 'running') { root.append(renderQuestion()); return; }
  if (E.status === 'done') { root.append(renderExamResult()); return; }

  // idle
  const sel = h('select', { id: 'exam-doc', class: 'select', 'aria-label': 'Document for the exam' });
  fillDocSelect(sel);
  sel.addEventListener('change', () => { state.activeDocId = sel.value; renderExam(); });
  const doc = activeDoc();
  const weak = weakTopics(doc.id).slice(0, 3);
  const past = state.activity.exams.filter(e => e.docId === doc.id).slice(-3).reverse();
  root.append(h('div', { class: 'exam-card glass' },
    h('h2', { text: 'Ready when you are' }),
    h('p', { class: 'muted', text: '5 multiple-choice questions · 4 options each · explanations with page citations.' }),
    h('div', { class: 'field' }, h('label', { for: 'exam-doc', text: 'Document' }), sel),
    weak.length ? h('p', { class: 'banner', text: `Weak topics will be included: ${weak.map(w => w.topic).join(', ')}.` }) : null,
    past.length ? h('p', { class: 'muted small', text: `Recent scores: ${past.map(p => `${p.score}/${p.total}`).join(' · ')}` }) : null,
    state.serverOK === false ? h('p', { class: 'banner err', text: 'The AI server is offline right now, so the exam cannot be created.' }) : null,
    h('div', { class: 'exam-nav' }, h('span'), btn('Start exam', 'btn-violet', () => startExam(doc.id)))));
}

function renderQuestion() {
  const E = state.exam;
  const n = E.questions.length;
  const q = E.questions[E.current];
  const ans = E.answers[E.current];
  const answered = ans !== null;
  const doneCount = E.answers.filter(a => a !== null).length;
  const animate = E.justAnswered === E.current;

  const opts = q.options.map((text, i) => {
    let cls = 'option';
    if (answered) {
      if (i === q.answerIndex) cls += ' correct';
      else if (i === ans) cls += ' wrong';
      if (!animate) cls += ' still';
    }
    const b = h('button', { type: 'button', class: cls, 'aria-disabled': answered ? 'true' : null, 'aria-label': `Option ${LETTERS[i]}: ${text}${answered && i === q.answerIndex ? ' (correct answer)' : ''}${answered && i === ans && i !== q.answerIndex ? ' (your answer, incorrect)' : ''}` },
      h('span', { class: 'letter', text: LETTERS[i] }), h('span', { text }));
    b.addEventListener('click', () => answerQuestion(i));
    return b;
  });

  const right = answered && ans === q.answerIndex;
  const explain = answered ? h('div', { id: 'explain', class: `explain ${right ? 'good' : 'bad'}`, tabindex: '-1', role: 'status' },
    h('p', null, h('strong', { text: right ? 'Correct!' : `Not quite. The correct answer is ${LETTERS[q.answerIndex]}.` })),
    h('p', { text: q.explanation }),
    h('div', { class: 'msg-meta' }, h('span', { class: 'cite', text: `Source: p. ${q.page}` }), h('span', { class: 'chip', text: q.topic }))) : null;

  const last = E.current === n - 1;
  return h('div', { class: 'exam-card glass' },
    h('div', { class: 'exam-top' }, h('span', { class: 'chip', text: `Question ${E.current + 1} of ${n}` }), h('span', { class: 'muted small', text: `${doneCount} of ${n} answered` })),
    h('div', { class: 'exam-bar', role: 'progressbar', 'aria-label': 'Exam progress', 'aria-valuemin': '0', 'aria-valuemax': String(n), 'aria-valuenow': String(doneCount) }, h('i', { style: `width:${(doneCount / n) * 100}%` })),
    h('p', { class: 'q-text', id: 'q-text', text: q.question }),
    h('div', { class: 'options', role: 'group', 'aria-labelledby': 'q-text' }, opts),
    explain,
    h('div', { class: 'exam-nav' },
      btn('Previous', 'btn-ghost', () => navExam(-1), { disabled: E.current === 0 }),
      last ? btn('Finish exam', 'btn-primary', finishExam) : btn('Next', 'btn-violet', () => navExam(1))),
    h('p', { class: 'muted small', text: 'Keys: 1–4 or A–D to answer · ← → to move between questions' }));
}

function renderExamResult() {
  const E = state.exam;
  const n = E.questions.length;
  const pct = Math.round((E.score / n) * 100);
  const missed = [...new Set(E.questions.filter((q, i) => E.answers[i] !== q.answerIndex).map(q => q.topic))];
  const msg = pct === 100 ? 'Perfect score!' : pct >= 60 ? 'Good work. A little more practice will lock it in.' : 'These topics need more practice. They are now on your weak-topic list.';
  return h('div', { class: 'exam-card glass' },
    h('div', { class: 'center' }, h('p', { class: 'eyebrow', text: 'Your score' }), h('div', { class: 'score-big', text: `${E.score} / ${n}` }), h('p', { class: 'muted', text: `${pct}% · ${msg}` })),
    E.questions.map((q, i) => {
      const ok = E.answers[i] === q.answerIndex;
      return h('div', { class: `review-item ${ok ? 'good' : 'bad'}` },
        h('p', null, h('strong', { text: `${i + 1}. ${q.question}` })),
        h('p', { class: 'small', text: ok ? `Your answer: ${LETTERS[E.answers[i]]}. ${q.options[E.answers[i]]}` : `Your answer: ${LETTERS[E.answers[i]]}. ${q.options[E.answers[i]]}  ·  Correct: ${LETTERS[q.answerIndex]}. ${q.options[q.answerIndex]}` }),
        h('p', { class: 'muted small', text: q.explanation }),
        h('div', { class: 'msg-meta' }, h('span', { class: 'cite', text: `Source: p. ${q.page}` }), h('span', { class: 'chip', text: q.topic })));
    }),
    h('div', { class: 'exam-nav' },
      btn('Back to dashboard', 'btn-ghost', () => { resetExam(); go('dashboard'); }),
      missed.length ? btn('Make flashcards from missed topics', 'btn-warn', e => generateCards(E.docId, { topics: missed, button: e.currentTarget, thenGo: true })) : null,
      btn('New exam', 'btn-violet', () => startExam(E.docId))));
}

/* -------------------------------------------------------------------------
   7h. Flashcards (3D flip + spaced repetition 1 / 3 / 7 days)
   ------------------------------------------------------------------------- */
function buildQueue() {
  const doc = activeDoc();
  state.study.docId = doc ? doc.id : null;
  state.study.queue = doc ? cardsFor(doc.id).filter(isDue).sort((a, b) => a.due - b.due).map(c => c.id) : [];
  state.study.flipped = false;
}
const currentCard = () => state.cards.find(c => c.id === state.study.queue[0]) || null;

function renderCardStats() {
  const doc = activeDoc();
  const mine = doc ? cardsFor(doc.id) : [];
  const due = mine.filter(isDue).length;
  $('#t-due').textContent = String(due);
  $('#t-upcoming').textContent = String(mine.length - due);
  $('#t-total').textContent = String(mine.length);

  const hard = new Map();
  mine.forEach(c => { if (c.lapses > 0) hard.set(c.topic, (hard.get(c.topic) || 0) + c.lapses); });
  weakTopics(doc && doc.id).forEach(w => hard.set(w.topic, (hard.get(w.topic) || 0) + w.misses));
  const hardList = [...hard].sort((a, b) => b[1] - a[1]);
  $('#t-hard').textContent = String(hardList.length);

  const up = $('#upcoming-list'); up.replaceChildren();
  const byDay = new Map();
  mine.filter(c => !isDue(c)).sort((a, b) => a.due - b.due).forEach(c => { const k = dayLabel(c.due); byDay.set(k, (byDay.get(k) || 0) + 1); });
  if (!byDay.size) up.append(h('li', { class: 'plain', text: 'No reviews scheduled yet.' }));
  [...byDay].slice(0, 6).forEach(([d, n]) => up.append(h('li', null, h('span', { class: 'li-main', text: d }), h('span', { class: 'muted small', text: `${n} card${n === 1 ? '' : 's'}` }))));

  const hl = $('#hard-list'); hl.replaceChildren();
  if (!hardList.length) hl.append(h('li', { class: 'plain', text: 'Nothing difficult so far.' }));
  hardList.slice(0, 6).forEach(([t, n]) => hl.append(h('li', null, h('span', { class: 'li-main', text: t }), h('span', { class: 'tag-weak', text: `${n} slip${n === 1 ? '' : 's'}` }))));
}

function setFlipped(on) {
  state.study.flipped = on;
  $('#flip-card').classList.toggle('flipped', on);
  $('#face-front').setAttribute('aria-hidden', String(on));
  $('#face-back').setAttribute('aria-hidden', String(!on));
  $('#know-btn').disabled = !on;
  $('#more-btn').disabled = !on;
  $('#flip-btn').querySelector('.btn-label').textContent = on ? 'Show question' : 'Flip card';
  $('#flip-card').setAttribute('aria-label', on ? 'Showing answer. Press to show the question.' : 'Showing question. Press to reveal the answer.');
}

function renderStudy() {
  const empty = $('#study-empty'), stage = $('#study-stage');
  const doc = activeDoc();
  const mine = doc ? cardsFor(doc.id) : [];
  const card = currentCard();
  empty.replaceChildren();
  if (!doc) {
    stage.hidden = true; empty.hidden = false;
    empty.append(h('h2', { text: 'No notes yet' }), h('p', { class: 'muted', text: 'Upload a PDF, then generate flashcards from it.' }), btn('Go to upload', 'btn-primary', () => go('dashboard')));
    return;
  }
  if (!mine.length) {
    stage.hidden = true; empty.hidden = false;
    empty.append(h('h2', { text: 'No flashcards yet' }), h('p', { class: 'muted', text: `Create a set of cards from “${doc.name}”. Topics you struggle with are included automatically.` }),
      btn('Generate cards', 'btn-primary', e => generateCards(doc.id, { button: e.currentTarget })));
    return;
  }
  if (!card) {
    const next = Math.min(...mine.map(c => c.due));
    stage.hidden = true; empty.hidden = false;
    empty.append(h('h2', { text: 'All caught up!' }),
      h('p', { class: 'muted', text: `Next review: ${dayLabel(next)}${dayLabel(next) === 'Today' ? '' : ' at ' + new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` }),
      btn('Generate more cards', 'btn-ghost', e => generateCards(doc.id, { button: e.currentTarget })));
    return;
  }
  empty.hidden = true; stage.hidden = false;
  $('#study-topic').textContent = card.topic;
  $('#study-progress').textContent = `${state.study.queue.length} due · step ${Math.min(card.stage + 1, 3)} of 3`;
  $('#card-front').textContent = card.front;
  $('#card-back').textContent = card.back;
  $('#card-cite-front').textContent = pageLabel([card.page]);
  $('#card-cite-back').textContent = pageLabel([card.page]);
  setFlipped(false);
}

function renderCards() {
  const sel = $('#cards-doc');
  fillDocSelect(sel);
  sel.hidden = !state.docs.length;
  $('#gen-cards-btn').disabled = !state.docs.length;
  if (state.serverOK !== false) { const s = $('#cards-status'); if (!state.busy.cards) s.hidden = true; }
  buildQueue();
  renderCardStats();
  renderStudy();
  updateDueBadge();
}

function flipCard() {
  if (state.study.busy || !currentCard()) return;
  setFlipped(!state.study.flipped);
}

async function rateCard(known) {
  const S = state.study;
  const card = currentCard();
  if (!card || !S.flipped || S.busy) return;
  S.busy = true;
  const i = state.cards.findIndex(c => c.id === card.id);
  state.cards[i] = scheduleCard(card, known);
  state.activity.cardReviews += 1;
  if (known) noteHit(card.docId, card.topic); else noteMiss(card.docId, card.topic);
  persist('cards'); persist('activity');
  updateDueBadge();
  S.queue.shift();
  if (!known) S.queue.push(card.id);                // practise again at the end of this session
  renderCardStats();
  $('#flip-card').classList.remove('flipped');       // flip back first so the next answer is never visible
  $('#know-btn').disabled = true; $('#more-btn').disabled = true;
  await wait(reduceMotion() ? 0 : 450);
  S.busy = false;
  S.flipped = false;
  renderStudy();
}

/* -------------------------------------------------------------------------
   8. Boot
   ------------------------------------------------------------------------- */
const RENDERERS = { dashboard: renderDashboard, chat: renderChat, exam: renderExam, cards: renderCards };

async function loadState() {
  const docs = await storeGet(KEYS.docs, []);
  const cards = await storeGet(KEYS.cards, []);
  const act = await storeGet(KEYS.activity, null);
  state.docs = Array.isArray(docs) ? docs.filter(d => d && d.id && Array.isArray(d.chunks)) : [];
  state.cards = Array.isArray(cards) ? cards.filter(c => c && c.id && c.front && c.back) : [];
  if (act && typeof act === 'object') {
    state.activity = {
      questions: Number(act.questions) || 0,
      cardReviews: Number(act.cardReviews) || 0,
      exams: Array.isArray(act.exams) ? act.exams : [],
      weak: act.weak && typeof act.weak === 'object' ? act.weak : {}
    };
  }
  state.activeDocId = state.docs[0] ? state.docs[0].id : null;
}

function onKeydown(e) {
  if (e.key === 'Escape') { closeMenu(); return; }
  if (!state.user || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (state.view === 'cards' && !$('#study-stage').hidden) {
    const onFlipCard = t && t.id === 'flip-card';
    if (e.key === ' ' || e.key === 'Enter') {
      if (tag === 'BUTTON' || tag === 'A') return;          // let real buttons behave natively
      if (e.key === 'Enter' && !onFlipCard) return;
      e.preventDefault(); flipCard();
    } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'k') { e.preventDefault(); rateCard(true); }
    else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'p') { e.preventDefault(); rateCard(false); }
  } else if (state.view === 'exam' && state.exam.status === 'running') {
    const k = e.key.toLowerCase();
    const i = '1234'.indexOf(k) >= 0 && k.length === 1 ? '1234'.indexOf(k) : 'abcd'.indexOf(k);
    if (k.length === 1 && i >= 0) { e.preventDefault(); answerQuestion(i); }
    else if (e.key === 'ArrowRight') navExam(1);
    else if (e.key === 'ArrowLeft') navExam(-1);
  }
}

let ready = Promise.resolve();

function boot() {
  window.addEventListener('error', e => { console.error(e.error || e.message); toast('Unexpected error: ' + (e.message || 'see browser console'), 'err', 8000); });
  initLogin();
  initDropzone();
  initChat();

  // Delegated clicks for navigation and simple actions.
  document.addEventListener('click', e => {
    const goEl = e.target.closest('[data-go]');
    if (goEl) { go(goEl.dataset.go); return; }
    const act = e.target.closest('[data-action]');
    if (!act) return;
    switch (act.dataset.action) {
      case 'signout': signOut(); break;
      case 'gen-cards': { const d = activeDoc(); if (d) generateCards(d.id, { button: act }); else toast('Upload a PDF first.', 'err'); break; }
      case 'card-flip': flipCard(); break;
      case 'card-know': rateCard(true); break;
      case 'card-more': rateCard(false); break;
      default: break;
    }
  });
  $('#menu-btn').addEventListener('click', toggleMenu);
  $('#scrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', onKeydown);

  const flip = $('#flip-card');
  flip.setAttribute('role', 'button');
  flip.setAttribute('tabindex', '0');
  flip.addEventListener('click', flipCard);
  $('#cards-doc').addEventListener('change', e => { state.activeDocId = e.target.value; renderCards(); });

  window.addEventListener('unhandledrejection', e => {
    console.error(e.reason);
    toast('Something unexpected went wrong. Please try again.', 'err');
  });

  initTilt();
  initBackground();
  const failBanner = document.getElementById('load-fail');
  if (failBanner) failBanner.remove();          // the app started, so hide the "did not start" warning
  ready = loadState().then(() => { updateDueBadge(); }).catch(() => {});
  ready.then(checkServer);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

/* Test hook for Node (ignored in the browser). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONFIG, tokenize, pageLabel, chunkPages, buildIndex, retrieve, meterPercent, extractJson, validateExam, validateCards, parseCitations, scheduleCard, sampleChunks };
}

})();
