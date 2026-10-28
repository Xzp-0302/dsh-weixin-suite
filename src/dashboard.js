import path from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { replaceGitBundle } from './update.js';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { WeixinApi, login } from './api.js';
import { assertId, errorText, fail, homePath, readLimited } from './security.js';

const editable = ['allowedRoots', 'maxFileMiB', 'maxVoiceSeconds', 'interactionTimeoutSeconds', 'taskTimeoutMinutes', 'progress', 'toolEvents', 'provider', 'model', 'preset', 'ffmpegPath'];
const limits = { maxFileMiB: [1, 200], maxVoiceSeconds: [1, 600], interactionTimeoutSeconds: [30, 3600], taskTimeoutMinutes: [1, 240] };
function settingsOf(config) { return Object.fromEntries(editable.map(key => [key, config[key]])); }

/** Owner-only management operations shared by the in-app dashboard; credentials never cross the wire. */
export class Dashboard {
  constructor(channel, ctx) { this.ctx = ctx; this.catalog = []; this.update = { status: "idle" }; this.channel = channel; this.binding = null; this.mutations = Promise.resolve(); this.closed = false; }
  async init() {
    const saved = await this.channel.store.read('settings', null);
    if (saved) Object.assign(this.channel.config, await this.validateSettings(saved, false));
    this.channel.interactions.timeoutMs = this.channel.config.interactionTimeoutSeconds * 1000;
  }
  busy(key) { return this.channel.controllers.has(key) || this.channel.host.handles.get(key)?.agent.status === 'running'; }
  serial(work) {
    const task = this.mutations.catch(() => {}).then(() => {
      if (this.closed || this.channel.stopping) throw fail('微信助理正在关闭，请稍后重试');
      return work();
    });
    this.mutations = task.catch(() => {}); return task;
  }
  snapshot() {
    const channel = this.channel;
    const accounts = [...channel.accounts.values()].map(a => ({ id: a.id, label: a.label || a.id, status: a.status, paused: Boolean(a.paused), peers: a.allowedPeers?.length || 0 }));
    const sessions = Object.values(channel.state.routes).filter(r => channel.accounts.has(r.accountId)).map(r => ({
      key: r.key, account: r.accountId, title: r.title || '微信会话', sessionId: r.sessionId,
      preview: r.transcript?.at(-1)?.text.slice(0, 100) || r.quotes.at(-1)?.text.slice(0, 100) || '',
      lastActive: r.lastActive || 0, busy: this.busy(r.key), received: r.received, sent: r.sent,
      queued: channel.state.inbox.filter(e => e.routeKey === r.key && e.status === 'queued').length,
    })).sort((a, b) => b.lastActive - a.lastActive);
    const binding = this.binding ? { id: this.binding.id, account: this.binding.account, status: this.binding.status, image: this.binding.image, expiresAt: this.binding.expiresAt, error: this.binding.error } : null;
    return { version: metadata.version, stopped: channel.stopping, accounts, sessions, binding, update: this.update, settings: settingsOf(channel.config), workspace: channel.config.workspace };
  }
  route(key) { const route = this.channel.state.routes[key]; if (!route || !this.channel.accounts.has(route.accountId)) throw fail('会话不存在'); return route; }
  session(key) {
    const route = this.route(key);
    const transcript = route.transcript || route.quotes.map(q => ({ role: 'history', text: q.text, id: q.id, time: 0 }));
    const pending = [...this.channel.interactions.pending.entries()].filter(([, p]) => p.route === key).map(([id, p]) => ({ id, kind: p.kind, tool: p.request.toolName || '', reason: p.request.reason || '', questions: p.request.questions || [] }));
    for (const q of route.questions || []) pending.push({ id: q.id, kind: 'questions', tool: '', reason: '', questions: q.questions, late: true });
    return { key, sessionId: route.sessionId, title: route.title || '微信会话', transcript, pending, interrupted: this.channel.state.inbox.filter(e => e.routeKey === key && e.status === 'interrupted').map(e => e.id) };
  }
  async validateSettings(input, verifyPaths = true) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('设置格式无效');
    const result = settingsOf(this.channel.config);
    for (const [key, value] of Object.entries(input)) {
      if (!editable.includes(key)) throw fail('包含不允许修改的设置');
      if (key in limits) { const [min, max] = limits[key]; if (!Number.isInteger(value) || value < min || value > max) throw fail('设置数值超出范围'); }
      else if (['progress', 'toolEvents'].includes(key)) { if (typeof value !== 'boolean') throw fail('开关设置必须为布尔值'); }
      else if (key === 'allowedRoots') {
        if (!Array.isArray(value) || value.length > 32 || value.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw fail('发送目录必须为绝对路径，最多 32 个');
        if (verifyPaths) for (const root of value) {
          try { if (!(await stat(await realpath(homePath(root)))).isDirectory()) throw fail('发送目录不存在或不是文件夹'); }
          catch { throw fail('发送目录不存在或不可访问，请检查每行填写的文件夹'); }
        }
      } else if (typeof value !== 'string' || value.length > 2048) throw fail('设置文字过长或格式错误');
      result[key] = value;
    }
    if (Boolean(result.provider) !== Boolean(result.model)) throw fail('模型提供方和模型名称需同时填写，或同时留空');
    if (result.ffmpegPath && !path.isAbsolute(result.ffmpegPath)) throw fail('FFmpeg 需要绝对路径');
    return result;
  }
  async settings(input) {
    if (this.channel.controllers.size || [...this.channel.host.handles.keys()].some(key => this.busy(key))) throw fail('任务执行中，请先停止任务或等待完成再保存设置');
    const value = await this.validateSettings(input);
    await this.channel.store.write('settings', value);
    Object.assign(this.channel.config, value); this.channel.interactions.timeoutMs = value.interactionTimeoutSeconds * 1000;
    return this.snapshot();
  }
  async beginBinding(account, name = '') {
    const registered = await this.channel.store.loadAccounts();
    account ||= this.channel.config.accountIds.find(id => !registered.some(a => a.id === id)) || 'wx-' + randomUUID().slice(0, 8);
    assertId(account);
    if (this.channel.config.accountIds.length && !this.channel.config.accountIds.includes(account)) throw fail('可绑定账号受到高级配置限制，请先在插件设置中调整 accountIds');
    if (typeof name !== 'string' || name.length > 60) throw fail('账号名称最多 60 个字');
    if (registered.some(a => a.id === account)) throw fail('账号名称已登记，请选择新账号');
    if (registered.length >= 16) throw fail('最多可绑定 16 个账号');
    if (this.channel.accounts.has(account)) throw fail('账号名称已存在，请使用新名称；重新绑定请先移除原绑定');
    if (this.channel.accounts.size >= 16) throw fail('最多可绑定 16 个账号');
    await this.cancelBinding();
    const controller = new AbortController();
    const binding = this.binding = { id: randomUUID(), account, controller, status: 'creating', image: '', expiresAt: Date.now() + 300000, error: '', verify: null };
    const signal = AbortSignal.any([controller.signal, this.channel.lifetime.signal]);
    binding.task = login(new WeixinApi(), {
      signal, tokens: [...this.channel.accounts.values()].map(a => a.token),
      display: async value => { binding.image = await QRCode.toDataURL(value, { width: 280, margin: 2, errorCorrectionLevel: 'M' }); binding.status = 'waiting'; },
      verification: verifySignal => new Promise((resolve, reject) => {
        binding.status = 'verification';
        const abort = () => { binding.verify = null; reject(fail('扫码绑定已取消或过期')); };
        binding.verify = code => { verifySignal.removeEventListener('abort', abort); binding.verify = null; binding.status = 'waiting'; resolve(code); };
        verifySignal.addEventListener('abort', abort, { once: true }); if (verifySignal.aborted) abort();
      }),
    }).then(result => this.serial(async () => {
      if (signal.aborted || this.binding !== binding) return;
      if (result.alreadyBound) throw fail('微信提示该机器人已有绑定，请确认归属，避免影响其他应用');
      if ([...this.channel.accounts.values()].some(a => a.botId === result.botId)) throw fail('该机器人已绑定在本插件的另一个账号下');
      const accounts = await this.channel.store.loadAccounts();
      if (accounts.length >= 16 || accounts.some(a => a.id === account)) throw fail('账号列表已变化，请重新绑定');
      const entry = { id: account, label: name.trim() || `微信账号 ${accounts.length + 1}`, ...result, allowedPeers: [], createdAt: Date.now() };
      await this.channel.store.write('accounts', [...accounts.filter(a => a.id !== account), entry]);
      this.channel.state.accounts[account] = { cursor: '', seen: [] };
      const runtime = { ...entry, api: new WeixinApi(entry, { routeTag: this.channel.config.routeTag }), status: 'starting' };
      this.channel.accounts.set(account, runtime); await this.channel.save();
      this.channel.startAccount(runtime); binding.status = 'confirmed'; binding.image = '';
    })).catch(error => {
      if (this.binding !== binding) return;
      binding.status = signal.aborted ? 'cancelled' : 'failed'; binding.error = errorText(error); binding.image = ''; binding.verify = null;
    });
    return this.snapshot();
  }
  async cancelBinding() {
    const binding = this.binding; if (!binding) return;
    binding.controller.abort(); binding.verify?.(''); binding.status = 'cancelled'; binding.image = ''; this.binding = null;
    // Do not await binding.task here: its completion may be queued behind the current mutation.
  }
  async accountAction(id, action) {
    const account = this.channel.accounts.get(id); if (!account) throw fail('账号不存在');
    if (action === 'pause') {
      const accounts = await this.channel.store.loadAccounts();
      await this.channel.store.write('accounts', accounts.map(a => a.id === id ? { ...a, paused: true } : a));
      account.paused = true; await this.channel.stopAccount(id);
    }
    else if (action === 'resume') { if (account.status === 'expired') throw fail('账号已过期，请先移除并重新扫码'); account.paused = false; }
    else if (action === 'remove') {
      await this.channel.stopAccount(id);
      const registered = await this.channel.store.loadAccounts();
      await this.channel.store.write('accounts', registered.filter(a => a.id !== id));
      for (const route of Object.values(this.channel.state.routes).filter(r => r.accountId === id)) { await this.channel.host.newSession(route); delete this.channel.state.routes[route.key]; }
      this.channel.state.inbox = this.channel.state.inbox.filter(e => this.channel.state.routes[e.routeKey]);
      delete this.channel.state.accounts[id]; this.channel.accounts.delete(id); await this.channel.save();
    } else throw fail('未知的账号操作');
    const accounts = await this.channel.store.loadAccounts();
    await this.channel.store.write('accounts', accounts.filter(a => action !== 'remove' || a.id !== id).map(a => a.id === id ? { ...a, paused: Boolean(account.paused) } : a));
    if (action === 'resume') this.channel.startAccount(account);
    return this.snapshot();
  }
  async choices(provider) {
    if (!this.llm) return { providers: [], models: [], unavailable: true };
    const providers = this.llm.listProviders().map(p => ({ id: p.id, name: p.name || p.id }));
    if (!provider) return { providers, models: [] };
    if (typeof provider !== 'string' || !providers.some(p => p.id === provider)) return { providers, models: [] };
    let timer;
    let models;
    try { models = await Promise.race([this.llm.listModels(provider), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('读取模型目录超时，请重试或自定义填写')), 10000); timer.unref(); })]); }
    finally { clearTimeout(timer); }
    return { providers, models: models.map(m => ({ id: m.id, name: m.name || m.id })) };
  }
  async checkUpdates() {
    const response = await fetch('https://api.github.com/repos/Xzp-0302/dsh-weixin-suite/tags?per_page=30', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.any([this.channel.lifetime.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
    if (!response.ok) throw fail('无法读取 GitHub 版本列表，请检查网络或稍后重试');
    const tags = JSON.parse((await readLimited(response, 65536)).toString('utf8'));
    if (!Array.isArray(tags)) throw fail('版本目录格式无效');
    this.catalog = tags.filter(t => /^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(t.name) && /^[a-f0-9]{40}$/.test(t.commit?.sha)).map(t => ({ tag: t.name, sha: t.commit.sha }));
    return { versions: this.catalog, available: Boolean(this.manager) };
  }
  startUpdate(tag) {
    if (!this.manager) throw fail('当前 DSH 未提供原生插件管理服务');
    if (this.update.status === 'installing') throw fail('更新已在进行中');
    if (this.channel.controllers.size || [...this.channel.host.handles.keys()].some(k => this.busy(k)) || this.binding && ['creating', 'waiting', 'verification'].includes(this.binding.status)) throw fail('请先结束任务和扫码绑定，再更新插件');
    const version = this.catalog.find(v => v.tag === tag);
    if (!version) throw fail('请先检查版本并选择已发布的标签');
    if (tag === 'v' + metadata.version) throw fail('已经是该版本，无需重复安装');
    const manager = this.manager;
    this.update = { status: 'installing', tag };
    // Return the acknowledgement before HMR disposes this dashboard. Never join
    // this operation from close(): the manager must be able to unload its caller.
    this.ctx.effect(() => {
      const timer = setTimeout(() => {
        void Promise.resolve().then(() => replaceGitBundle(manager, version.sha)).then(result => {
          this.update = { status: result.application === 'failed' ? 'failed' : 'complete', tag };
          if (result.application === 'failed') this.channel.logger.warn('微信助理更新失败，请在 DSH 插件管理中查看安装详情');
        }).catch(error => { this.update = { status: 'failed', tag }; this.channel.logger.warn(errorText(error)); });
      }, 500);
      return () => clearTimeout(timer);
    }, 'weixin-suite: owner requested native update');
    return this.update;
  }
  async perform(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('操作参数格式无效');
    if (action === 'choices') return this.choices(input.provider);
    if (action === 'check-updates') return this.checkUpdates();
    if (action === 'snapshot') return this.snapshot();
    if (action === 'session') return this.session(input.key);
    return this.serial(async () => {
      switch (action) {
        case 'update': return this.startUpdate(input.tag);
        case 'bind': return this.beginBinding(input.account, input.name);
        case 'bind-cancel': await this.cancelBinding(); return this.snapshot();
        case 'bind-verify':
          if (!this.binding || this.binding.id !== input.id || this.binding.status !== 'verification' || !/^\d{1,12}$/.test(input.code || '')) throw fail('配对数字无效或绑定已过期');
          this.binding.verify(input.code); return this.snapshot();
        case 'account': return this.accountAction(input.id, input.action);
        case 'settings': return this.settings(input.settings);
        case 'session-stop': {
          const route = this.route(input.key); this.channel.controllers.get(route.key)?.abort(); this.channel.host.stop(route); this.channel.interactions.cancelRoute(route.key);
          for (const entry of this.channel.state.inbox) if (entry.routeKey === route.key && entry.status === 'queued') entry.status = 'cancelled';
          await this.channel.save(); return this.session(route.key);
        }
        case 'session-new': {
          const route = this.route(input.key); if (this.busy(route.key) || this.channel.drains.has(route.key)) throw fail('请先等待当前任务结束');
          await this.channel.host.newSession(route); return this.session(route.key);
        }
        case 'answer': {
          const route = this.route(input.key);
          if (typeof input.text !== 'string' || input.text.length > 20000) throw fail('回答无效');
          if (!await this.channel.interactions.answer(route, input.text)) throw fail('请求编号或回答格式无效');
          await this.channel.save(); return this.session(route.key);
        }
        default: throw fail('未知的微信助理操作');
      }
    });
  }
  async close() { this.closed = true; await this.cancelBinding(); await this.mutations; }
}

export function registerDashboardTransport(ctx, dashboard) {
  ctx.inject(['connection'], child => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/weixin-suite', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let rpcId = 'invalid-request';
        const respond = result => Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        try {
          if (!request.headers.get('content-type')?.startsWith('application/json')) throw fail('请求需要 JSON 格式');
          const envelope = JSON.parse((await readLimited(request, 65536)).toString('utf8'));
          if (!envelope || envelope.type !== 'client-request' || envelope.method !== 'weixin-suite' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 128 || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) throw fail('请求格式无效');
          rpcId = envelope.rpcId; request.signal.throwIfAborted();
          return respond({ ok: true, value: await dashboard.perform(envelope.payload.action, envelope.payload.input) });
        } catch (error) { return respond({ ok: false, error: { code: 'weixin-suite/error', message: errorText(error), details: {} } }); }
      },
    }), 'weixin-suite: authenticated owner-only dashboard endpoint');
  });
}
