import path from 'node:path';

export async function weixinGroup(ctx, cwd) {
  const registry = ctx.get('workspaceRegistry');
  if (!registry) return null;
  const group = await registry.create(cwd, '微信助理');
  // Upgrade an automatically named group without overwriting a user's name.
  if ((!group.title || group.title === path.basename(group.path)) && (group.sessionIds || []).every(id => String(id).startsWith('weixin-'))) await group.setTitle('微信助理');
  return group;
}

export async function organizeSession(ctx, config, route, agent, account) {
  const group = await weixinGroup(ctx, agent.session.header?.cwd || config.workspace);
  if (group) await group.attachSession(agent.session.id);
  const titles = ctx.get('sessionTitle');
  if (titles && !titles.get(agent.session)) titles.rename(agent.session, `微信 · ${account?.label || '助理'} · ${route.title || '新会话'}`);
}
