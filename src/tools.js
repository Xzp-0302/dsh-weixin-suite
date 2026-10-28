import { defineTool } from '@deepseek-ai/dsh-tools';
import { fail, errorText } from './security.js';

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
// Yield the exact effect disposers so the caller owns the complete tool group.
// Calling register() inside another effect does not transfer its ownership.
export function* registerTools(ctx, channel) {
  yield ctx.tools.register(defineTool({
    name: 'weixin_send',
    description: 'Send a user-requested text or local attachment to the linked personal WeChat chat. Supports image, file, video and SILK voice. The recipient is fixed by the current chat; never use for unsolicited uploads. accepted means the gateway accepted it, not that the person read it. On unknown outcome do not retry automatically.',
    parameters: {
      account: { type: 'string', description: 'Configured account alias, required only outside a WeChat-origin session.' },
      text: { type: 'string', description: 'Text to send when path is absent.' },
      path: { type: 'string', description: 'Absolute local file path under an allowed root.' },
      kind: { type: 'string', enum: ['auto', 'image', 'file', 'video', 'voice'], description: 'Default auto. Audio defaults to a file unless voice is explicitly chosen.' },
      caption: { type: 'string', description: 'Optional separate caption.' },
      quoteId: { type: 'string', description: 'Server message ID from this chat to quote.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true }, operationId: { type: 'string', required: true }, messageId: { type: 'string', required: true }, name: { type: 'string', required: true } } },
      render: (_args, v) => [{ type: 'text', text: `微信网关状态：${v.status}；文件：${v.name || '文字'}；操作编号：${v.operationId}` }],
    },
    async execute(args, exec) {
      try {
        if (!exec.agent) throw fail('发送工具必须在 Harness 会话中调用');
        const route = channel.routeFor(exec.agent, args.account);
        if (args.path && args.text) throw fail('发送附件时请使用 caption，不能同时设置 path 和 text');
        if (args.text && args.text.length > 20000) throw fail('发送文字过长');
        if (args.kind && !['auto', 'image', 'file', 'video', 'voice'].includes(args.kind)) throw fail('无效的附件类型');
        if (args.quoteId && !route.quotes.some(q => q.id === args.quoteId)) throw fail('引用消息必须来自当前聊天的本地缓存');
        if (!channel.host.owns(exec.agent)) {
          const approval = exec.agent.ctx.get('approval');
          if (!approval) throw fail('桌面会话发送微信需要 Harness 审批服务');
          const result = await approval.request({ agent: exec.agent, toolName: 'weixin_send', callId: exec.callId, reason: `发送至微信账号 ${route.accountId}：${args.path || args.text}`, signal: exec.signal });
          if (result !== 'allowed-once') throw fail('微信发送未获批准');
        }
        const result = await channel.send(route, args, AbortSignal.any([exec.signal, channel.lifetime.signal]), `${exec.agent.id}:${exec.callId}`);
        return { status: result.status, operationId: result.id, messageId: result.messageId || '', name: result.name || '' };
      } catch (e) { throw fail(errorText(e)); }
    },
    presentCall: args => ({ card: 'generic', title: '发送到微信', content: [{ type: 'text', text: args.path || args.text || '' }] }),
  }));
  yield ctx.tools.register(defineTool({
    name: 'weixin_status', description: 'Read WeChat account aliases, connection state, local limits and cached quote IDs. Does not reveal tokens or user identifiers.',
    parameters: { account: { type: 'string' } }, output: textOutput,
    async execute(args, exec) {
      const own = channel.host.owns(exec.agent);
      const accounts = [...channel.accounts.values()].filter(a => (!own || a.id === own.accountId) && (!args.account || a.id === args.account));
      return JSON.stringify({ accounts: accounts.map(a => ({ account: a.id, status: a.status })), maxFileMiB: channel.config.maxFileMiB, allowedRoots: [...new Set([channel.config.workspace, ...channel.config.allowedRoots])], quotes: own ? own.quotes.slice(-15) : [] });
    },
  }));
  yield ctx.tools.register(defineTool({
    name: 'weixin_sessions', description: 'Read the WeChat assistant conversation list. WeChat-origin callers only see their own conversation. Account binding, approval decisions and permission settings are user-only in the dashboard.',
    parameters: {}, output: textOutput,
    async execute(_args, exec) {
      const own = channel.host.owns(exec.agent);
      const sessions = channel.dashboard?.snapshot().sessions || [];
      return JSON.stringify(sessions.filter(session => !own || session.key === own.key));
    },
  }));
  yield ctx.tools.register(defineTool({
    name: 'weixin_typing', description: 'Set or clear the typing indicator in the current WeChat-origin chat.',
    parameters: { active: { type: 'boolean', required: true } }, output: textOutput,
    async execute(args, exec) {
      const route = channel.host.owns(exec.agent); if (!route) throw fail('只能操作当前微信会话的输入状态');
      const api = channel.accounts.get(route.accountId).api;
      const config = await api.config(route.userId, route.contextToken, exec.signal);
      if (!config.typing_ticket) throw fail('微信未提供输入状态票据');
      await api.typing(route.userId, config.typing_ticket, args.active ? 1 : 2, exec.signal); return '已更新输入状态';
    },
  }));
}
