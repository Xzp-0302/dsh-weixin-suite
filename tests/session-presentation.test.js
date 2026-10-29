import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { organizeSession } from '../src/session-presentation.js';

test('会话归入命名分组，并使用账号与首条需求作为标题', async () => {
  const cwd = path.resolve('workspace'), attached = [];
  let title;
  const group = { path: cwd, title: path.basename(cwd), setTitle: async value => { group.title = value; }, attachSession: async id => attached.push(id) };
  const services = { workspaceRegistry: { create: async (folder, name) => { assert.equal(folder, cwd); assert.equal(name, '微信助理'); return group; } }, sessionTitle: { get: () => null, rename: (session, value) => { title = value; } } };
  await organizeSession({ get: key => services[key] }, { workspace: cwd }, { title: '整理照片' }, { session: { id: 'weixin-1', header: { cwd } } }, { label: '日常助理' });
  assert.equal(group.title, '微信助理');
  assert.deepEqual(attached, ['weixin-1']);
  assert.equal(title, '微信 · 日常助理 · 整理照片');
});

test('保留用户改过的分组名和会话标题', async () => {
  const services = { workspaceRegistry: { create: async () => ({ title: '我的微信任务', path: path.resolve('workspace'), setTitle: () => assert.fail(), attachSession: async () => {} }) }, sessionTitle: { get: () => ({ title: '自定义标题' }), rename: () => assert.fail() } };
  await organizeSession({ get: key => services[key] }, { workspace: '.' }, {}, { session: { id: 'a' } });
});
