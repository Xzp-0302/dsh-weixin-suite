import { randomBytes } from 'node:crypto';
import { fail } from './security.js';

// Install after the preset, in the exact agent scope. Global sibling answerers
// (including the desktop gateway) must never claim a WeChat-owned request first.
export function* registerInteractions(ctx, channel, agent) {
  for (const [event, kind] of [['approval/request', 'approval'], ['user-questions/request', 'questions']]) {
    yield ctx.on(event, (request, next) => {
      const route = request.agent === agent && channel.host.owns(agent);
      return route ? channel.interactions.ask(route, kind, request) : next();
    }, { prepend: true });
  }
}

export function plainText(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  return text.replace(/\r\n/g, '\n').replace(/^```[^\n]*\n|^```\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').trim();
}

export function approvalDetail(request) {
  const session = request.agent?.session;
  if (!request.callId) return '';
  if (session?.eventAt && Number.isSafeInteger(session.seq)) {
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq);
      if (event?.type === 'tool/call' && String(event.data.callId) === String(request.callId)) return plainText(event.data.arguments ?? event.data.input ?? '');
    }
    return '';
  }
  const events = session?.snapshotEvents?.() || session?.events || [];
  const call = request.callId && events.findLast(e => e.type === 'tool/call' && String(e.data.callId) === String(request.callId));
  return plainText(call?.data.arguments ?? call?.data.input ?? '');
}

export function interactionText(id, kind, request) {
  if (kind === 'approval') return [
    '操作审批 · ' + id, '', '工具：' + plainText(request.toolName),
    '原因：' + (plainText(request.reason) || '请求执行操作'),
    approvalDetail(request) && '操作内容：\n' + approvalDetail(request), '',
    '仅批准本次操作：', '/批准 ' + id, '', '拒绝本次操作：', '/拒绝 ' + id,
    '', '只有一个待审批时，也可直接回复“批准”或“拒绝”。',
  ].filter(x => x !== false).join('\n');
  return ['请你确认 · ' + id, '', ...request.questions.flatMap((q, i) => [
    `${i + 1}. ${plainText(q.header) ? plainText(q.header) + ' · ' : ''}${plainText(q.question)}`,
    ...(q.detail ? [plainText(q.detail)] : []),
    ...(q.options || []).map((o, n) => `${n + 1}) ${plainText(o.label)}${o.description ? '\n   ' + plainText(o.description) : ''}`),
    ...(q.multiSelect ? ['可多选，用逗号分隔序号。'] : []), '',
  ]), '回复：/回答 ' + id + ' 答案', '多题用 | 分隔。只有一个待回答请求时，可直接回复答案。'].join('\n');
}

export class Interactions {
  constructor(send, timeoutMs = 300000, late = {}) { this.send = send; this.timeoutMs = timeoutMs; this.pending = new Map(); this.late = late; }
  async ask(route, kind, request) {
    request.signal?.throwIfAborted();
    const id = randomBytes(4).toString('hex').toUpperCase();
    const delivery = new AbortController();
    const deliverySignal = request.signal ? AbortSignal.any([request.signal, delivery.signal]) : delivery.signal;
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // Attach a rejection handler before sending the prompt (abort can occur while send awaits).
    void promise.catch(() => {});
    const finish = (value, error) => {
      const entry = this.pending.get(id); if (!entry) return;
      this.pending.delete(id); clearTimeout(entry.timer); request.signal?.removeEventListener('abort', entry.abort);
      delivery.abort();
      error ? settle.reject(error) : settle.resolve(value);
    };
    const timedOut = reason => {
      if (kind === 'questions' && request.wait?.timed) {
        route.questions ||= [];
        route.questions.push({ id, callId: String(request.wait.callId), questions: request.questions });
        route.questions = route.questions.slice(-20);
        this.late.save?.();
      }
      finish(null, reason);
    };
    const abort = () => {
      const reason = request.signal?.reason;
      if (kind === 'questions' && request.wait?.timed && reason?.code === 'ASK_TIMED_OUT') return timedOut(reason);
      finish(kind === 'approval' ? 'cancelled' : null, kind === 'approval' ? null : fail('问题已取消'));
    };
    const timer = setTimeout(() => {
      if (kind === 'questions' && request.wait?.timed) return timedOut(Object.assign(new Error('回答等待超时，可用原编号补答'), { name: 'UserQuestionError', code: 'ASK_TIMED_OUT' }));
      finish(kind === 'approval' ? 'unavailable' : null, kind === 'approval' ? null : fail('回答等待超时'));
    }, this.timeoutMs);
    this.pending.set(id, { route: route.key, kind, request, finish, abort, timer });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    // Hold the native foreground countdown just like its desktop answer card.
    // Our configured timeout remains authoritative and retains a late-answer ticket.
    const questions = request.agent?.ctx?.get('userQuestions');
    if (kind === 'questions' && request.wait?.timed && questions?.attachWait && this.pending.has(id)) {
      void (async () => { for await (const _ of questions.attachWait(request.agent, request.wait.callId, deliverySignal)) { /* hold until settled */ } })()
        .catch(() => { if (!deliverySignal.aborted) finish(null, fail('无法等待原生问题，请重新发起')); });
    }
    // Sending must not delay settlement after a reply, timeout, or cancellation.
    void Promise.resolve().then(() => {
      if (this.pending.has(id)) return this.send(route, interactionText(id, kind, request), deliverySignal);
    }).catch(() => finish(kind === 'approval' ? 'unavailable' : null, kind === 'approval' ? null : fail('问题发送失败')));
    return promise;
  }
  replyText(route, input) {
    const text = input.trim().replace(/^／/, '/');
    if (/^\/(批准|拒绝|回答)(?:\s|$)/.test(text)) return text;
    if (!text || text.startsWith('/')) return null;
    const entries = [...this.pending.entries()].filter(([, e]) => e.route === route.key);
    if (!entries.length) return null;
    if (entries.length > 1) {
      if (/^(批准|同意|允许|拒绝|不同意|不允许)[。！!]?$/u.test(text) || entries.some(([, e]) => e.kind === 'questions')) throw fail('有多个等待中的请求，请使用带编号的 /批准、/拒绝 或 /回答');
      return null;
    }
    const [id, entry] = entries[0];
    if (entry.kind === 'questions') return `/回答 ${id} ${text}`;
    if (/^(批准|同意|允许)[。！!]?$/u.test(text)) return `/批准 ${id}`;
    if (/^(拒绝|不同意|不允许)[。！!]?$/u.test(text)) return `/拒绝 ${id}`;
    return null;
  }
  async answer(route, text) {
    text = this.replyText(route, text);
    if (text === null) return false;
    const match = text.match(/^\/(批准|拒绝|回答)\s+([A-F0-9]{8})(?:\s+([\s\S]+))?$/i);
    if (!match) throw fail('格式无效，请使用 /批准 编号、/拒绝 编号 或 /回答 编号 答案');
    const id = match[2].toUpperCase();
    let entry = this.pending.get(id);
    if (!entry) {
      const ticket = route.questions?.find(q => q.id === id);
      if (!ticket || match[1] !== '回答' || !this.late.answer) throw fail('该请求不存在、已过期或不属于当前会话');
      entry = { route: route.key, kind: 'questions', request: { questions: ticket.questions }, finish: value => this.late.answer(route, ticket.callId, value) };
    }
    if (entry.route !== route.key) throw fail('该请求不属于当前会话');
    if (entry.kind === 'approval') {
      if (match[1] === '回答') throw fail('请使用 /批准 或 /拒绝');
      if (match[3]) throw fail('审批命令后不能附加其他内容，请明确选择 /批准 编号 或 /拒绝 编号');
      entry.finish(match[1] === '批准' ? 'allowed-once' : 'rejected'); return true;
    }
    if (match[1] !== '回答' || !match[3]) throw fail('请使用 /回答 编号 答案');
    const parts = match[3].split('|').map(x => x.trim());
    if (parts.length !== entry.request.questions.length || parts.some(x => !x)) throw fail('请按顺序回答全部问题，多题用 | 分隔');
    const answers = entry.request.questions.map((question, i) => {
      const text = parts[i], options = question.options || [];
      const indices = /^\d+(?:\s*[,，]\s*\d+)*$/.test(text) && options.length ? text.split(/\s*[,，]\s*/).map(Number) : [];
      if (indices.length && indices.some(n => n < 1 || n > options.length)) throw fail('选项序号超出范围');
      const selected = indices.length ? [...new Set(indices)].map(n => options[n - 1].label) : options.some(o => o.label === text) ? [text] : [];
      if (!question.multiSelect && selected.length > 1) throw fail('该题只能选择一个选项');
      if (question.intent?.kind === 'approval' && selected.length !== 1) throw fail('权限问题必须选择提供的选项');
      return { id: question.id, selected, ...(selected.length ? {} : { custom: text }) };
    });
    await entry.finish({ answers });
    if (route.questions?.some(q => q.id === id)) { route.questions = route.questions.filter(q => q.id !== id); this.late.save?.(); }
    return true;
  }
  cancelRoute(key) { for (const entry of [...this.pending.values()]) if (entry.route === key) entry.abort(); }
  close() { for (const entry of [...this.pending.values()]) entry.abort(); }
}
