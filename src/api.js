// Protocol behavior derived from Tencent/openclaw-weixin (MIT); see THIRD_PARTY_NOTICES.md.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { trustedUrl, readLimited, combineSignal, fail } from './security.js';
export const API_BASE = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const PROTOCOL_VERSION = '2.4.10';

export function parseLossless(text) {
  // Tokenize outside quoted strings: preserve uint64 IDs without touching numbers in message text.
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '"') { const start = i++; while (i < text.length) { const c = text[i++]; if (c === '\\') i++; else if (c === '"') break; } out += text.slice(start, i); }
    else if (text[i] === '-' || /\d/.test(text[i])) {
      const match = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) throw fail('微信接口返回了无效 JSON');
      const n = match[0]; out += /^-?\d+$/.test(n) && !Number.isSafeInteger(Number(n)) ? JSON.stringify(n) : n; i += n.length;
    } else out += text[i++];
  }
  return JSON.parse(out);
}
export function chunks(text, limit = 1800) {
  const result = []; let part = '', bytes = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (bytes + n > limit) { result.push(part); part = ''; bytes = 0; } part += char; bytes += n; }
  if (part) result.push(part); return result;
}
export class WeixinApi {
  constructor(account = {}, options = {}) { this.base = trustedUrl(account.base || API_BASE).origin; this.token = account.token; this.fetch = options.fetch || globalThis.fetch; this.routeTag = options.routeTag; }
  async call(endpoint, body = {}, { signal, timeout = 20000, get = false, base = this.base, authenticated = true } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (this.routeTag != null) headers.SKRouteTag = String(this.routeTag);
    if (!get) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (authenticated && this.token) headers.Authorization = 'Bearer ' + this.token;
    }
    const baseInfo = { channel_version: PROTOCOL_VERSION, bot_agent: 'DSHWeixinSuite/0.1.0' };
    let response;
    try { response = await this.fetch(new URL('/ilink/bot/' + endpoint, trustedUrl(base)), { method: get ? 'GET' : 'POST', headers, redirect: 'error', signal: combineSignal(signal, timeout), ...(!get ? { body: JSON.stringify(authenticated ? { ...body, base_info: baseInfo } : body) } : {}) }); }
    catch (e) { if (signal?.aborted) throw signal.reason; throw fail('微信网络请求失败或超时，发送结果可能未知'); }
    if (!response.ok) { await response.body?.cancel(); const e = fail(`微信接口 HTTP ${response.status}`); e.status = response.status; throw e; }
    const data = parseLossless((await readLimited(response, 8 * 1024 * 1024)).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('微信接口返回格式无效');
    const code = data.errcode || data.ret;
    if (code != null && code !== 0) { const e = fail(`微信接口错误 ${code}`); e.code = code; throw e; }
    return data;
  }
  qr(tokens = [], signal) { return this.call('get_bot_qrcode?bot_type=3', { local_token_list: tokens.slice(-10) }, { authenticated: false, base: API_BASE, signal }); }
  qrStatus(qrcode, base, code, signal) { return this.call('get_qrcode_status?' + new URLSearchParams({ qrcode, ...(code ? { verify_code: code } : {}) }), {}, { get: true, authenticated: false, base, signal, timeout: 35000 }); }
  updates(cursor, signal, timeout = 40000) { return this.call('getupdates', { get_updates_buf: cursor || '' }, { signal, timeout }); }
  config(user, context, signal) { return this.call('getconfig', { ilink_user_id: user, context_token: context }, { signal, timeout: 10000 }); }
  typing(user, ticket, status, signal) { return this.call('sendtyping', { ilink_user_id: user, typing_ticket: ticket, status }, { signal, timeout: 10000 }); }
  notify(start, signal) { return this.call('msg/' + (start ? 'notifystart' : 'notifystop'), {}, { signal, timeout: 5000 }); }
  async sendItem(peer, item, { signal, clientId = randomUUID(), runId } = {}) {
    if (!peer.userId || !peer.contextToken) throw fail('缺少有效微信回复上下文，请先从微信发一条消息');
    const data = await this.call('sendmessage', { msg: { from_user_id: '', to_user_id: peer.userId, client_id: clientId, message_type: 2, message_state: 2, context_token: peer.contextToken, ...(runId ? { run_id: runId } : {}), item_list: [item] } }, { signal });
    return { clientId, messageId: data.message_id == null ? null : String(data.message_id), status: 'accepted' };
  }
  async sendText(peer, text, options = {}) {
    const results = [];
    for (const part of chunks(text)) { options.signal?.throwIfAborted(); results.push(await this.sendItem(peer, { type: 1, text_item: { text: part }, ...(options.quote ? { ref_msg: options.quote } : {}) }, options)); }
    return results;
  }
}
export async function login(api, { tokens = [], signal, display, verification }) {
  signal = combineSignal(signal, 300000);
  const qr = await api.qr(tokens, signal);
  if (!qr.qrcode || !qr.qrcode_img_content) throw fail('微信没有返回二维码');
  await display(qr.qrcode_img_content);
  let base = API_BASE, code = '', redirects = 0;
  const expires = Date.now() + 300000;
  while (Date.now() < expires) {
    signal?.throwIfAborted();
    let data;
    try { data = await api.qrStatus(qr.qrcode, base, code, signal); }
    catch (e) { if (signal?.aborted || e.code) throw e; await delay(1500, undefined, { signal }); continue; }
    code = '';
    if (data.status === 'confirmed') {
      if (!data.bot_token || !data.ilink_user_id || !data.ilink_bot_id) throw fail('登录返回的身份信息不完整');
      return { token: data.bot_token, userId: data.ilink_user_id, botId: data.ilink_bot_id, base: trustedUrl(data.baseurl || base).origin };
    }
    if (data.status === 'scaned_but_redirect') { if (++redirects > 5) throw fail('登录重定向次数异常'); base = trustedUrl('https://' + data.redirect_host).origin; }
    else if (data.status === 'need_verifycode') { code = await verification(signal); if (!/^\d{1,12}$/.test(code)) throw fail('配对数字格式无效'); }
    else if (data.status === 'binded_redirect') return { alreadyBound: true };
    else if (['expired', 'verify_code_blocked'].includes(data.status)) throw fail('二维码已过期或配对码被限制，请重新登录');
    await delay(800, undefined, { signal });
  }
  throw fail('扫码登录超时，请重新登录');
}
