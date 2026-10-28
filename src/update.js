import { fail, readLimited } from './security.js';

/** Native manager replacement, matching its registry update's rollback sequence. */
export async function replaceGitBundle(manager, sha) {
  const name = 'dsh-weixin-suite';
  if (!/^[a-f0-9]{40}$/.test(sha)) throw fail('更新提交编号无效');
  // Fetch and validate the candidate before touching the working installation.
  const response = await fetch(`https://raw.githubusercontent.com/Xzp-0302/dsh-weixin-suite/${sha}/package.json`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw fail('无法读取新版清单，当前版本保持原样');
  const candidate = JSON.parse((await readLimited(response, 65536)).toString('utf8'));
  if (candidate.name !== name || !candidate.dsh?.bundle || typeof candidate.version !== 'string') throw fail('所选标签不是有效的微信助理组合包');
  const previous = (await manager.listBundles()).find(b => b.name === name && b.installed);
  if (!previous?.source || previous.availability !== 'profile' || previous.readOnlyReason) throw fail('无法确认可恢复的原安装来源，请在 DSH 插件管理中操作');
  const failed = result => ['failed', 'cancelled'].includes(result.application);
  let removed = false;
  try {
    const removal = await manager.removeBundle(name);
    if (failed(removal)) throw fail('DSH 未能停止旧版，更新已取消');
    removed = true;
    const result = await manager.installBundle(`${name}@git+https://github.com/Xzp-0302/dsh-weixin-suite.git#${sha}`, { enabled: previous.enabled, saveExact: true });
    if (failed(result)) throw fail('新版安装或激活失败');
    return result;
  } catch (error) {
    if (removed) {
      const current = (await manager.listBundles()).find(b => b.name === name && b.installed);
      if (current && failed(await manager.removeBundle(name))) throw fail('更新失败且新版无法移除，请在 DSH 插件管理中恢复原版本');
      const restore = await manager.installBundle(previous.source, { enabled: previous.enabled, saveExact: true });
      if (failed(restore)) throw fail('更新与恢复均未完成，请在 DSH 插件管理中重新安装原版本；微信绑定数据仍保留');
    }
    throw error;
  }
}
