import path from 'node:path';
import os from 'node:os';
import { realpath, open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export function assertId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw fail('账号名称只允许 1–64 位字母、数字、下划线和短横线');
  return id;
}
export function homePath(value) {
  return path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') || value.startsWith('~\\') ? path.join(os.homedir(), value.slice(2)) : value);
}
export function defaultStateDir() {
  const profile = process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default';
  return path.join(os.homedir(), '.dsh-weixin-suite', createHash('sha256').update(profile).digest('hex').slice(0, 16));
}
export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
export function trustedUrl(value, purpose = 'api') {
  const u = new URL(value);
  const host = u.hostname.toLowerCase();
  const validHost = purpose === 'api' ? host.endsWith('.weixin.qq.com') : host.endsWith('.cdn.weixin.qq.com');
  if (u.protocol !== 'https:' || !validHost || u.username || u.password || u.port || u.hash) throw fail('拒绝不受信任的微信接口或 CDN 地址');
  return u;
}
export function safeName(value, fallback = 'attachment.bin') {
  const name = path.win32.basename(path.posix.basename(String(value || fallback))).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').slice(0, 150);
  return !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? fallback : name;
}
export function errorText(error) {
  // Never relay raw remote bodies, paths containing query credentials, or network exception causes.
  if (error?.publicMessage) return error.publicMessage;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '操作已取消或超时';
  return '操作未完成，请在本机检查插件状态';
}
export function fail(message) { const e = new Error(message); e.publicMessage = message; return e; }
export function combineSignal(signal, timeout) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
export async function readLimited(response, limit) {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > limit) { await response.body?.cancel(); throw fail('下载内容超过大小限制'); }
  const chunks = []; let length = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw fail('下载内容超过大小限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function readAllowedFile(file, roots, privateDir, maxBytes) {
  if (!path.isAbsolute(file)) throw fail('发送文件必须使用绝对路径');
  const resolved = await realpath(file);
  const privateReal = await realpath(privateDir);
  if (inside(privateReal, resolved)) throw fail('不能发送插件凭证或私有状态');
  const allowed = await Promise.all(roots.map(root => realpath(homePath(root))));
  if (!allowed.some(root => inside(root, resolved))) throw fail('文件不在配置的允许发送目录中');
  // Reject credential and state artifacts even when a user allows a broad parent folder.
  if (/(^|[\\/])(\.ssh|\.aws|\.azure|\.codex|wechat-bridge-state)([\\/]|$)/i.test(resolved) || /(^|[\\/])\.env(?:\.|$)/i.test(resolved)) throw fail('不能发送凭证目录或环境密钥文件');
  const before = await stat(resolved);
  const handle = await open(resolved, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes || info.size === 0 || info.ino !== before.ino || info.dev !== before.dev) throw fail('文件为空、过大、不是普通文件或读取时已改变');
    if (await realpath(file) !== resolved) throw fail('文件路径在读取期间改变');
    const data = Buffer.alloc(info.size); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) throw fail('文件读取不完整'); offset += bytesRead; }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw fail('文件在读取期间发生改变');
    return { data, name: safeName(path.basename(resolved)), path: resolved };
  } finally { await handle.close(); }
}
