# 能力矩阵与协议依据

固定参考：Tencent/openclaw-weixin `874637a0dbc24050f72d1385add4fc6170a2d726`，客户端版本 2.4.10。Harness 参考：deepseek-ai/deepseek-harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，0.2.1-rc.3。

“已实现”表示本项目存在对应代码，不表示测试通过。全部功能尚待人工验收。

| 腾讯公开能力 | 实现位置 | 边界 |
|---|---|---|
| get_bot_qrcode | api.js / CLI | 固定官方初始域；仅使用本插件账号列表 |
| get_qrcode_status | api.js | 等待、扫描、确认、重定向、配对数字、过期、限流、已有绑定 |
| getupdates | api.js / channel.js | 长轮询、游标、账号内去重、退避、登录失效 |
| sendmessage 文字 | api.js | UTF-8 分段，不自动重试结果未知的发送 |
| 图片 | media.js / harness.js | 双向；接收图片进入 Harness 附件能力，模型理解由 profile 决定 |
| 普通文件 | media.js / tools.js | 双向；文件名、长度、MD5、本地大小限制 |
| 视频 | media.js | 双向；传输原视频，不承诺模型原生视频理解 |
| 语音与微信转写 | media.js / voice.js | 接收原始音频和服务器转写；SILK 可解码成 WAV |
| 语音发送 | media.js / voice.js | 协议有 VOICE 类型，腾讯参考客户端没有完整上行实现；本项目按公开类型实现，需实机确认 |
| getuploadurl | media.js | 文件类别 1/2/3/4，明文与密文大小、MD5、随机 AES key |
| CDN 上传 | media.js | AES-128-ECB / PKCS#7、POST、x-encrypted-param，有限重试 |
| CDN 下载 | media.js | 优先 full_url，否则拼接；域校验、限量读取、解密 |
| 原图/视频缩略图字段 | media.js | 与腾讯当前客户端相同：no_need_thumb=true，仅传原文件，不主动上传缩略图 |
| ref_msg / svr_id | channel.js / tools.js | 引用文字和最近 100 条缓存；发消息可指定当前聊天已缓存的 ID |
| partial_text | 原始消息保留 | 接收协议字段不丢失；不把局部选区当作新的执行授权，不提供自定义选区发送工具 |
| getconfig / sendtyping | api.js / tools.js | 任务期间输入状态刷新、结束取消，可由当前聊天工具控制 |
| notifystart / notifystop | api.js / channel.js | 最佳努力，不因不支持此通知而阻止基本聊天 |
| TOOL_CALL_START/RESULT | index.js | 默认关闭；按公开字段发送，需确认微信客户端展示 |
| base_info / SKRouteTag | api.js | 固定参考协议版本，独立 bot_agent 标识，可选路由标签 |
| uint64 消息 ID | api.js | 在解析 JSON 时保留大整数，不改写文字里的数字 |
| 多账号 | channel.js / store.js | 每账号只启动本插件自己的轮询，同一状态目录单写进程 |

协议里出现 `group_id`、多种音频编码或可选字段，并不证明服务端实现了所有变体。群聊不启用；非 SILK 音频原样保存，微信转写不存在时不伪造转写。图片、视频缩略图上传与音频云识别不作额外产品承诺。

协议依据：

- https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/docs/protocol.md
- https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/api/types.ts
- https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/cdn/upload.ts
- https://github.com/Tencent/openclaw-weixin/blob/874637a0dbc24050f72d1385add4fc6170a2d726/src/messaging/send.ts

本项目实现的是客户端适配；最终服务端权限、限流、文件大小、语音参数、上下文有效期均由腾讯决定。
