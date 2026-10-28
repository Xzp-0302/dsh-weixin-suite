import { parentPort, workerData } from 'node:worker_threads';

try {
  let codec;
  try { codec = await import('silk-wasm'); }
  catch { parentPort.postMessage({ ok: false, reason: 'missing' }); process.exit(0); }
  const input = new Uint8Array(workerData.data);
  if (workerData.operation === 'decode') {
    const duration = codec.getDuration(input);
    if (!Number.isFinite(duration) || duration <= 0 || duration > workerData.maxDurationMs) throw new Error('limit');
  }
  const result = await codec[workerData.operation](input, 24000);
  if (result.data.byteLength > workerData.maxOutputBytes) throw new Error('limit');
  const bytes = new Uint8Array(result.data);
  parentPort.postMessage({ ok: true, data: bytes, duration: result.duration }, [bytes.buffer]);
} catch { parentPort.postMessage({ ok: false, reason: 'invalid' }); }
