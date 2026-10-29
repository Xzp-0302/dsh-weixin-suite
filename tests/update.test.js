import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceGitBundle } from '../src/update.js';

const sha = 'a'.repeat(40);
const manifest = { name: 'dsh-weixin-suite', version: '0.1.0-rc.3', dsh: { bundle: { patch: './cordis.patch.yml' } } };
const previous = { name: manifest.name, installed: true, availability: 'profile', enabled: true, source: 'original-git-source' };
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('更新预检使用同源 GitHub API，固定提交并在卸载前验证清单', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `https://api.github.com/repos/Xzp-0302/dsh-weixin-suite/contents/package.json?ref=${sha}`);
    assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
    calls.push('fetch'); return Response.json(manifest);
  };
  const manager = { listBundles: async () => [previous], removeBundle: async () => { calls.push('remove'); return { application: 'applied' }; }, installBundle: async spec => { calls.push('install'); assert.ok(spec.endsWith('#' + sha)); return { application: 'restart-required' }; } };
  const phases = [];
  assert.equal((await replaceGitBundle(manager, sha, { onStage: phase => phases.push(phase) })).application, 'restart-required');
  assert.deepEqual(calls, ['fetch', 'remove', 'install']);
  assert.deepEqual(phases, ['checking', 'removing', 'installing']);
});

test('连接超时返回可展示原因，保留当前安装且不会调用管理器', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); };
  await assert.rejects(replaceGitBundle({ listBundles: () => assert.fail('网络预检失败不应触碰安装') }, sha), error => /连接超时/.test(error.publicMessage) && /保持原样/.test(error.publicMessage));
});

test('HTTP 错误及无效清单在卸载前失败', async () => {
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(replaceGitBundle({}, sha), /HTTP 403/);
  globalThis.fetch = async () => Response.json({ name: 'another-plugin' });
  await assert.rejects(replaceGitBundle({}, sha), /有效的微信助理/);
});

test('安装失败携带原生错误码及阶段，恢复原来源和启用状态', async () => {
  globalThis.fetch = async () => Response.json(manifest);
  const installed = [];
  const manager = { listBundles: async () => [previous], removeBundle: async () => ({ application: 'applied' }), installBundle: async (spec, options) => { installed.push(spec); assert.equal(options.enabled, true); return spec === previous.source ? { application: 'applied' } : { application: 'failed', error: { code: 'network' }, failedAt: 'spec-host' }; } };
  await assert.rejects(replaceGitBundle(manager, sha), /network \/ spec-host/);
  assert.equal(installed.at(-1), previous.source);
});
