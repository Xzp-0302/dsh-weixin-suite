import test from 'node:test';
import assert from 'node:assert/strict';
import { Channel } from '../src/channel.js';

function setup() {
  const channel = new Channel({ stateDir: '.', interactionTimeoutSeconds: 30 }, console);
  channel.state = { accounts: { account: { seen: [] } }, routes: {}, inbox: [] };
  const account = { id: 'account', userId: 'peer', status: 'connected' };
  channel.accounts.set(account.id, account);
  channel.text = async () => {};
  const message = text => ({ message_type: 1, from_user_id: 'peer', message_id: Math.random().toString(), context_token: 'test-only', item_list: [{ type: 1, text_item: { text } }] });
  return { channel, account, message };
}

test('接收审批回复时，即使并发保存/任务收尾，也不会成为 queued 模型任务', async () => {
  const { channel, account, message } = setup();
  const reply = message('批准'), route = channel.route(account, reply);
  const result = channel.interactions.ask(route, 'approval', { toolName: 'delete_file' });
  let drains = 0;
  channel.drain = async () => { drains++; };
  channel.save = async () => { await Promise.resolve(); assert.equal(channel.state.inbox.filter(e => e.status === 'queued').length, 0); };
  await channel.receive(account, reply);
  assert.equal(await result, 'allowed-once');
  assert.equal(drains, 0);
  assert.equal(channel.state.inbox[0].control, true);
  assert.equal(channel.state.inbox[0].status, 'completed');
});

test('带媒体的转写语音可以拒绝审批，不需要另开任务', async () => {
  const { channel, account, message } = setup();
  const reply = message(''); reply.item_list = [{ type: 3, voice_item: { text: '拒绝', media: {} } }];
  const route = channel.route(account, reply);
  const result = channel.interactions.ask(route, 'approval', { toolName: 'delete_file' });
  channel.save = async () => {}; channel.drain = () => assert.fail('审批不应启动新任务');
  await channel.receive(account, reply);
  assert.equal(await result, 'rejected');
});

test('普通任务经过交互分类后才入队；去重仍然有效', async () => {
  const { channel, account, message } = setup();
  let drains = 0; channel.drain = () => { drains++; };
  channel.save = async () => {};
  const task = message('请整理文档');
  await channel.receive(account, task); await channel.receive(account, task);
  assert.equal(channel.state.inbox.length, 1);
  assert.equal(channel.state.inbox[0].control, false);
  assert.equal(channel.state.inbox[0].status, 'queued');
  assert.equal(drains, 1);
});
