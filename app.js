// こえログ：ワンタッチ録音＋スマホ内での文字起こし
const $ = (s) => document.querySelector(s);

// 複数の計算ライン（スレッド）で処理するには「クロスオリジン分離」が必要。
// GitHub Pages では設定できないため Service Worker が必要な設定を付け、初回だけ自動で再読み込みする。
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(async () => {
    if (window.crossOriginIsolated) return;
    await navigator.serviceWorker.ready;
    let tried = true;
    try { tried = sessionStorage.getItem('koelog.coi') === '1'; sessionStorage.setItem('koelog.coi', '1'); } catch (_) { /* 保存できない環境では再読み込みしない */ }
    if (!tried && !session) location.reload();
  }).catch(() => {});
}
// 区切り方 [区切りを探し始める秒数, 必ず区切る秒数]
// 録音中は処理が追いついている間は短く区切って早く文字を出し、遅れてきたら長めに区切って負担を減らす
const SEG_FAST = [5, 9];
const SEG_SLOW = [18, 25];
const SEG_FILE = [18, 25]; // 録音済みの音声をまとめて文字起こしするとき
const SILENCE_RMS = 0.004;
const DEFAULT_MODEL = 'onnx-community/whisper-base';

// ---------- 保存（このブラウザの IndexedDB にだけ保存） ----------
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open('koelog', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('recs', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function dbTx(mode, fn) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recs', mode);
    const out = fn(tx.objectStore('recs'));
    tx.oncomplete = () => resolve(out && out.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbPut = (r) => dbTx('readwrite', (s) => s.put(toStored(r)));
const dbDel = (id) => dbTx('readwrite', (s) => s.delete(id));
const dbAll = () => dbTx('readonly', (s) => s.getAll());
function toStored(r) {
  return { id: r.id, title: r.title, createdAt: r.createdAt, duration: r.duration,
    mime: r.mime, audio: r.audio, segments: r.segments.map((g) => ({ ...g })) };
}

// ---------- 設定 ----------
function lsGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 保存できない環境 */ } }
let model = lsGet('koelog.model', DEFAULT_MODEL);
const loadedModels = () => JSON.parse(lsGet('koelog.loaded', '[]'));
function markLoaded(m) { const a = loadedModels(); if (!a.includes(m)) { a.push(m); lsSet('koelog.loaded', JSON.stringify(a)); } }

// ---------- 文字起こしAI（Web Worker） ----------
const worker = new Worker('worker.js', { type: 'module' });
let ai = { state: 'none', model: null, device: null, error: '' };
const fileProgress = new Map();
const jobs = new Map(); // jobId -> { rec, idx, rms }
let jobSeq = 0;

function ensureModel() {
  if ((ai.state === 'ready' || ai.state === 'loading') && ai.model === model) return;
  ai = { state: 'loading', model, device: null, error: '' };
  fileProgress.clear();
  worker.postMessage({ type: 'load', model });
  renderAi();
}

worker.onerror = (e) => {
  ai = { state: 'error', model, device: null, error: (e && e.message) || 'AIの部品を読み込めませんでした' };
  renderAi();
};
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') {
    if (m.file && m.total) fileProgress.set(m.file, { loaded: m.loaded || 0, total: m.total });
    if (m.file && m.status === 'done' && fileProgress.has(m.file)) {
      const f = fileProgress.get(m.file); f.loaded = f.total;
    }
    renderAi();
  } else if (m.type === 'ready') {
    ai = { state: 'ready', model: m.model, device: m.device, threads: m.threads, error: '' };
    markLoaded(m.model);
    renderAi();
  } else if (m.type === 'error') {
    ai = { state: 'error', model, device: null, error: m.message };
    renderAi();
  } else if (m.type === 'result') {
    onResult(m);
  }
};

function onResult({ id, text, error }) {
  const job = jobs.get(id);
  if (!job) return; // 取り消された処理
  jobs.delete(id);
  const seg = job.rec.segments[job.idx];
  let t = (text || '').trim();
  // 静かな区間で出やすい決まり文句を取り除く
  if (job.rms < 0.02 && /^(ご視聴ありがとうございました|ありがとうございました|字幕.*)[。.!！]?$/.test(t)) t = '';
  seg.text = t;
  seg.status = error ? 'failed' : (t ? 'done' : 'silent');
  if (job.rec.saved) dbPut(job.rec);
  refreshRecord(job.rec);
}

// ---------- 音声処理 ----------
function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length || 1)); }
function resample(a, from) {
  if (from === 16000) return a.slice();
  const ratio = from / 16000;
  const out = new Float32Array(Math.floor(a.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const s = Math.floor(i * ratio), e = Math.min(a.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = s; j < e; j++) sum += a[j];
    out[i] = sum / Math.max(1, e - s);
  }
  return out;
}
// lo〜hi サンプルの範囲で一番静かな位置（言葉の切れ目）を探す
function quietestPoint(a, sr, lo, hi) {
  const w = Math.floor(sr * 0.1), step = Math.floor(w / 2);
  let best = hi, bestE = Infinity;
  for (let s = lo; s + w <= hi; s += step) {
    let e = 0; for (let i = s; i < s + w; i++) e += a[i] * a[i];
    if (e < bestE) { bestE = e; best = s + step; }
  }
  return best;
}
function enqueue(rec, pcm, sr, start, end) {
  const idx = rec.segments.length;
  const audio = resample(pcm, sr);
  const level = rms(audio);
  const silent = level < SILENCE_RMS || audio.length < 8000;
  rec.segments.push({ start, end, text: '', status: silent ? 'silent' : 'pending' });
  if (!silent) {
    const id = ++jobSeq;
    jobs.set(id, { rec, idx, rms: level });
    ensureModel();
    worker.postMessage({ type: 'transcribe', id, audio, model }, [audio.buffer]);
  }
}
// 長い音声を、言葉の切れ目で区切りながら順番に文字起こしへ回す
function enqueueAll(rec, a, sr, offsetSec) {
  let pos = 0;
  const [lo, hi] = SEG_FILE;
  while (a.length - pos > hi * sr) {
    const cut = quietestPoint(a, sr, pos + lo * sr, pos + hi * sr);
    enqueue(rec, a.subarray(pos, cut), sr, offsetSec + pos / sr, offsetSec + cut / sr);
    pos = cut;
  }
  if (a.length - pos > 0) enqueue(rec, a.subarray(pos), sr, offsetSec + pos / sr, offsetSec + a.length / sr);
}

// ---------- 録音 ----------
let session = null;
const open = new Map(); // id -> record（メモリ上）
let wakeLock = null;

function pickMime() {
  for (const t of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}
function defaultTitle(d = new Date()) {
  return `録音 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function startRec() {
  if (session) return;
  if (!navigator.mediaDevices || !window.AudioWorkletNode) {
    toast('このブラウザは録音に対応していません'); return;
  }
  // iPhone ではタップの直後に作らないと音が取れないため、先に作る
  let ctx = new AudioContext({ sampleRate: 16000 });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (_) {
    ctx.close();
    toast('マイクを使えません。ブラウザの設定でマイクを許可してください');
    return;
  }
  let src;
  try { src = ctx.createMediaStreamSource(stream); } catch (_) {
    ctx.close(); ctx = new AudioContext(); src = ctx.createMediaStreamSource(stream);
  }
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const node = new AudioWorkletNode(ctx, 'pcm-tap');
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);

  const mime = pickMime();
  let mr = null; const chunks = [];
  if (window.MediaRecorder) {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.start(1000);
  }
  const rec = { id: Date.now(), title: defaultTitle(), createdAt: Date.now(), duration: 0,
    mime: (mr && mr.mimeType) || mime, audio: null, segments: [], saved: false };
  open.set(rec.id, rec);
  session = { rec, ctx, src, node, stream, mr, chunks, sr: ctx.sampleRate, pcm: [], pcmLen: 0, cut: 0, paused: false, levels: new Array(60).fill(0) };
  node.port.onmessage = (e) => onPcm(e.data);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) { wakeLock = null; }

  $('#live').replaceChildren();
  setPaused(false);
  show('rec');
  ensureModel();
  renderLive();
  drawWave();
}

function onPcm(block) {
  const s = session; if (!s) return;
  s.levels.shift(); s.levels.push(s.paused ? 0 : rms(block));
  if (s.paused) return;
  s.pcm.push(block); s.pcmLen += block.length;
  if (s.pcmLen >= segRange()[1] * s.sr) cutSegment(false);
}
function cutSegment(final) {
  const s = session; if (!s || !s.pcmLen) return;
  const all = new Float32Array(s.pcmLen);
  let o = 0; for (const b of s.pcm) { all.set(b, o); o += b.length; }
  const [lo, hi] = segRange();
  const cut = final ? all.length : quietestPoint(all, s.sr, lo * s.sr, hi * s.sr);
  const rest = all.slice(cut);
  s.pcm = rest.length ? [rest] : []; s.pcmLen = rest.length;
  const start = s.cut / s.sr; s.cut += cut;
  enqueue(s.rec, all.subarray(0, cut), s.sr, start, s.cut / s.sr);
  renderLive();
}
function segRange() {
  const backlog = [...jobs.values()].filter((j) => session && j.rec === session.rec).length;
  return backlog >= 2 ? SEG_SLOW : SEG_FAST;
}
function elapsed() { const s = session; return s ? (s.cut + s.pcmLen) / s.sr : 0; }

function setPaused(p) {
  if (session) {
    session.paused = p;
    if (session.mr) { try { p ? session.mr.pause() : session.mr.resume(); } catch (_) { /* 状態の行き違い */ } }
  }
  $('#rec-head').classList.toggle('paused', p);
  $('#rec-state').textContent = p ? '一時停止中' : '録音中';
  $('#pause-label').textContent = p ? '再開' : '一時停止';
}

async function stopRec() {
  const s = session; if (!s) return;
  cutSegment(true);
  session = null;
  s.node.port.onmessage = null;
  try { s.src.disconnect(); s.node.disconnect(); } catch (_) { /* 切断済み */ }
  s.ctx.close();
  if (s.mr && s.mr.state !== 'inactive') {
    await new Promise((r) => { s.mr.onstop = r; s.mr.stop(); });
  }
  s.stream.getTracks().forEach((t) => t.stop());
  try { await wakeLock?.release(); } catch (_) { /* 解放済み */ }
  wakeLock = null;
  const rec = s.rec;
  rec.duration = s.cut / s.sr;
  rec.audio = s.chunks.length ? new Blob(s.chunks, { type: rec.mime || 'audio/webm' }) : null;
  rec.saved = true;
  await dbPut(rec);
  openDetail(rec.id);
}

// ---------- 画面 ----------
let currentView = 'home';
let detailId = null;
function show(name) {
  currentView = name;
  for (const v of ['home', 'rec', 'detail', 'settings']) $('#v-' + v).hidden = v !== name;
  window.scrollTo(0, 0);
}
function fmt(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); }
function fmtDate(t) { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function segNodes(rec) {
  return rec.segments.filter((g) => g.status !== 'silent').map((g) => {
    const box = el('div', 'seg ' + g.status);
    box.append(el('span', 'ts', fmt(g.start)));
    const body = g.status === 'pending' ? '文字起こし中…' : g.status === 'failed' ? '（文字起こしできませんでした）' : g.text;
    box.append(el('span', 'body', body));
    return box;
  });
}
function renderLive() {
  if (!session) return;
  const live = $('#live');
  const nodes = segNodes(session.rec);
  nodes.push(el('div', 'seg pending'));
  nodes[nodes.length - 1].append(el('span', 'body', ai.state === 'loading' ? 'AIを準備しています…（録音は続いています）' : '聞き取り中…'));
  live.replaceChildren(...nodes);
  live.scrollTop = live.scrollHeight;
}
function refreshRecord(rec) {
  if (session && session.rec === rec) renderLive();
  if (currentView === 'detail' && detailId === rec.id) renderDetail(rec);
}

async function renderList() {
  const recs = (await dbAll()).sort((a, b) => b.createdAt - a.createdAt);
  const list = $('#list');
  list.replaceChildren(...recs.map((r) => {
    const b = el('button', 'item'); b.type = 'button';
    const preview = r.segments.map((g) => g.text).join('').slice(0, 30);
    b.append(el('b', null, r.title), el('span', 'meta', fmtDate(r.createdAt) + (preview ? ' · ' + preview : '')), el('span', 'dur', fmt(r.duration)));
    b.onclick = () => openDetail(r.id);
    return b;
  }));
  $('#empty').hidden = recs.length > 0;
}

let audioUrl = null;
async function openDetail(id) {
  let rec = open.get(id);
  if (!rec) {
    const all = await dbAll();
    const r = all.find((x) => x.id === id); if (!r) return;
    rec = { ...r, saved: true }; open.set(id, rec);
  }
  detailId = id;
  $('#d-title').value = rec.title;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = rec.audio ? URL.createObjectURL(rec.audio) : null;
  const a = $('#d-audio'); a.hidden = !audioUrl; if (audioUrl) a.src = audioUrl; else a.removeAttribute('src');
  disarmDelete();
  renderDetail(rec);
  show('detail');
}
function renderDetail(rec) {
  $('#d-meta').textContent = `${fmtDate(rec.createdAt)} · ${fmt(rec.duration)}`;
  const pending = rec.segments.filter((g) => g.status === 'pending');
  const active = [...jobs.values()].filter((j) => j.rec === rec).length;
  const st = $('#d-status');
  if (active) { st.hidden = false; st.textContent = `文字起こし中… 残り ${active} 区間`; }
  else if (pending.length) { st.hidden = false; st.textContent = '文字起こしが途中で止まっています。「もう一度文字起こし」を押してください。'; }
  else st.hidden = true;
  const nodes = segNodes(rec).map((n) => { if (n.classList.contains('pending') && !active) n.lastChild.textContent = '（未処理）'; return n; });
  if (!nodes.length) nodes.push(el('p', 'empty', active ? '' : '文字にできる声が見つかりませんでした。'));
  $('#d-text').replaceChildren(...nodes);
  $('#btn-redo').disabled = !rec.audio || active > 0;
}
function currentRec() { return open.get(detailId); }
function toText(rec) {
  const lines = rec.segments.filter((g) => g.status === 'done').map((g) => `[${fmt(g.start)}] ${g.text}`);
  return `${rec.title}\n${fmtDate(rec.createdAt)}（${fmt(rec.duration)}）\n\n${lines.join('\n')}\n`;
}

async function redo(rec) {
  if (!rec.audio) return;
  for (const [id, j] of jobs) if (j.rec === rec) jobs.delete(id);
  rec.segments = [];
  renderDetail(rec);
  $('#d-status').hidden = false; $('#d-status').textContent = '音声を読み込んでいます…';
  let buf;
  try {
    const c = new AudioContext({ sampleRate: 16000 });
    try { buf = await c.decodeAudioData(await rec.audio.arrayBuffer()); } finally { c.close(); }
  } catch (_) {
    try {
      const c = new AudioContext();
      try { buf = await c.decodeAudioData(await rec.audio.arrayBuffer()); } finally { c.close(); }
    } catch (e) { toast('この音声は読み込めませんでした'); renderDetail(rec); return; }
  }
  let mono = buf.getChannelData(0);
  if (buf.numberOfChannels > 1) {
    const r = buf.getChannelData(1); const m = new Float32Array(mono.length);
    for (let i = 0; i < m.length; i++) m[i] = (mono[i] + r[i]) / 2; mono = m;
  }
  enqueueAll(rec, mono, buf.sampleRate, 0);
  await dbPut(rec);
  renderDetail(rec);
}

function renderAi() {
  const card = $('#ai-card'), title = $('#ai-title'), sub = $('#ai-sub'), btn = $('#btn-load'), prog = $('#ai-progress');
  card.classList.toggle('ready', ai.state === 'ready');
  prog.hidden = ai.state !== 'loading';
  btn.hidden = ai.state === 'loading' || ai.state === 'ready';
  if (ai.state === 'loading') {
    let l = 0, t = 0; for (const f of fileProgress.values()) { l += f.loaded; t += f.total; }
    const pct = t ? Math.min(100, Math.round((l / t) * 100)) : 0;
    title.textContent = `文字起こしAIを準備中… ${pct}%`;
    sub.textContent = t ? `${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB（2回目からはダウンロード不要です）` : 'しばらくお待ちください';
    $('#ai-bar').style.width = pct + '%';
  } else if (ai.state === 'ready') {
    title.textContent = '文字起こしAI：準備OK';
  } else if (ai.state === 'error') {
    title.textContent = 'AIの準備に失敗しました';
    sub.textContent = '通信状態を確認して、もう一度お試しください。（' + ai.error.slice(0, 80) + '）';
    btn.textContent = 'もう一度';
  } else {
    title.textContent = '文字起こしAIの準備';
    sub.textContent = '最初の1回だけAIをダウンロードします（Wi-Fi推奨）。録音した音声はスマホの外に送られません。';
    btn.textContent = 'ダウンロード';
  }
  $('#device-info').textContent = ai.state === 'ready'
    ? `現在の処理方式：${ai.device === 'webgpu' ? 'WebGPU（速い）' : `WASM（CPU・${ai.threads || 1}スレッド）`}` : '';
  if (session) renderLive();
}

// 録音中の波形
let raf = 0;
function drawWave() {
  cancelAnimationFrame(raf);
  const cv = $('#wave'), cx = cv.getContext('2d');
  const tick = () => {
    if (!session) return;
    const cs = getComputedStyle(document.documentElement);
    const rec = cs.getPropertyValue('--rec').trim(), line = cs.getPropertyValue('--line').trim();
    cx.clearRect(0, 0, cv.width, cv.height);
    session.levels.forEach((v, i) => {
      const h = Math.max(4, Math.min(cv.height, v * 900));
      cx.fillStyle = session.paused ? line : rec;
      cx.fillRect(i * 10, (cv.height - h) / 2, 6, h);
    });
    $('#timer').textContent = fmt(elapsed());
    raf = requestAnimationFrame(tick);
  };
  tick();
}

let toastTimer;
function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 2200); }

let deleteTimer;
function disarmDelete() { clearTimeout(deleteTimer); const b = $('#btn-delete'); b.classList.remove('armed'); b.textContent = '削除'; }

// ---------- 操作 ----------
$('#btn-rec').onclick = () => startRec().catch((e) => { toast('録音を開始できませんでした'); console.error(e); });
$('#btn-stop').onclick = () => stopRec().catch((e) => { toast('保存に失敗しました'); console.error(e); });
$('#btn-pause').onclick = () => setPaused(!(session && session.paused));
$('#btn-load').onclick = () => { ai.state = 'none'; ensureModel(); };
$('#btn-settings').onclick = () => { $('#model').value = model; renderAi(); show('settings'); };
$('#btn-back').onclick = () => { show('home'); renderList(); };
$('#btn-back2').onclick = () => show('home');
$('#model').onchange = (e) => {
  model = e.target.value; lsSet('koelog.model', model);
  if (loadedModels().includes(model)) ensureModel();
  else { ai = { state: 'none', model: null, device: null, error: '' }; renderAi(); }
};
$('#d-title').onchange = (e) => { const r = currentRec(); if (!r) return; r.title = e.target.value.trim() || defaultTitle(new Date(r.createdAt)); dbPut(r); };
$('#btn-copy').onclick = async () => {
  const r = currentRec(); if (!r) return;
  try { await navigator.clipboard.writeText(toText(r)); toast('テキストをコピーしました'); } catch (_) { toast('コピーできませんでした'); }
};
$('#btn-share').onclick = async () => {
  const r = currentRec(); if (!r) return;
  if (navigator.share) { try { await navigator.share({ title: r.title, text: toText(r) }); } catch (_) { /* キャンセル */ } }
  else $('#btn-copy').click();
};
$('#btn-export').onclick = () => {
  const r = currentRec(); if (!r) return;
  const url = URL.createObjectURL(new Blob([toText(r)], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: r.title.replace(/[\\/:*?"<>|]/g, '_') + '.txt' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('テキストを保存しました');
};
$('#btn-redo').onclick = () => { const r = currentRec(); if (r) redo(r); };
$('#btn-delete').onclick = async () => {
  const b = $('#btn-delete');
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); b.textContent = 'もう一度押すと削除';
    deleteTimer = setTimeout(disarmDelete, 3000); return;
  }
  disarmDelete();
  const r = currentRec(); if (!r) return;
  for (const [id, j] of jobs) if (j.rec === r) jobs.delete(id);
  await dbDel(r.id); open.delete(r.id);
  toast('削除しました'); show('home'); renderList();
};

// ---------- 起動 ----------
renderAi();
renderList();
if (loadedModels().includes(model)) ensureModel(); // 以前ダウンロード済みなら保存分から読み込む
