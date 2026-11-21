// 文字起こし担当（Whisper をブラウザの中で動かす）。音声はこのスマホから外へ送らない。
// 外部のサイトからプログラムを読み込まないよう、ライブラリはアプリ内（vendor/）に同梱している
import { pipeline, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // 一度ダウンロードしたAIはブラウザに保存して再利用
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;

// 使ってよいAIと、その版（中身が勝手に差し替わらないよう版を固定する）
const REVISIONS = {
  'onnx-community/whisper-tiny': 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  'onnx-community/whisper-base': '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
  'onnx-community/whisper-small': '36050c46d777d46dc4b5f43f6d90574fc38f8732',
};
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
let variant = 0;
let device = null;

function options(model, dev) {
  return {
    device: dev,
    revision: REVISIONS[model],
    dtype: dev === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : WASM_DTYPES[variant],
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
    variant = Math.min(v, WASM_DTYPES.length - 1);
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

async function run(audio) {
  const out = await asr(audio, { language: 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
  return (Array.isArray(out) ? out.map((o) => o.text).join('') : out.text || '').trim();
}

async function transcribe({ id, audio, model, variant: v }) {
  await load(model, v ?? variant);
  let text = await run(audio);
  while (broken(text) && device === 'wasm' && variant < WASM_DTYPES.length - 1) {
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
  } else if (msg.type === 'transcribe') {
    // 1件ずつ順番に処理する
    queue = queue.then(() => transcribe(msg)).catch((err) => {
      postMessage({ type: 'result', id: msg.id, text: '', error: String(err && err.message || err) });
    });
  }
};
