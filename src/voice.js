import { spawn } from 'node:child_process';
import { fail } from './security.js';
import { runCodec } from './codec.js';

function pcmFromWav(data) {
  if (data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WAVE') return null;
  let format, pcm;
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > data.length) throw fail('WAV 文件不完整');
    const id = data.subarray(offset, offset + 4).toString();
    if (id === 'fmt ' && size >= 16) format = { type: data.readUInt16LE(offset + 8), channels: data.readUInt16LE(offset + 10), rate: data.readUInt32LE(offset + 12), bits: data.readUInt16LE(offset + 22) };
    if (id === 'data') pcm = data.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  return format?.type === 1 && format.channels === 1 && format.rate === 24000 && format.bits === 16 && pcm ? pcm : null;
}
async function transcode(data, executable, signal, maxPcm) {
  if (!executable) throw fail('此音频需要 FFmpeg 转为 24kHz 单声道 PCM；请配置 ffmpegPath，或提供标准 WAV/SILK');
  return new Promise((resolve, reject) => {
    // pipe input forbids filename/protocol injection; no shell, no implicit installation.
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let size = 0, problem;
    const abort = () => { problem = fail('语音转换取消或超时'); child.kill(); };
    const timer = setTimeout(abort, 60000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxPcm) { problem = fail('语音超过配置时长'); child.kill(); } else parts.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { problem = fail('无法启动 FFmpeg，请检查安装路径'); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (problem || code !== 0) reject(problem || fail('音频转换失败')); else resolve(Buffer.concat(parts)); });
    child.stdin.end(data);
  });
}
export async function prepareVoice(data, { signal, ffmpegPath, maxVoiceSeconds = 60, durationMs }) {
  signal?.throwIfAborted();
  const isSilk = data.subarray(0, 20).toString('ascii').includes('#!SILK_V3');
  if (isSilk) {
    const decoded = await runCodec('decode', data, { signal, maxOutputBytes: maxVoiceSeconds * 48000, maxDurationMs: maxVoiceSeconds * 1000 });
    const ms = Math.round(decoded.data.byteLength / 48);
    if (!ms || ms > maxVoiceSeconds * 1000) throw fail('语音时长超出限制');
    return { data, durationMs: ms };
  }
  const pcm = pcmFromWav(data) || await transcode(data, ffmpegPath, signal, maxVoiceSeconds * 48000);
  const ms = Math.round(pcm.length / 48);
  if (!ms || pcm.length % 2 || ms > maxVoiceSeconds * 1000) throw fail('语音时长或采样数据无效');
  const encoded = await runCodec('encode', pcm, { signal, maxOutputBytes: 4 * 1024 * 1024 });
  signal?.throwIfAborted();
  return { data: Buffer.from(encoded.data), durationMs: ms };
}
