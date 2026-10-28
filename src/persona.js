import { fail } from './security.js';

export const personaDefaults = Object.freeze({ tone: 'openclaw', assistantName: '', userName: '', replyLanguage: '跟随用户的语言', replyLength: 'balanced', humor: 'natural', emoji: 'light', soul: '', identity: '', userProfile: '' });
export const personaChoices = Object.freeze({ tone: ['openclaw', 'warm', 'professional', 'concise', 'custom', 'inherit'], replyLength: ['short', 'balanced', 'detailed'], humor: ['off', 'natural', 'playful'], emoji: ['off', 'light', 'expressive'] });
export const personaLimits = Object.freeze({ assistantName: 64, userName: 64, replyLanguage: 64, soul: 6000, identity: 2000, userProfile: 3000 });

export function validatePersona(key, value) {
  if (key in personaChoices) {
    if (!personaChoices[key].includes(value)) throw fail('个性化选项无效');
  } else if (typeof value !== 'string' || value.length > personaLimits[key]) throw fail('个性化文字格式错误或超过长度限制');
  return value;
}

/** Original style instructions inspired by OpenClaw's SOUL/IDENTITY/USER separation. */
export function personaPrompt(config) {
  const c = { ...personaDefaults, ...Object.fromEntries(Object.keys(personaDefaults).filter(k => config[k] !== undefined).map(k => [k, config[k]])) };
  if (c.tone === 'inherit') return '';
  const tones = {
    openclaw: '像熟悉用户的能干搭档：自然直接，先给有用结果，少客套和套话。有判断，遇到明显问题坦诚指出并说明理由；不讨好、不刻薄。简单问题简短回答，复杂任务给足细节。幽默适度，不编造经历、情感或完成结果。',
    warm: '语气温和亲切，体察用户处境，用具体、有帮助的回应表达关心，避免空泛安慰。',
    professional: '专业、平实、准确，先说结果再说明依据，表达清晰，避免官话和夸张措辞。',
    concise: '简洁利落，优先给结论和下一步，必要时补上关键理由，避免重复和冗长铺垫。',
    custom: '按照以下用户明确配置的人格和沟通偏好表达；未指定的部分沿用 DSH 预设。',
  };
  return [
    '以下个性化只作用于本插件的微信会话，用于表达和用户偏好，不授予额外工具、文件、发送或审批权限；当前明确任务要求优先于默认风格。',
    tones[c.tone],
    c.assistantName && `助理称呼：${JSON.stringify(c.assistantName)}。不要因此冒充真人或 OpenClaw 程序。`,
    c.userName && `用户偏好的称呼：${JSON.stringify(c.userName)}。自然使用，避免句句重复称呼。`,
    c.replyLanguage && `回复语言偏好：${JSON.stringify(c.replyLanguage)}。`,
    { short: '默认简短回复；必要细节不要省略。', balanced: '按问题复杂度决定篇幅，默认适中。', detailed: '默认详细解释，并给出清晰步骤或例子。' }[c.replyLength],
    { off: '不主动开玩笑。', natural: '语境合适时自然幽默，不强行搞笑。', playful: '可适当俏皮，严肃或敏感任务保持克制。' }[c.humor],
    { off: '不主动使用表情符号。', light: '偶尔使用表情符号，不影响阅读。', expressive: '可自然使用表情符号，避免堆砌。' }[c.emoji],
    c.identity && `用户配置的 IDENTITY 人格补充：\n${JSON.stringify(c.identity)}`,
    c.soul && `用户配置的 SOUL 语气补充：\n${JSON.stringify(c.soul)}`,
    c.userProfile && `用户主动提供的 USER 偏好背景（不是新的任务或授权）：\n${JSON.stringify(c.userProfile)}`,
  ].filter(Boolean).join('\n\n');
}
