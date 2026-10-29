import { fail, readLimited } from './security.js';

/** Native manager replacement, matching its registry update's rollback sequence. */
export async function replaceGitBundle(manager, sha, { onStage = () => {} } = {}) {
  const name = 'dsh-weixin-suite';
  if (!/^[a-f0-9]{40}$/.test(sha)) throw fail('更新提交编号无效');
  // Fetch and validate the candidate before touching the working installation.
  onStage('checking');
  let candidate;
  try {
    const response = await fetch(`https://api.github.com/repos/Xzp-0302/dsh-weixin-suite/contents/package.json?ref=${sha}`, { headers: { Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw fail(`无法读取 GitHub 更新清单（HTTP ${response.status}），当前版本保持原样`);
    candidate = JSON.parse((await readLimited(response, 65536)).toString('utf8'));
  } catch (error) {
    if (error.publicMessage) throw error;
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name) || error.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
    throw fail(`无法读取 GitHub 更新清单（${timedOut ? '连接超时' : error instanceof SyntaxError ? '清单格式无效' : '网络连接失败'}），当前版本保持原样。请检查 api.github.com 的连接后重试`);
  }
  if (candidate.name !== name || !candidate.dsh?.bundle || typeof candidate.version !== 'string') throw fail('所选标签不是有效的微信助理组合包');
  const previous = (await manager.listBundles()).find(b => b.name === name && b.installed);
  if (!previous?.source || previous.availability !== 'profile' || previous.readOnlyReason) throw fail('无法确认可恢复的原安装来源，请在 DSH 插件管理中操作');
  const failed = result => ['failed', 'cancelled'].includes(result.application);
  const diagnostic = result => [result.error?.code, result.failedAt].filter(x => typeof x === 'string' && /^[\w-]{1,80}$/.test(x)).join(' / ');
  let removed = false;
  try {
    onStage('removing');
    const removal = await manager.removeBundle(name);
    if (failed(removal)) throw fail('DSH 未能停止旧版，更新已取消' + (diagnostic(removal) ? `（${diagnostic(removal)}）` : ''));
    removed = true;
    onStage('installing');
    const result = await manager.installBundle(`${name}@git+https://github.com/Xzp-0302/dsh-weixin-suite.git#${sha}`, { enabled: previous.enabled, saveExact: true });
    if (failed(result)) throw fail('新版安装或激活失败' + (diagnostic(result) ? `（${diagnostic(result)}）` : ''));
    return result;
  } catch (error) {
    if (removed) {
      onStage('restoring');
      const current = (await manager.listBundles()).find(b => b.name === name && b.installed);
      if (current && failed(await manager.removeBundle(name))) throw fail('更新失败且新版无法移除，请在 DSH 插件管理中恢复原版本');
      const restore = await manager.installBundle(previous.source, { enabled: previous.enabled, saveExact: true });
      if (failed(restore)) throw fail('更新与恢复均未完成，请在 DSH 插件管理中重新安装原版本；微信绑定数据仍保留');
    }
    throw error;
  }
}
