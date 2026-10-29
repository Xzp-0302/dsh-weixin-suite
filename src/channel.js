import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WeixinApi } from './api.js';
import { Store } from './store.js';
import { downloadItem, upload, mediaItem, inferKind } from './media.js';
import { prepareVoice } from './voice.js';
import { Interactions } from './interactions.js';
import { errorText, fail, readAllowedFile, inside } from './security.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function validateState(state) {
  if (!record(state) || state.version !== 1 || !record(state.accounts) || !record(state.routes) || !record(state.outbox) || !Array.isArray(state.inbox)) throw fail('插件状态格式无效或版本不兼容');
  for (const a of Object.values(state.accounts)) if (!record(a) || typeof a.cursor !== 'string' || !Array.isArray(a.seen) || a.seen.some(id => typeof id !== 'string')) throw fail('账号运行状态损坏');
  for (const [key, r] of Object.entries(state.routes)) {
    if (!record(r) || key !== r.key || !/^[a-f0-9]{32}$/.test(key) || typeof r.accountId !== 'string' || typeof r.userId !== 'string' || key !== digest(r.accountId + ':' + r.userId).slice(0, 32) || typeof r.contextToken !== 'string' || !Array.isArray(r.quotes)) throw fail('会话路由状态损坏');
    if (r.transcript != null && (!Array.isArray(r.transcript) || r.transcript.length > 120 || r.transcript.some(m => !record(m) || !['user', 'assistant', 'history'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 4000 || typeof m.id !== 'string' || !Number.isFinite(m.time)))) throw fail('近期会话记录损坏');
  }
  for (const e of state.inbox) if (!record(e) || typeof e.id !== 'string' || !state.routes[e.routeKey] || !record(e.message) || !Array.isArray(e.message.item_list) || !['queued', 'control', 'running', 'interrupted', 'completed', 'failed', 'cancelled'].includes(e.status)) throw fail('消息队列状态损坏');
  for (const e of Object.values(state.outbox)) if (!record(e) || !['preparing', 'sending', 'accepted', 'unknown', 'failed'].includes(e.status)) throw fail('发送记录状态损坏');
}
export class Channel {
  constructor(config, logger) {
    this.config = config; this.logger = logger; this.store = new Store(config.stateDir); this.lifetime = new AbortController();
    this.accounts = new Map(); this.pollers = []; this.sendChains = new Map(); this.drains = new Map(); this.controllers = new Map(); this.accountControllers = new Map(); this.accountPollers = new Map(); this.stopping = false; this.closing = null;
    this.interactions = new Interactions((r, text, signal) => this.text(r, text, signal), config.interactionTimeoutSeconds * 1000, {
      save: () => { void this.save().catch(e => this.logger.warn(errorText(e))); },
      answer: async (route, callId, value) => {
        const agent = await this.host.agent(route);
        const service = agent.ctx.get('userQuestions');
        if (!service || !service.answer(agent, callId, value)) throw fail('该问题已结束，无法补交回答');
      },
    });
  }
  async init() {
    await this.store.init(); await this.store.lock();
    try {
      if (inside(this.store.dir, path.resolve(this.config.workspace))) throw fail('附件工作目录不能位于插件凭证目录内');
      this.state = await this.store.read('runtime', { version: 1, accounts: {}, routes: {}, outbox: {}, inbox: [] });
      validateState(this.state);
      for (const account of await this.store.loadAccounts()) {
        if (this.config.accountIds.length && !this.config.accountIds.includes(account.id)) continue;
        this.accounts.set(account.id, { ...account, api: new WeixinApi(account, { routeTag: this.config.routeTag }), status: 'starting' });
        this.state.accounts[account.id] ||= { cursor: '', seen: [] };
      }
      // Previous process may have performed side effects; never replay its pending/in-progress turns automatically.
      for (const entry of this.state.inbox) if (['queued', 'running', 'control'].includes(entry.status)) entry.status = 'interrupted';
      for (const value of Object.values(this.state.outbox)) if (['preparing', 'sending'].includes(value.status)) value.status = 'unknown';
      await mkdir(this.config.workspace, { recursive: true });
      this.config.workspace = await realpath(this.config.workspace);
      if (inside(this.store.dir, this.config.workspace)) throw fail('附件工作目录不能位于插件凭证目录内');
      await this.save();
    } catch (e) { await this.store.close(); throw e; }
  }
  async save() {
    try { return await this.store.write('runtime', this.state); }
    catch {
      // Do not acknowledge or execute further messages without a durable state record.
      this.stopping = true; this.lifetime.abort();
      throw fail('插件状态无法写入，已停止处理新消息；请检查本机磁盘和权限');
    }
  }
  route(account, message) {
    const key = digest(account.id + ':' + message.from_user_id).slice(0, 32);
    let route = this.state.routes[key];
    if (!route) route = this.state.routes[key] = { key, accountId: account.id, userId: message.from_user_id, contextToken: '', sessionId: null, quotes: [], received: 0, sent: 0 };
    if (message.context_token) route.contextToken = message.context_token;
    return route;
  }
  async start() {
    for (const account of this.accounts.values()) { if (account.paused) account.status = 'paused'; else this.startAccount(account); }
    if (!this.accounts.size) this.logger.info('微信助理尚未绑定账号；请从 DSH 左侧“微信助理”页面扫码绑定。');
  }
  startAccount(account) {
    if (this.accountPollers.has(account.id) || this.stopping) return;
    account.status = 'starting';
    const controller = new AbortController(); this.accountControllers.set(account.id, controller);
    const task = this.poll(account, controller.signal);
    this.pollers.push(task); this.accountPollers.set(account.id, task);
    void task.finally(() => { this.pollers = this.pollers.filter(p => p !== task); if (this.accountPollers.get(account.id) === task) { this.accountPollers.delete(account.id); this.accountControllers.delete(account.id); } }).catch(() => {});
  }
  async stopAccount(id) {
    const account = this.accounts.get(id); if (!account) throw fail('账号不存在');
    account.status = 'pausing';
    this.accountControllers.get(id)?.abort();
    for (const route of Object.values(this.state.routes)) if (route.accountId === id) {
      this.controllers.get(route.key)?.abort(); this.host.stop(route); this.interactions.cancelRoute(route.key);
      for (const entry of this.state.inbox) if (entry.routeKey === route.key && entry.status === 'queued') entry.status = 'cancelled';
    }
    await this.accountPollers.get(id)?.catch(() => {});
    await Promise.allSettled(Object.values(this.state.routes).filter(r => r.accountId === id).flatMap(r => [this.drains.get(r.key), this.sendChains.get(r.key), this.host.handles.get(r.key)?.agent.whenIdle()]).filter(Boolean));
    account.status = 'paused'; await account.api.notify(false).catch(() => {}); await this.save();
  }
  async poll(account, accountSignal) {
    const signal = accountSignal ? AbortSignal.any([this.lifetime.signal, accountSignal]) : this.lifetime.signal; let failures = 0, timeout = 40000;
    await account.api.notify(true, signal).catch(() => {});
    while (!signal.aborted && account.status !== 'expired') {
      try {
        const state = this.state.accounts[account.id];
        const batch = await account.api.updates(state.cursor, signal, timeout);
        account.status = 'connected'; failures = 0;
        timeout = Math.max(10000, Math.min(120000, Number(batch.longpolling_timeout_ms) + 5000 || 40000));
        if (!Array.isArray(batch.msgs || [])) throw fail('微信消息批次格式无效');
        for (const message of batch.msgs || []) { signal.throwIfAborted(); await this.receive(account, message); }
        if (batch.get_updates_buf) state.cursor = batch.get_updates_buf;
        await this.save();
        if (!batch.msgs?.length) await delay(500, undefined, { signal });
      } catch (e) {
        if (signal.aborted) break;
        if (e.code === -14) { account.status = 'expired'; this.logger.warn(`微信账号 ${account.id} 登录已失效，请重新扫码。`); break; }
        account.status = 'reconnecting'; this.logger.warn(`微信账号 ${account.id}：${errorText(e)}`);
        await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal }).catch(() => {});
      }
    }
  }
  async receive(account, message) {
    const allowed = [account.userId, ...(account.allowedPeers || [])];
    if (!message || typeof message !== 'object') return;
    if (message.message_type !== 1 || message.group_id || !allowed.includes(message.from_user_id)) return;
    const id = String(message.message_id || message.client_id || '');
    const accountState = this.state.accounts[account.id];
    if (!id || accountState.seen.includes(id)) return;
    if (!Array.isArray(message.item_list)) return;
    message = { ...message, item_list: message.item_list.filter(item => item && typeof item === 'object') };
    const route = this.route(account, message);
    accountState.seen.push(id); accountState.seen = accountState.seen.slice(-2000); route.received++;
    const text = message.item_list.map(i => i.type === 1 ? (typeof i.text_item?.text === 'string' ? i.text_item.text : '') : i.type === 3 ? (typeof i.voice_item?.text === 'string' ? i.voice_item.text : '') : '').filter(Boolean).join('\n').trim();
    // Write dedup and inbox together before acknowledging the polling cursor.
    // Keep every message out of the task queue until interaction routing finishes.
    const entry = { id, routeKey: route.key, message, control: true, status: 'control', createdAt: Date.now() };
    this.state.inbox.push(entry);
    const unresolved = this.state.inbox.filter(e => ['queued', 'running', 'interrupted'].includes(e.status));
    const completed = this.state.inbox.filter(e => !['queued', 'running', 'interrupted'].includes(e.status) && e.createdAt > Date.now() - 86400000).slice(-200);
    this.state.inbox = [...unresolved, ...completed];
    await this.save();
    try {
      if (['pausing', 'paused'].includes(account.status) || this.accountControllers.get(account.id)?.signal.aborted) { entry.status = 'cancelled'; await this.save(); return; }
      this.recordMessage(route, 'user', text || message.item_list.map(i => ({ 2: '[图片]', 3: '[语音]', 4: '[文件]', 5: '[视频]' })[i.type] || '').join(' '), id);
      if (message.item_list.every(i => i.type === 1 || i.type === 3) && await this.interactions.answer(route, text)) { entry.status = 'completed'; await this.save(); await this.text(route, '已提交你的决定，助理将继续处理。'); return; }
      if (text.startsWith('/')) { entry.status = 'completed'; await this.command(route, text); await this.save(); return; }
      if (message.item_list.length > 20 || text.length > 20000 || unresolved.length >= 1000 || this.state.inbox.filter(e => e.routeKey === route.key && ['queued', 'running'].includes(e.status)).length >= 10) throw fail('消息过长、附件过多或队列已满');
      if (!route.contextToken) throw fail('微信消息缺少回复上下文');
      entry.control = false; entry.status = 'queued'; await this.save();
      void this.drain(route);
    } catch (e) { entry.status = 'failed'; await this.save(); await this.text(route, errorText(e)).catch(() => {}); }
  }
  async command(route, text) {
    if (/^\/(帮助|help)$/.test(text)) return this.text(route, '命令：/状态 /新会话 /停止 /重试 消息编号 /清理中断 /批准 编号 /拒绝 编号 /回答 编号 答案。可以发送文字、图片、文件、视频和语音；发送文件请直接描述文件路径或需求。');
    if (/^\/(状态|status)$/.test(text)) {
      const interrupted = this.state.inbox.filter(e => e.routeKey === route.key && e.status === 'interrupted').map(e => e.id);
      return this.text(route, `微信账号：${route.accountId}\n状态：${this.accounts.get(route.accountId)?.status}\n任务：${this.controllers.has(route.key) ? '执行中' : '空闲'}\n收 ${route.received} / 发 ${route.sent}\n中断任务：${interrupted.join('、') || '无'}`);
    }
    if (/^\/(停止|stop)$/.test(text)) {
      this.controllers.get(route.key)?.abort(); this.host.stop(route); this.interactions.cancelRoute(route.key);
      for (const e of this.state.inbox) if (e.routeKey === route.key && e.status === 'queued') e.status = 'cancelled';
      await this.save(); return this.text(route, '已请求停止，并清空待处理任务。已被微信接收的消息无法撤销。');
    }
    if (/^\/(新会话|new)$/.test(text)) {
      if (this.controllers.has(route.key) || this.drains.has(route.key)) throw fail('请先停止当前任务并等它结束');
      await this.host.newSession(route); return this.text(route, '已创建新的会话入口，下一条消息将使用新会话。');
    }
    const retry = text.match(/^\/重试\s+(\S+)$/);
    if (retry) {
      const entry = this.state.inbox.find(e => e.routeKey === route.key && e.id === retry[1] && !e.control && ['interrupted', 'failed'].includes(e.status));
      if (!entry) throw fail('找不到可重试的消息');
      entry.status = 'queued'; await this.save(); void this.drain(route); return;
    }
    if (/^\/清理中断$/.test(text)) {
      for (const entry of this.state.inbox) if (entry.routeKey === route.key && entry.status === 'interrupted') entry.status = 'cancelled';
      await this.save(); return this.text(route, '已清除当前聊天的中断任务记录，不会重新执行。');
    }
    throw fail('未知命令，发送 /帮助 查看支持的命令');
  }
  async drain(route) {
    if (this.drains.has(route.key) || this.stopping || ['pausing', 'paused'].includes(this.accounts.get(route.accountId)?.status)) return;
    const run = this.processRoute(route); this.drains.set(route.key, run);
    try { await run; } catch (e) { this.logger.warn(errorText(e)); this.stopping = true; this.lifetime.abort(); }
    finally { this.drains.delete(route.key); if (!this.stopping && this.state.inbox.some(e => e.routeKey === route.key && e.status === 'queued')) void this.drain(route); }
  }
  async processRoute(route) {
    while (!this.stopping) {
      const entry = this.state.inbox.find(e => e.routeKey === route.key && e.status === 'queued'); if (!entry) break;
      const controller = new AbortController(); this.controllers.set(route.key, controller);
      const signal = AbortSignal.any([controller.signal, this.lifetime.signal, this.accountControllers.get(route.accountId)?.signal].filter(Boolean));
      const timeout = setTimeout(() => { controller.abort(); this.host.stop(route); }, this.config.taskTimeoutMinutes * 60000);
      entry.status = 'running';
      let typingTimer;
      try {
        await this.save();
        const account = this.accounts.get(route.accountId);
        const config = await account.api.config(route.userId, route.contextToken, signal).catch(() => ({}));
        if (config.typing_ticket) {
          route.typingTicket = config.typing_ticket;
          await account.api.typing(route.userId, config.typing_ticket, 1, signal).catch(() => {});
          typingTimer = setInterval(() => { void account.api.typing(route.userId, config.typing_ticket, 1, signal).catch(() => {}); }, 10000);
        }
        const inbound = await this.inbound(route, entry.message, signal);
        signal.throwIfAborted();
        await this.host.run(route, inbound, signal);
        entry.status = signal.aborted ? 'cancelled' : 'completed';
      } catch (e) {
        entry.status = signal.aborted ? 'cancelled' : 'failed';
        await this.text(route, signal.aborted ? '任务已停止或超时。' : `任务未完成：${errorText(e)}\n消息编号：${entry.id}`).catch(() => {});
      } finally {
        clearInterval(typingTimer); clearTimeout(timeout); this.interactions.cancelRoute(route.key); this.controllers.delete(route.key);
        if (route.typingTicket) await this.accounts.get(route.accountId).api.typing(route.userId, route.typingTicket, 2).catch(() => {});
        delete route.typingTicket; await this.save();
      }
    }
  }
  async inbound(route, message, signal) {
    const text = [], quotes = [], files = [];
    for (const item of message.item_list) {
      if (item.type === 1) text.push(String(item.text_item?.text || ''));
      if (item.voice_item?.text) text.push(String(item.voice_item.text));
      if ([2, 3, 4, 5].includes(item.type) && item[({ 2: 'image', 3: 'voice', 4: 'file', 5: 'video' })[item.type] + '_item']?.media) {
        const folder = path.join(this.config.workspace, 'weixin-inbox', route.key);
        files.push(await downloadItem(this.accounts.get(route.accountId).api, item, folder, { signal, maxBytes: this.config.maxFileMiB * 1048576, root: this.config.workspace }));
      }
      if (item.ref_msg) {
        const ref = item.ref_msg, cached = route.quotes.find(q => q.id === String(ref.svr_id || ''));
        quotes.push(String(ref.message_item?.text_item?.text || ref.title || cached?.text || `[引用 ${ref.svr_id || '未知消息'}：原内容不可用]`).slice(0, 6000));
      }
    }
    const plain = text.join('\n').trim();
    route.quotes.push({ id: String(message.message_id || ''), text: plain.slice(0, 6000) || files.map(f => f.name).join(', ') }); route.quotes = route.quotes.slice(-100);
    if (!plain && !files.length && !quotes.length) throw fail('此消息类型暂无可处理内容');
    await this.save(); return { text: plain, files, quote: quotes.join('\n') };
  }
  serial(route, work) {
    const previous = this.sendChains.get(route.key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.sendChains.set(route.key, next);
    void next.finally(() => { if (this.sendChains.get(route.key) === next) this.sendChains.delete(route.key); }).catch(() => {});
    return next;
  }
  recordMessage(route, role, text, id = '') {
    route.lastActive = Date.now();
    if (role === 'user' && !route.title && text && !text.startsWith('/')) route.title = text.slice(0, 40);
    route.transcript ||= [];
    route.transcript.push({ role, text: String(text).slice(0, 4000), id, time: route.lastActive });
    route.transcript = route.transcript.slice(-120);
  }
  text(route, text, signal) {
    return this.serial(route, async () => {
      if (!signal) signal = this.lifetime.signal;
      const account = this.accounts.get(route.accountId);
      if (!account || ['expired', 'paused', 'pausing'].includes(account.status)) throw fail('微信账号已暂停或登录已过期');
      const accountSignal = this.accountControllers.get(route.accountId)?.signal;
      if (accountSignal) signal = AbortSignal.any([signal, accountSignal]);
      signal.throwIfAborted();
      const receipts = await this.accounts.get(route.accountId).api.sendText(route, text, { signal }); route.sent += receipts.length;
      this.recordMessage(route, 'assistant', text, receipts.at(-1)?.messageId || '');
      for (const receipt of receipts) if (receipt.messageId) route.quotes.push({ id: receipt.messageId, text: text.slice(0, 6000) });
      route.quotes = route.quotes.slice(-100); await this.save(); return receipts;
    });
  }
  async send(route, args, signal, operationId) {
    return this.serial(route, async () => {
      if (this.stopping) throw fail('插件正在停止');
      const id = digest(route.key + ':' + operationId);
      const old = this.state.outbox[id];
      if (old) { if (old.status === 'accepted') return old; throw fail('该发送操作已有记录但结果未确认，未重复发送；请检查微信后重新发起'); }
      const account = this.accounts.get(route.accountId);
      const api = account?.api; if (!api || ['expired', 'paused', 'pausing'].includes(account.status)) throw fail('账号未运行、已暂停或已过期');
      const accountSignal = this.accountControllers.get(route.accountId)?.signal;
      if (accountSignal) signal = AbortSignal.any([signal, accountSignal]);
      signal?.throwIfAborted();
      if (args.caption && args.caption.length > 20000) throw fail('附言过长');
      let attachment, voice, kind = args.kind || 'auto';
      if (args.path) {
        attachment = await readAllowedFile(args.path, [...new Set([this.config.workspace, ...this.config.allowedRoots])], this.store.dir, this.config.maxFileMiB * 1048576);
        if (kind === 'auto') kind = inferKind(attachment.name);
        if (kind === 'voice') voice = await prepareVoice(attachment.data, { signal, ffmpegPath: this.config.ffmpegPath, maxVoiceSeconds: this.config.maxVoiceSeconds });
      } else if (!args.text) throw fail('需要提供文字或文件路径');
      const record = { id, status: 'preparing', at: Date.now(), name: attachment?.name || null, clientId: randomUUID(), messageId: null };
      this.state.outbox[id] = record; await this.save();
      try {
        let item;
        if (attachment) {
          const result = await upload(api, route, voice?.data || attachment.data, kind, { signal, maxBytes: this.config.maxFileMiB * 1048576 });
          item = mediaItem(kind, result, attachment.name, voice || {});
        }
        record.status = 'sending'; await this.save();
        if (args.caption) await api.sendText(route, args.caption, { signal });
        let receipt;
        const quote = args.quoteId ? { svr_id: args.quoteId } : undefined;
        if (item) receipt = await api.sendItem(route, { ...item, ...(quote ? { ref_msg: quote } : {}) }, { signal, clientId: record.clientId });
        else { const results = await api.sendText(route, args.text, { signal, quote }); receipt = results.at(-1); }
        record.status = 'accepted'; record.messageId = receipt?.messageId || null; route.sent++;
        this.recordMessage(route, 'assistant', attachment ? `[${kind === 'voice' ? '语音' : '附件'}] ${attachment.name}${args.caption ? '\n' + args.caption : ''}` : args.text, record.messageId || '');
        if (record.messageId) route.quotes.push({ id: record.messageId, text: (args.text || attachment.name).slice(0, 6000) }); route.quotes = route.quotes.slice(-100);
        await this.save(); return record;
      } catch (e) {
        if (record.status !== 'accepted') record.status = record.status === 'sending' ? 'unknown' : 'failed';
        await this.save(); throw e;
      }
    });
  }
  routeFor(agent, accountId) {
    const own = this.host.owns(agent); if (own) { if (accountId && own.accountId !== accountId) throw fail('当前微信会话不能切换收件账号'); return own; }
    if (!accountId) throw fail('请指定账号名称；从微信发起的任务可自动确定收件人');
    const account = this.accounts.get(accountId); if (!account) throw fail('指定账号未运行');
    const route = Object.values(this.state.routes).find(r => r.accountId === accountId && r.userId === account.userId && r.contextToken);
    if (!route) throw fail('请先从该账号的微信聊天发送一条消息'); return route;
  }
  close() { this.closing ||= this.performClose(); return this.closing; }
  async performClose() {
    this.stopping = true; this.lifetime.abort(); this.interactions.close();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pollers);
    await this.host?.close(); await Promise.allSettled(this.drains.values()); await Promise.allSettled(this.sendChains.values());
    await Promise.allSettled([...this.accounts.values()].map(a => a.api.notify(false)));
    try { await this.save(); } finally { await this.store.close(); }
  }
}
