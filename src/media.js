// Tencent iLink CDN wire format; see THIRD_PARTY_NOTICES.md.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CDN_BASE } from './api.js';
import { combineSignal, fail, readLimited, safeName, trustedUrl, inside } from './security.js';
import { runCodec } from './codec.js';

export const KIND = { image: { upload: 1, item: 2 }, video: { upload: 2, item: 5 }, file: { upload: 3, item: 4 }, voice: { upload: 4, item: 3 } };
export function mimeOf(name) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.silk': 'audio/silk', '.ogg': 'audio/ogg', '.txt': 'text/plain' })[path.extname(name).toLowerCase()] || 'application/octet-stream';
}
export function inferKind(name) { const mime = mimeOf(name); return mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file'; }
export function encode(data, key) { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); }
export function decode(data, key) { const cipher = createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(data), cipher.final()]); }
export function decodeKey(value, rawHex) {
  if (rawHex) { if (!/^[\da-f]{32}$/i.test(rawHex)) throw fail('图片解密密钥格式错误'); return Buffer.from(rawHex, 'hex'); }
  if (typeof value !== 'string' || !value || value.length > 100) throw fail('附件缺少解密密钥');
  const key = Buffer.from(value, 'base64');
  if (key.length === 16) return key;
  if (key.length === 32 && /^[\da-f]{32}$/i.test(key.toString())) return Buffer.from(key.toString(), 'hex');
  throw fail('附件解密密钥格式错误');
}
export async function upload(api, peer, data, kind, { signal, maxBytes }) {
  if (!KIND[kind] || !data.length || data.length > maxBytes) throw fail('附件类型或大小无效');
  const aesKey = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const encrypted = encode(data, aesKey);
  const response = await api.call('getuploadurl', { filekey, media_type: KIND[kind].upload, to_user_id: peer.userId, rawsize: data.length, rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: encrypted.length, no_need_thumb: true, aeskey: aesKey.toString('hex') }, { signal });
  if (!response.upload_full_url && !response.upload_param) throw fail('微信未返回文件上传地址');
  const url = trustedUrl(response.upload_full_url || `${CDN_BASE}/upload?${new URLSearchParams({ encrypted_query_param: response.upload_param, filekey })}`, 'cdn');
  let parameter;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await api.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted, redirect: 'error', signal: combineSignal(signal, 120000) });
      const status = res.status;
      parameter = res.headers.get('x-encrypted-param');
      await res.body?.cancel();
      if (status >= 400 && status < 500) { const e = fail(`微信 CDN 拒绝上传：HTTP ${status}`); e.permanent = true; throw e; }
      if (status !== 200 || !parameter) throw fail('CDN 未确认完整上传');
      return { media: { encrypt_query_param: parameter, aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'), encrypt_type: 1 }, rawSize: data.length, encryptedSize: encrypted.length, md5: createHash('md5').update(data).digest('hex') };
    } catch (e) {
      if (e.permanent || signal?.aborted || attempt === 2) throw e.publicMessage ? e : fail('微信 CDN 上传失败');
      await delay(500 * 2 ** attempt, undefined, { signal });
    }
  }
}
export function mediaItem(kind, uploaded, name, metadata = {}) {
  const { media, rawSize, encryptedSize, md5 } = uploaded;
  if (kind === 'image') return { type: 2, image_item: { media, mid_size: encryptedSize } };
  if (kind === 'video') return { type: 5, video_item: { media, video_size: encryptedSize, video_md5: md5, ...(metadata.durationMs ? { play_length: Math.ceil(metadata.durationMs / 1000) } : {}) } };
  if (kind === 'voice') return { type: 3, voice_item: { media, encode_type: 6, sample_rate: 24000, bits_per_sample: 16, playtime: metadata.durationMs } };
  return { type: 4, file_item: { media, file_name: safeName(name), len: String(rawSize), md5 } };
}
export function wav(pcm, rate = 24000) {
  const head = Buffer.alloc(44); head.write('RIFF'); head.writeUInt32LE(pcm.length + 36, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40); return Buffer.concat([head, pcm]);
}
export async function downloadItem(api, item, folder, { signal, maxBytes, root }) {
  const kind = ({ 2: 'image', 3: 'voice', 4: 'file', 5: 'video' })[item.type];
  if (!kind) throw fail('不支持的附件消息类型');
  const detail = item[kind + '_item'];
  const media = detail?.media;
  if (!media) throw fail('附件缺少媒体引用');
  const declared = Number(kind === 'file' ? detail.len : detail.mid_size || detail.video_size);
  if (Number.isFinite(declared) && declared > maxBytes + 16) throw fail('接收附件超过大小限制');
  if (!media.full_url && !media.encrypt_query_param) throw fail('附件缺少下载地址');
  const url = trustedUrl(media.full_url || `${CDN_BASE}/download?${new URLSearchParams({ encrypted_query_param: media.encrypt_query_param })}`, 'cdn');
  const res = await api.fetch(url, { redirect: 'error', signal: combineSignal(signal, 120000) });
  if (!res.ok) { await res.body?.cancel(); throw fail(`附件下载失败：HTTP ${res.status}`); }
  const encrypted = await readLimited(res, maxBytes + 16);
  let data;
  if (kind === 'image' && !detail.aeskey && !media.aes_key) data = encrypted;
  else { try { data = decode(encrypted, decodeKey(media.aes_key, detail.aeskey)); } catch { throw fail('附件解密失败'); } }
  if (data.length > maxBytes || !data.length) throw fail('附件大小无效');
  if (kind === 'file' && detail.len != null && Number(detail.len) !== data.length) throw fail('附件长度与消息不一致');
  if (detail.md5 && (typeof detail.md5 !== 'string' || createHash('md5').update(data).digest('hex') !== detail.md5.toLowerCase())) throw fail('附件校验失败');
  let name = detail.file_name || `${kind}.${kind === 'image' ? detectImage(data).split('/')[1].replace('jpeg', 'jpg') : kind === 'video' ? 'mp4' : ({ 6: 'silk', 7: 'mp3', 1: 'pcm', 5: 'amr', 8: 'ogg' })[detail.encode_type] || 'bin'}`;
  if (kind === 'voice' && detail.encode_type === 6) {
    try { const decoded = await runCodec('decode', data, { signal, maxOutputBytes: maxBytes - 44 }); data = wav(decoded.data); name = 'voice.wav'; }
    catch { if (signal?.aborted) throw signal.reason; /* Keep raw SILK if optional decode is unavailable. */ }
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const canonical = await realpath(folder);
  if (!root || !inside(root, canonical)) throw fail('附件保存目录超出插件工作目录');
  signal?.throwIfAborted();
  const dest = path.join(canonical, randomUUID() + '-' + safeName(name));
  await writeFile(dest, data, { flag: 'wx', mode: 0o600 });
  return { path: dest, name: safeName(name), size: data.length, mime: kind === 'image' ? detectImage(data) : mimeOf(name), kind, transcript: kind === 'voice' ? String(detail.text || '') : '' };
}
export function detectImage(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216) return 'image/jpeg';
  if (data.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
