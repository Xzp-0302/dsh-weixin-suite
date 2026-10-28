import { randomBytes } from 'node:crypto';
import { fail } from './security.js';

export class Interactions {
  constructor(send, timeoutMs = 300000, late = {}) { this.send = send; this.timeoutMs = timeoutMs; this.pending = new Map(); this.late = late; }
  async ask(route, kind, request) {
    request.signal?.throwIfAborted();
    const id = randomBytes(4).toString('hex').toUpperCase();
    let settle;
    const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    // Attach a rejection handler before sending the prompt (abort can occur while send awaits).
    void promise.catch(() => {});
    const finish = (value, error) => {
      const entry = this.pending.get(id); if (!entry) return;
      this.pending.delete(id); clearTimeout(entry.timer); request.signal?.removeEventListener('abort', entry.abort);
      error ? settle.reject(error) : settle.resolve(value);
    };
    const abort = () => {
      const reason = request.signal?.reason;
      if (kind === 'questions' && request.wait?.timed && reason?.code === 'ASK_TIMED_OUT') {
        route.questions ||= [];
        route.questions.push({ id, callId: String(request.wait.callId), questions: request.questions });
        route.questions = route.questions.slice(-20);
        this.late.save?.();
        finish(null, reason); return;
      }
      finish(kind === 'approval' ? 'cancelled' : null, kind === 'approval' ? null : fail('问题已取消'));
    };
    const timer = setTimeout(() => finish(kind === 'approval' ? 'unavailable' : null, kind === 'approval' ? null : fail('回答等待超时')), this.timeoutMs);
    this.pending.set(id, { route: route.key, kind, request, finish, abort, timer });
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    let text;
    if (kind === 'approval') text = `需要批准 ${id}\n工具：${request.toolName}\n${request.reason || '请求执行操作'}\n回复 /批准 ${id} 或 /拒绝 ${id}；仅本次有效。`;
    else text = `需要回答 ${id}\n` + request.questions.map((q, i) => `${i + 1}. ${q.question}${q.detail ? '\n' + q.detail : ''}\n${(q.options || []).map((o, n) => `${n + 1}) ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n')}${q.multiSelect ? '\n可多选，用逗号分隔序号。' : ''}`).join('\n\n') + `\n回复 /回答 ${id} 答案；多题用 | 分隔，可填选项序号或文字。`;
    try { if (this.pending.has(id)) await this.send(route, text, request.signal); }
    catch { finish(kind === 'approval' ? 'unavailable' : null, kind === 'approval' ? null : fail('问题发送失败')); }
    return promise;
  }
  async answer(route, text) {
    const match = text.match(/^\/(批准|拒绝|回答)\s+([A-F0-9]{8})(?:\s+([\s\S]+))?$/i);
    if (!match) return false;
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
      entry.finish(match[1] === '批准' ? 'allowed-once' : 'rejected'); return true;
    }
    if (match[1] !== '回答' || !match[3]) throw fail('请使用 /回答 编号 答案');
    const parts = match[3].split('|').map(x => x.trim());
    if (parts.length !== entry.request.questions.length || parts.some(x => !x)) throw fail('请按顺序回答全部问题，多题用 | 分隔');
    const answers = entry.request.questions.map((question, i) => {
      const text = parts[i], options = question.options || [];
      const indices = /^\d+(?:[,，]\s*\d+)*$/.test(text) && options.length ? text.split(/[,，]\s*/).map(Number) : [];
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
