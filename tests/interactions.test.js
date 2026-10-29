import test from 'node:test';
import assert from 'node:assert/strict';
import { Interactions, interactionText, registerInteractions } from '../src/interactions.js';

const route = () => ({ key: 'chat-a', questions: [] });
const question = { id: 'q1', question: '选择方案', options: [{ label: '甲' }, { label: '乙' }], multiSelect: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
function pending(interactions, r, kind = 'approval', extra = {}) {
  const promise = interactions.ask(r, kind, { toolName: 'delete_file', reason: '**删除测试文件**', questions: [question], ...extra });
  return { promise, id: [...interactions.pending.keys()].at(-1) };
}

test('自然语言审批结算原请求，不是新模型消息；只授权一次', async () => {
  const interactions = new Interactions(async () => {}), r = route();
  const { promise, id } = pending(interactions, r);
  assert.equal(await interactions.answer(r, '同意'), true);
  assert.equal(await promise, 'allowed-once');
  await assert.rejects(interactions.answer(r, '/批准 ' + id), /已过期/);
  assert.equal(await interactions.answer(r, '同意'), false);
});

test('拒绝、跨会话与模糊回复不会误授权', async () => {
  const interactions = new Interactions(async () => {}), r = route();
  const { promise, id } = pending(interactions, r);
  await assert.rejects(interactions.answer({ key: 'chat-b' }, '/批准 ' + id), /不属于/);
  await assert.rejects(interactions.answer(r, '/批准 ' + id + ' 不要删除'), /不能附加/);
  assert.equal(await interactions.answer(r, '先看看这个文件'), false);
  await interactions.answer(r, '不同意');
  assert.equal(await promise, 'rejected');
});

test('并发请求要求编号，不能猜测授权对象', async () => {
  const interactions = new Interactions(async () => {}), r = route();
  const a = pending(interactions, r), b = pending(interactions, r);
  await assert.rejects(interactions.answer(r, '批准'), /多个/);
  await interactions.answer(r, '/批准 ' + a.id);
  await interactions.answer(r, '/拒绝 ' + b.id);
  assert.equal(await a.promise, 'allowed-once');
  assert.equal(await b.promise, 'rejected');
});

test('多题、多选与自由回答映射为 DSH 原生结果', async () => {
  const interactions = new Interactions(async () => {}), r = route();
  const { promise, id } = pending(interactions, r, 'questions', { questions: [question, { id: 'q2', question: '说明' }] });
  await assert.rejects(interactions.answer(r, `/回答 ${id} 3 | 好`), /超出/);
  await interactions.answer(r, '1， 2 | 按计划执行');
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['甲', '乙'] }, { id: 'q2', selected: [], custom: '按计划执行' }] });
});

test('计划确认仍按原选项交回，不擅自改为权限授予', async () => {
  const interactions = new Interactions(async () => {}), r = route();
  const q = { id: 'plan', question: '确认计划？', detail: '# 计划\n**步骤**', options: [{ label: '继续' }, { label: '修改' }], intent: { kind: 'plan-review', approve: '继续' } };
  const { promise } = pending(interactions, r, 'questions', { questions: [q] });
  await interactions.answer(r, '2');
  assert.deepEqual(await promise, { answers: [{ id: 'plan', selected: ['修改'] }] });
});

test('发送阻塞不妨碍取消和回答；失败及时撤销', async () => {
  const interactions = new Interactions(() => new Promise(() => {})), r = route();
  const a = pending(interactions, r); await tick();
  interactions.cancelRoute(r.key);
  assert.equal(await a.promise, 'cancelled');
  const b = pending(interactions, r); await tick();
  await interactions.answer(r, '批准');
  assert.equal(await b.promise, 'allowed-once');
  const failed = new Interactions(async () => { throw new Error('offline'); });
  assert.equal(await pending(failed, r).promise, 'unavailable');
});

test('等待超时与预先取消均不遗留入口', async () => {
  const interactions = new Interactions(async () => {}, 10), r = route();
  assert.equal(await pending(interactions, r).promise, 'unavailable');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(interactions.ask(r, 'approval', { signal: abort.signal }));
  assert.equal(interactions.pending.size, 0);
});

test('定时提问保留补答，并将结果交给原 callId', async () => {
  let received;
  const interactions = new Interactions(async () => {}, 1000, { answer: async (...args) => { received = args; } });
  const r = route(), abort = new AbortController();
  const { promise, id } = pending(interactions, r, 'questions', { signal: abort.signal, wait: { timed: true, callId: 'original-call' } });
  abort.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }));
  await assert.rejects(promise, /timed out/);
  await interactions.answer(r, `/回答 ${id} 1`);
  assert.equal(received[1], 'original-call');
  assert.equal(r.questions.length, 0);
});

test('微信审批展示原因、操作参数和独立命令行', () => {
  const text = interactionText('1234ABCD', 'approval', { toolName: 'delete_file', reason: '**删除** `demo.txt`', callId: 'call', agent: { session: { events: [{ type: 'tool/call', data: { callId: 'call', arguments: { path: 'demo.txt' } } }] } } });
  assert.match(text, /原因：删除 demo.txt/);
  assert.match(text, /demo.txt/);
  assert.match(text, /\n\/批准 1234ABCD\n/);
  assert.doesNotMatch(text, /\*\*|\[object Object\]/);
});

test('接管原生定时等待，并在插件超时后释放占用及保留补答', async () => {
  let held = false, released = false;
  const service = { async *attachWait(agent, callId, signal) {
    assert.equal(callId, 'timed-call'); held = true;
    try { yield { remainingMs: 5 }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { released = true; }
  } };
  const r = route(), interactions = new Interactions(async () => {}, 25);
  const { promise } = pending(interactions, r, 'questions', { agent: { ctx: { get: () => service } }, wait: { timed: true, callId: 'timed-call' } });
  await assert.rejects(promise, error => error.name === 'UserQuestionError' && error.code === 'ASK_TIMED_OUT');
  await tick();
  assert.ok(held && released);
  assert.equal(r.questions[0].callId, 'timed-call');
  assert.equal(interactions.pending.size, 0);
});

test('精确 Agent 接管审批与提问，其他 Agent 交给原应答者，卸载撤销监听', async () => {
  const listeners = new Map(), agent = {}, r = route();
  const ctx = { on(event, cb, options) { assert.equal(options.prepend, true); listeners.set(event, cb); return () => listeners.delete(event); } };
  const interactions = new Interactions(async () => {});
  const disposers = [...registerInteractions(ctx, { host: { owns: value => value === agent && r }, interactions }, agent)];
  for (const [event, kind] of [['approval/request', 'approval'], ['user-questions/request', 'questions']]) {
    const result = listeners.get(event)({ agent, toolName: 'delete_file', questions: [question] }, () => assert.fail('不应弹出桌面审批'));
    await interactions.answer(r, kind === 'approval' ? '批准' : '1');
    assert.ok(await result);
    assert.equal(await listeners.get(event)({ agent: {} }, () => 'desktop'), 'desktop');
  }
  disposers.forEach(dispose => dispose());
  assert.equal(listeners.size, 0);
});
