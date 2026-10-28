import { mkdir, readFile, writeFile, rename, rm, chmod, open, lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertId, defaultStateDir, homePath, fail } from './security.js';
const execFileAsync = promisify(execFile);

export class Store {
  constructor(dir = defaultStateDir()) { this.dir = homePath(dir); this.chain = Promise.resolve(); this.release = null; }
  async init() {
    if (/(^|[\\/])wechat-bridge-state([\\/]|$)/i.test(this.dir)) throw fail('禁止使用现有桥接服务的状态目录');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dir)).isSymbolicLink()) throw fail('状态目录不能是符号链接');
    this.dir = await realpath(this.dir);
    if (/(^|[\\/])wechat-bridge-state([\\/]|$)/i.test(this.dir)) throw fail('禁止使用现有桥接服务的状态目录');
    const marker = '.dsh-weixin-suite';
    const entries = await readdir(this.dir);
    if (!entries.includes(marker) && entries.length) throw fail('状态目录必须为空，或已由本插件创建；不能复用其他程序目录');
    if (!entries.includes(marker)) await writeFile(path.join(this.dir, marker), 'dsh-weixin-suite/v1\n', { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      // Local username is an argv value, never shell interpolation. No credential content goes to stdout.
      await execFileAsync('icacls.exe', [this.dir, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
    } else await chmod(this.dir, 0o700);
    return this;
  }
  async lock() {
    const file = path.join(this.dir, 'owner.lock');
    const nonce = randomUUID();
    try { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); } finally { await handle.close(); } }
    catch (e) {
      if (e.code === 'EEXIST') throw fail('这个状态目录已有插件或管理命令占用；请先停止对应实例，异常退出后使用 unlock 命令');
      throw e;
    }
    this.release = async () => {
      const owner = JSON.parse(await readFile(file, 'utf8'));
      if (owner.nonce === nonce) await rm(file);
    };
  }
  async unlockStale() {
    const file = path.join(this.dir, 'owner.lock');
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw fail('锁记录损坏，请人工检查');
    try { process.kill(owner.pid, 0); throw fail('锁所属进程仍在运行，不能解锁'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await rm(file);
  }
  async read(name, fallback) {
    if (!['accounts', 'runtime'].includes(name)) throw fail('无效的插件状态文件');
    try {
      const file = path.join(this.dir, name + '.json');
      if ((await lstat(file)).isSymbolicLink()) throw fail('状态文件不能是符号链接');
      return JSON.parse(await readFile(file, 'utf8'));
    }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw fail('插件状态损坏，已停止以免覆盖原数据'); }
  }
  write(name, value) {
    if (!['accounts', 'runtime'].includes(name)) throw fail('无效的插件状态文件');
    const serialized = JSON.stringify(value, null, 2);
    const task = this.chain.then(async () => {
      const dest = path.join(this.dir, name + '.json'), temp = dest + '.' + randomUUID() + '.tmp';
      try { await writeFile(temp, serialized, { mode: 0o600, flag: 'wx' }); await rename(temp, dest); }
      finally { await rm(temp, { force: true }).catch(() => {}); }
    });
    this.chain = task.catch(() => {}); return task;
  }
  async loadAccounts() {
    const accounts = await this.read('accounts', []);
    if (!Array.isArray(accounts) || accounts.length > 16) throw fail('账号索引格式无效或账号超过 16 个');
    const ids = new Set(), bots = new Set();
    for (const a of accounts) {
      assertId(a.id);
      if (typeof a.token !== 'string' || !a.token || typeof a.userId !== 'string' || !a.userId || typeof a.botId !== 'string' || !a.botId || (a.allowedPeers != null && (!Array.isArray(a.allowedPeers) || a.allowedPeers.length > 32 || !a.allowedPeers.every(p => typeof p === 'string' && p.length <= 256)))) throw fail('账号凭证不完整，请重新绑定');
      if (ids.has(a.id) || bots.has(a.botId)) throw fail('账号索引包含重复记录');
      ids.add(a.id); bots.add(a.botId);
    }
    return accounts;
  }
  async close() { await this.chain; if (this.release) { const release = this.release; this.release = null; await release(); } }
}
