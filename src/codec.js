import { Worker } from 'node:worker_threads';
import { fail } from './security.js';

/** Keep CPU-bound optional codecs off the Harness event loop and make cancellation effective. */
export function runCodec(operation, data, { signal, maxOutputBytes, maxDurationMs = 600000 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./codec-worker.js', import.meta.url), { workerData: { operation, data: new Uint8Array(data), maxOutputBytes, maxDurationMs }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(null, fail('语音编解码已取消或超时'));
    const timer = setTimeout(abort, 30000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    worker.on('message', value => {
      if (!value.ok) return finish(null, fail(value.reason === 'missing' ? '语音编解码需要安装可选依赖 silk-wasm' : '语音格式、时长或大小不符合要求'));
      finish({ data: Buffer.from(value.data), duration: value.duration });
    });
    worker.on('error', () => finish(null, fail('语音编解码失败')));
    worker.on('exit', () => { if (!settled) finish(null, fail('语音编解码未返回结果')); });
  });
}
