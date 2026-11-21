// 文字起こし担当（Whisper をブラウザの中で動かす）。音声はこのスマホから外へ送らない。
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.useBrowserCache = true; // 一度ダウンロードしたAIはブラウザに保存して再利用
// クロスオリジン分離されていれば、CPUの複数の計算ラインを使って速くする
const threads = self.crossOriginIsolated
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

function options(device) {
  return {
    device,
    dtype: device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : 'q8',
    progress_callback: (p) => {
      postMessage({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total });
    },
  };
}

function load(model) {
  if (asr && currentModel === model) return Promise.resolve();
  if (loading && loading.model === model) return loading.promise;
  const promise = (async () => {
    asr = null;
    let device = await pickDevice();
    try {
      asr = await pipeline('automatic-speech-recognition', model, options(device));
    } catch (e) {
      if (device !== 'webgpu') throw e;
      device = 'wasm';
      asr = await pipeline('automatic-speech-recognition', model, options(device));
    }
    currentModel = model;
    postMessage({ type: 'ready', model, device, threads: device === 'wasm' ? threads : 0 });
  })();
  loading = { model, promise };
  promise.catch((e) => {
    loading = null;
    postMessage({ type: 'error', message: String(e && e.message || e) });
  });
  return promise;
}

async function transcribe({ id, audio, model }) {
  await load(model);
  const out = await asr(audio, {
    language: 'japanese',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join('') : out.text || '').trim();
  postMessage({ type: 'result', id, text });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg.model).catch(() => {});
  } else if (msg.type === 'transcribe') {
    // 1件ずつ順番に処理する
    queue = queue.then(() => transcribe(msg)).catch((err) => {
      postMessage({ type: 'result', id: msg.id, text: '', error: String(err && err.message || err) });
    });
  }
};
