import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--author', '--repository', '--published-at', '--registry'].includes(key) || !process.argv[i + 1]) throw new Error('需要 --author --repository --published-at，可选 --registry');
  args[key.slice(2)] = process.argv[i + 1];
}
if (!args.author?.trim() || !args.repository || !args['published-at']) throw new Error('请填写真实作者、HTTPS 仓库地址和实际发布时间');
const repository = new URL(args.repository);
if (repository.protocol !== 'https:' || repository.username || repository.password || repository.hash) throw new Error('仓库需要无凭证 HTTPS URL');
if (args.registry) { const registry = new URL(args.registry); if (registry.protocol !== 'https:' || registry.username || registry.password || registry.hash) throw new Error('registry 需要无凭证 HTTPS URL'); }
const timestamp = Date.parse(args['published-at']);
if (!Number.isFinite(timestamp) || timestamp > Date.now()) throw new Error('发布时间无效或在未来');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const icon = await readFile(path.join(root, 'icon.svg'));
if (icon.length > 32768) throw new Error('市场图标超过 32 KiB');
const index = { format: 1, title: { en: 'WeChat assistant', zh: '微信助理' }, plugins: [{ name: pkg.name, title: { en: 'WeChat assistant', zh: '微信助理' }, description: { en: pkg.description, zh: '在 DSH 侧栏扫码绑定、管理微信会话及设置，收发个人微信消息与附件。' }, author: args.author.trim(), icon: 'data:image/svg+xml;base64,' + icon.toString('base64'), homepage: repository.href, repository: { url: repository.href }, versions: [{ version: pkg.version, publishTimestamp: Math.floor(timestamp / 1000), source: { type: 'npm', ...(args.registry ? { registry: args.registry } : {}) }, engines: { dsh: pkg.engines.dsh } }] }] };
await mkdir(path.join(root, 'market'), { recursive: true });
await writeFile(path.join(root, 'market', 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log('已生成 market/index.json；没有执行上传或发布。');
