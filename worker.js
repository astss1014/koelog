// 文字起こし担当（Whisper をブラウザの中で動かす）。音声はこのスマホから外へ送らない。
// 外部のサイトからプログラムを読み込まないよう、ライブラリはアプリ内（vendor/）に同梱している
import { pipeline, env, AutoProcessor, AutoModelForAudioFrameClassification } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // 一度ダウンロードしたAIはブラウザに保存して再利用
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;

// 使ってよいAIと、その版（中身が勝手に差し替わらないよう版を固定する）
const REVISIONS = {
  'onnx-community/whisper-tiny': 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  'onnx-community/whisper-base': '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
  'onnx-community/whisper-small': '36050c46d777d46dc4b5f43f6d90574fc38f8732',
  'onnx-community/whisper-large-v3-turbo': '360ebcde2559d60bb474678be3c1de9ef347d01a',
};
// 話者を区別するAI（pyannote segmentation 3.0、約6MB）
const DIA_MODEL = 'onnx-community/pyannote-segmentation-3.0';
const DIA_REVISION = '733a93b6473d019a773298e08cefa686894b1854';
// クロスオリジン分離されていれば、CPUの複数の計算ラインを使って速くする
const single = new URL(self.location.href).searchParams.get('t') === '1';
const threads = self.crossOriginIsolated && !single
  ? Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 4) - 1))
  : 1;
env.backends.onnx.wasm.numThreads = threads;

let asr = null;
let currentModel = null;
let loading = null;
let queue = Promise.resolve();

async function pickDevice() {
  try {
    if (self.navigator.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (_) { /* WebGPU なし */ }
  return 'wasm';
}

// CPU（WASM）で使う計算の方式。機種によっては 8bit 方式で計算が壊れて「!!!!」になるため、
// そうなったら次の方式に切り替えてやり直す
const WASM_DTYPES = ['q8', 'q4'];
// 最上位版は大きいので、どの環境でも4bit方式だけを使う（約760MB）
const isLarge = (model) => model.includes('large');
const dtypesFor = (model) => (isLarge(model) ? ['q4'] : WASM_DTYPES);
let variant = 0;
let device = null;

function options(model, dev) {
  return {
    device: dev,
    revision: REVISIONS[model],
    dtype: isLarge(model)
      ? { encoder_model: 'q4', decoder_model_merged: 'q4' }
      : dev === 'webgpu'
        ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
        : dtypesFor(model)[variant],
    progress_callback: (p) => {
      postMessage({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total });
    },
  };
}

function load(model, v = variant) {
  if (asr && currentModel === model && v === variant) return Promise.resolve();
  if (loading && loading.model === model && loading.variant === v) return loading.promise;
  if (!REVISIONS[model]) return Promise.reject(new Error('使えないAIが指定されました'));
  const promise = (async () => {
    if (asr) { try { await asr.dispose(); } catch (_) { /* 解放済み */ } }
    asr = null;
    variant = Math.min(v, dtypesFor(model).length - 1);
    device = await pickDevice();
    try {
      asr = await pipeline('automatic-speech-recognition', model, options(model, device));
    } catch (e) {
      if (device !== 'webgpu') throw e;
      device = 'wasm';
      asr = await pipeline('automatic-speech-recognition', model, options(model, device));
    }
    currentModel = model;
    postMessage({ type: 'ready', model, device, variant, threads: device === 'wasm' ? threads : 0 });
  })();
  loading = { model, variant: v, promise };
  promise.catch((e) => {
    loading = null;
    postMessage({ type: 'error', message: String(e && e.message || e) });
  });
  return promise;
}

// 計算が壊れたときの出力（同じ記号の繰り返しなど）
function broken(text) {
  const t = text.replace(/\s/g, '');
  if (!t) return false;
  if (/^[!！?？.。、,]+$/.test(t)) return true;
  return t.length >= 20 && new Set(t).size <= 2;
}

// AIが同じ言葉を何度も繰り返してしまったとき（例：階段階段階段…）は1回分だけ残す
function clean(text) {
  return text.replace(/(.{1,12}?)\1{3,}/gu, '$1').trim();
}

async function runChunks(audio) {
  const out = await asr(audio, { language: 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
  const chunks = (out.chunks || []).map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (audio.length / 16000), text: clean(c.text) }))
    .filter((c) => c.text);
  return { text: clean(out.text || ''), chunks };
}

// ---------- 話者の区別 ----------
let dia = null;
async function loadDia() {
  if (dia) return dia;
  const opts = { revision: DIA_REVISION, progress_callback: (p) => postMessage({ type: 'progress', status: p.status, file: 'dia:' + p.file, loaded: p.loaded, total: p.total }) };
  const proc = await AutoProcessor.from_pretrained(DIA_MODEL, opts);
  const model = await AutoModelForAudioFrameClassification.from_pretrained(DIA_MODEL, { ...opts, dtype: 'fp32', device: 'wasm' });
  dia = { proc, model };
  return dia;
}
// pyannote の出力（0:無音 1〜3:話者 4〜6:2人同時）を話者ごとに分ける
const EXPAND = { 1: [1], 2: [2], 3: [3], 4: [1, 2], 5: [1, 3], 6: [2, 3] };
async function segmentWindow(piece, offsetSec) {
  const { proc, model } = await loadDia();
  const inputs = await proc(piece);
  const { logits } = await model(inputs);
  const res = proc.post_process_speaker_diarization(logits, piece.length)[0];
  const turns = [];
  for (const r of res) for (const l of EXPAND[r.id] || []) turns.push({ l, start: r.start + offsetSec, end: r.end + offsetSec });
  return turns;
}
const overlap = (a, b, s, e) => Math.max(0, Math.min(a.end, b.end, e) - Math.max(a.start, b.start, s));
// 長い音声は60秒ずつ（10秒重ねて）区切って処理し、重なった部分で同じ人どうしを対応づける
async function diarize({ id, audio }) {
  const SR = 16000, W = 60 * SR, H = 50 * SR;
  let all = [];
  let prev = null;
  let nextId = 0;
  for (let off = 0; off < audio.length; off += H) {
    const end = Math.min(audio.length, off + W);
    if (end - off < SR && prev) break;
    const local = await segmentWindow(audio.subarray(off, end), off / SR);
    const map = {};
    if (prev) {
      const ovS = off / SR, ovE = prev.end;
      const scores = [];
      for (const l of [1, 2, 3]) {
        const sum = {};
        for (const t of local.filter((x) => x.l === l)) for (const g of prev.turns) sum[g.spk] = (sum[g.spk] || 0) + overlap(t, g, ovS, ovE);
        for (const [g, v] of Object.entries(sum)) if (v > 0.3) scores.push({ l, g: Number(g), v });
      }
      scores.sort((a, b) => b.v - a.v);
      const usedG = new Set();
      for (const sc of scores) if (!(sc.l in map) && !usedG.has(sc.g)) { map[sc.l] = sc.g; usedG.add(sc.g); }
    }
    for (const t of local) if (!(t.l in map)) map[t.l] = nextId++;
    const turns = local.map((t) => ({ spk: map[t.l], start: t.start, end: t.end }));
    const cut = prev ? (off / SR + prev.end) / 2 : 0;
    all = all.filter((t) => t.start < cut).map((t) => ({ ...t, end: Math.min(t.end, cut) }))
      .concat(turns.filter((t) => t.end > cut).map((t) => ({ ...t, start: Math.max(t.start, cut) })));
    prev = { turns, end: end / SR };
    if (end >= audio.length) break;
  }
  postMessage({ type: 'diarized', id, turns: all.filter((t) => t.end - t.start > 0.05) });
}

async function run(audio) {
  const out = await asr(audio, { language: 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return clean(Array.isArray(out) ? out.map((o) => o.text).join('') : out.text || '');
}

async function transcribe({ id, audio, model, variant: v, timestamps }) {
  await load(model, v ?? variant);
  if (timestamps) {
    // 話者の区別に使うため、文ごとの時刻つきで文字起こしする
    let out = await runChunks(audio);
    while (broken(out.text) && device === 'wasm' && variant < dtypesFor(model).length - 1) {
      postMessage({ type: 'switching' });
      await load(model, variant + 1);
      out = await runChunks(audio);
    }
    if (broken(out.text)) { postMessage({ type: 'result', id, text: '', error: 'broken' }); return; }
    postMessage({ type: 'result', id, text: out.text, chunks: out.chunks });
    return;
  }
  let text = await run(audio);
  while (broken(text) && device === 'wasm' && variant < dtypesFor(model).length - 1) {
    postMessage({ type: 'switching' });
    await load(model, variant + 1);
    text = await run(audio);
  }
  if (broken(text)) { postMessage({ type: 'result', id, text: '', error: 'broken' }); return; }
  postMessage({ type: 'result', id, text });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg.model, msg.variant ?? 0).catch(() => {});
  } else if (msg.type === 'diarize') {
    queue = queue.then(() => diarize(msg)).catch((err) => {
      postMessage({ type: 'diarized', id: msg.id, turns: null, error: String(err && err.message || err) });
    });
  } else if (msg.type === 'transcribe') {
    // 1件ずつ順番に処理する
    queue = queue.then(() => transcribe(msg)).catch((err) => {
      postMessage({ type: 'result', id: msg.id, text: '', error: String(err && err.message || err) });
    });
  }
};
