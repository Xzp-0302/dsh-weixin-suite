#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { Store } from '../src/store.js';
import { WeixinApi, login } from '../src/api.js';
import { assertId, defaultStateDir, errorText, fail } from '../src/security.js';

function argsOf(values) {
  const result = { command: values[0] || 'help' };
  for (let i = 1; i < values.length; i++) {
    if (!['--state-dir', '--account', '--peer', '--days'].includes(values[i]) || !values[i + 1] || values[i + 1].startsWith('--')) throw fail('未知参数或缺少参数值');
    result[values[i].slice(2)] = values[++i];
  }
  return result;
}
async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.command === 'help') {
    console.log('dsh-weixin <login|list|logout|allow-peer|remove-peer|unlock|prune> --state-dir <插件独立状态目录> [--account 名称] [--peer 用户ID] [--days 天数]\n先停用插件再运行管理命令；同一状态目录只允许一个写入进程。不要指定已有桥接的状态目录。\nlogin 通过扫码创建本插件专用绑定，不读取其他程序凭证。'); return;
  }
  if (!['login', 'list', 'logout', 'allow-peer', 'remove-peer', 'unlock', 'prune'].includes(args.command)) throw fail('未知管理命令');
  const dir = args['state-dir'] || process.env.DSH_WEIXIN_SUITE_STATE_DIR || defaultStateDir();
  if (/(^|[\\/])wechat-bridge-state([\\/]|$)/i.test(path.resolve(dir))) throw fail('禁止使用现有桥接服务的状态目录');
  const store = await new Store(dir).init();
  if (args.command === 'unlock') { await store.unlockStale(); console.log('已移除死亡进程留下的锁。'); return; }
  if (args.command === 'list') {
    const accounts = await store.loadAccounts(); console.log(JSON.stringify({ stateDir: store.dir, accounts: accounts.map(a => ({ account: a.id, additionalPeers: a.allowedPeers?.length || 0 })) }, null, 2)); return;
  }
  await store.lock();
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const lifetime = new AbortController(); const stop = () => lifetime.abort(); process.once('SIGINT', stop);
  try {
    const accounts = await store.loadAccounts();
    if (args.command === 'prune') {
      const days = Number(args.days || 30); if (!Number.isInteger(days) || days < 1) throw fail('days 必须为正整数');
      const runtime = await store.read('runtime', null);
      if (runtime) {
        const cutoff = Date.now() - days * 86400000;
        runtime.inbox = runtime.inbox.filter(e => ['queued', 'running', 'interrupted'].includes(e.status) || e.createdAt >= cutoff);
        runtime.outbox = Object.fromEntries(Object.entries(runtime.outbox).filter(([, e]) => e.at >= cutoff || e.status === 'unknown'));
        await store.write('runtime', runtime);
      }
      console.log('已清理过期的已完成消息元数据；附件文件和未确认操作保留。'); return;
    }
    const id = assertId(args.account || 'default'), current = accounts.find(a => a.id === id);
    if (args.command === 'login') {
      if (!current && accounts.length >= 16) throw fail('最多可登记 16 个账号');
      console.log('请绑定一个供本插件使用的微信机器人。若微信提示替换其他应用的已有绑定，请取消，以免影响该应用。');
      if (current && (await input.question(`账号 ${id} 已存在，重新绑定会替换本插件该账号。输入 REBIND 继续：`, { signal: lifetime.signal })).trim() !== 'REBIND') return;
      const result = await login(new WeixinApi(), {
        tokens: accounts.map(a => a.token), signal: lifetime.signal,
        display: async url => { const qr = await import('qrcode-terminal'); qr.default.generate(url, { small: true }); console.log('请用手机微信扫描上方二维码。'); },
        verification: async signal => (await input.question('输入手机显示的配对数字：', { signal })).trim(),
      });
      if (result.alreadyBound) { if (!current) throw fail('微信提示已有绑定，但本插件没有该账号凭证；请在微信中确认机器人归属'); console.log('微信提示此实例已绑定，原凭证保持不变。'); return; }
      if (accounts.some(a => a.id !== id && a.botId === result.botId)) throw fail('同一机器人不能登记为两个账号');
      await store.write('accounts', [...accounts.filter(a => a.id !== id), { id, ...result, allowedPeers: [], createdAt: Date.now() }]);
      await resetAccountState(store, id); console.log(`账号 ${id} 绑定完成。启用插件后，从微信发送一条消息。`);
    } else {
      if (!current) throw fail('找不到指定账号');
      if (args.command === 'logout') {
        if ((await input.question(`只移除本插件账号 ${id} 的本地绑定。输入 REMOVE 继续：`, { signal: lifetime.signal })).trim() !== 'REMOVE') return;
        await store.write('accounts', accounts.filter(a => a.id !== id)); await resetAccountState(store, id);
        console.log('本插件的本地绑定已移除；服务端解绑请在微信中操作。');
      } else {
        const peer = args.peer?.trim(); if (!peer || peer.length > 256 || /[\s\x00-\x1f]/.test(peer)) throw fail('需要有效的 --peer 用户 ID');
        if (args.command === 'allow-peer') {
          if ((current.allowedPeers || []).length >= 32) throw fail('每个账号最多额外允许 32 个私聊用户');
          if ((await input.question('该用户将能通过微信驱动本机 Harness。输入 ALLOW 继续：', { signal: lifetime.signal })).trim() !== 'ALLOW') return;
          current.allowedPeers = [...new Set([...(current.allowedPeers || []), peer])];
        } else current.allowedPeers = (current.allowedPeers || []).filter(p => p !== peer);
        await store.write('accounts', accounts); console.log('已更新此账号的私聊用户名单。');
      }
    }
  } finally { input.close(); process.removeListener('SIGINT', stop); await store.close(); }
}
async function resetAccountState(store, id) {
  const runtime = await store.read('runtime', null); if (!runtime) return;
  delete runtime.accounts[id];
  const keys = new Set(Object.values(runtime.routes).filter(r => r.accountId === id).map(r => r.key));
  runtime.routes = Object.fromEntries(Object.entries(runtime.routes).filter(([, r]) => r.accountId !== id));
  runtime.inbox = runtime.inbox.filter(e => !keys.has(e.routeKey)); await store.write('runtime', runtime);
}
main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
