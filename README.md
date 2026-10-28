# DeepSeek Harness 微信助理

`dsh-weixin-suite` 通过腾讯公开 iLink 协议，把个人微信私聊接入 DeepSeek Harness。提供消息和附件收发、微信内任务控制、审批和提问，以及原生 Agent 发送工具。

这是独立的社区插件，不是腾讯或 DeepSeek 官方产品。当前为 **0.2.0-rc.1，静态审查交付版，尚未运行测试或实机验收**。不能据此宣称可直接投入生产。

## 能力

| 能力 | 当前实现 |
|---|---|
| 登录 | 二维码、配对数字、重定向、过期、已有绑定 |
| 账号 | 最多 16 个账号；账号与私聊会话隔离；独立凭证和进程锁 |
| 接收 | 文字、图片、文件、视频、语音；语音转写；引用文字及本地引用缓存 |
| 发送 | 文字、图片、文件、视频；可选 SILK 语音；引用消息 |
| 附件 | 上传地址、AES 加密、CDN 上传/下载、解密与完整性校验 |
| Agent | 原生 preset、独立会话、跨重启恢复、新会话、停止与人工重试 |
| 人机交互 | 单次审批、多题/多选回答、框架定时提问超时后的补答 |
| 状态 | 输入状态、长轮询重连、启动/停止通知；可选工具状态消息 |
| 模型工具 | `weixin_send`、`weixin_status`、`weixin_sessions`、`weixin_typing` |

这里的范围是腾讯公开个人微信协议。群聊、朋友圈、通讯录、公众号、企业微信不在此协议范围。语音上行、工具状态消息等虽有协议类型，服务端是否对当前账号开放，仍需验收；详细见 [能力矩阵](docs/CAPABILITIES.md)。

## 环境

- Node.js **24.9.0 或以上**；目标 Harness **0.2.1-rc.3**。发布的 `engines.dsh` 限定为 `>=0.2.1-rc.3 <0.3.0`，其他版本需重新核对 API。
- 已能正常工作的 Harness profile、模型路由和 Agent preset。插件依赖 host 的 `agents` 和 `agentPresets` 服务；没有这些服务时不能激活。
- 可出站访问 `https://ilinkai.weixin.qq.com` 及微信 CDN 的 HTTPS 网络，不需要公网入站端口。
- `silk-wasm` 为可选依赖，用于 SILK 解码及语音编码。未安装时仍可收发普通文件，包括把音频作为附件发送。
- FFmpeg 由用户自行安装并配置绝对路径，用于把 MP3、非标准 WAV 等转成微信语音。不会自动下载安装。

图片使用 Harness 的附件服务时可进入其原生图像链路；模型是否能理解图片取决于所选模型和 profile。视频以文件交给 Harness，不承诺模型原生视频理解。插件不提供额外的云端语音识别或 TTS 服务。

## 安装与首次使用

**本版尚未执行功能测试。以下步骤供用户验收时操作。**

1. 在 DSH 原生插件管理中，通过 Git 地址安装并启用本插件。发布者推送标签后，固定版本地址为：`git+https://github.com/Xzp-0302/dsh-weixin-suite.git#v0.2.0-rc.1`。
2. 打开左侧 **微信助理**，进入 **账号与绑定**，点击 **绑定微信**，用手机扫码；需要配对数字时在页面填写。
3. 从微信发送一条消息，回到 **已有会话** 查看消息、停止任务，或在 DSH 中打开完整会话。
4. 要发送已有目录里的文件，在 **设置** 添加允许发送的文件夹，例如 `D:\study`，保存即可。

日常使用无需手写 YAML、复制令牌、先运行 CLI 登录或单独启动管理服务。默认自动创建独立状态目录和工作目录。侧栏依赖目标 DSH 的客户端扩展支持；固定参考版本为 0.2.1-rc.3，尚待实际加载验收。

如果使用命令安装，可在你实际使用的 profile 中执行（示例以 `desktop` 为名）：

```powershell
dsh plugin --profile desktop add "git+https://github.com/Xzp-0302/dsh-weixin-suite.git#v0.2.0-rc.1"
```

本地源码验收仍可使用 DSH 的 `link:` 安装方式。开发者 CLI `bin/cli.js` 保留，供停用插件后的离线维护使用，见其帮助；不作为首次使用的必需步骤。

扫码时，如果微信提示替换另一个应用正在使用的绑定，请取消。请新建本插件专用机器人绑定，不导入其他应用的凭证。

## 页面功能

| 页面 | 功能 |
|---|---|
| 概览 | 连接状态、账号数、会话数、正在执行的任务数、首次绑定引导 |
| 已有会话 | 近期消息、待处理审批与问题、停止任务、重置上下文、打开原生完整会话 |
| 账号与绑定 | 扫码及配对数字、多账号、暂停/恢复连接、确认后移除本地绑定 |
| 设置 | 允许发送的目录、附件大小、进度开关及折叠的模型/超时/语音设置 |

设置保存到插件自己的目录；正在执行任务时需先停止任务再保存。模型与预设变更对新会话生效。近期消息最多保留每个聊天 120 条文本摘要，附件显示类型说明；完整记录在 DSH 原生会话中查看。这里管理本插件收到的会话，不读取其他桥接的历史。

实现与接口说明见 [管理页面](docs/DASHBOARD.md)，待用户执行的验收步骤见 [验收清单](docs/ACCEPTANCE.md)。

## 高级配置（可选）

通常使用页面即可。仅自定义状态位置、工作目录或账号筛选时，才需要 DSH 插件设置。页面保存的同名设置优先于这里的基础值；恢复基础值需停用插件后删除本插件状态目录中的 `settings.json`。包内 `cordis.patch.yml` 提供默认注册，不写全局 profile。

```yaml
- id: dsh-weixin-suite
  config:
    enabled: true
    stateDir: D:/dsh-weixin-suite-state
    workspace: D:/dsh-weixin-workspace
    accountIds: [personal]
    allowedRoots:
      - D:/study
      - D:/dsh-weixin-workspace
    preset: ''
    provider: ''
    model: ''
    maxFileMiB: 20
    maxVoiceSeconds: 60
    interactionTimeoutSeconds: 300
    taskTimeoutMinutes: 30
    progress: true
    toolEvents: false
    ffmpegPath: ''
```

Loader 通过 `id` 定位已安装的插件行。`config` 是完整配置替换；也可在原生插件设置里填写这些字段。此示例适配本项目固定参考的 Harness 版本。

| 字段 | 默认与含义 |
|---|---|
| `stateDir` | 环境变量 `DSH_WEIXIN_SUITE_STATE_DIR`，否则用户目录内按 profile 分隔的 `.dsh-weixin-suite` 子目录 |
| `workspace` | 用户目录 `dsh-weixin-workspaces/<状态目录名>`；不是现有桥接的 workspace |
| `accountIds` | 空数组表示加载本插件登记的全部账号 |
| `allowedRoots` | 空数组仅允许发送本插件 workspace 文件；其他目录需要显式列入 |
| `preset` | 空值使用 Harness 默认 preset；恢复会话优先沿用已记录的 preset |
| `provider` / `model` | 同时为空使用 Harness 默认路由；也可以同时指定 |
| `maxFileMiB` | 默认 20，可配 1–200。这是本地限制，不是微信服务端上限 |
| `maxVoiceSeconds` | 默认 60，可配 1–600；服务端限制可能更小 |
| `interactionTimeoutSeconds` | 默认 300；定时提问还受 Harness 自己的期限限制 |
| `taskTimeoutMinutes` | 默认 30，超时取消该聊天任务；不关闭 Harness 进程 |
| `progress` | 转发已提交的 Assistant 进度文字，不发送内部推理 |
| `toolEvents` | 默认关闭；开启后发送协议类型 11/12，待服务端验收 |
| `ffmpegPath` | FFmpeg 绝对路径；空值仍支持标准 24kHz 单声道 PCM WAV 和 SILK |
| `routeTag` | 可选 iLink 路由参数，仅在部署方明确要求时填写 |

## 使用

在微信机器人私聊里发送任务，例如：

> 找到 D:\study 下的容器学习 PDF，使用微信发送工具把文件发给我。

文件匹配、目录授权和文件发送是不同步骤。`D:\study` 需在 `allowedRoots` 中，Agent 才能通过 `weixin_send` 发送。普通音频默认作为文件；只有明确选择 `kind: voice` 才转成微信语音。

| 微信命令 | 行为 |
|---|---|
| `/帮助` | 查看命令 |
| `/状态` | 连接、任务状态、中断消息编号 |
| `/新会话` | 空闲时创建新的会话入口 |
| `/停止` | 取消当前任务，清空当前聊天的等待队列 |
| `/重试 消息编号` | 用户明确要求后重跑失败或中断任务，可能重复原任务已经发生的副作用 |
| `/清理中断` | 清除当前聊天的中断任务记录，不执行任务 |
| `/批准 编号` / `/拒绝 编号` | 对应操作的一次性决定 |
| `/回答 编号 答案` | 回答提问；多题用 `|`，多选序号用逗号分隔 |

插件命令使用固定名称，其他 `/...` 不会自动透传给 Harness 原生命令注册中心。一般任务直接发送普通文字。

从 Harness 桌面会话调用 `weixin_send` 时需指定账号别名，并由 Harness 原有审批服务确认；从微信发起的会话固定回复当前私聊，不能选择任意收件人。

## 管理命令

```powershell
node bin/cli.js list --state-dir D:\dsh-weixin-suite-state
node bin/cli.js login --state-dir D:\dsh-weixin-suite-state --account another
node bin/cli.js logout --state-dir D:\dsh-weixin-suite-state --account personal
node bin/cli.js allow-peer --state-dir D:\dsh-weixin-suite-state --account personal --peer <微信用户ID>
node bin/cli.js remove-peer --state-dir D:\dsh-weixin-suite-state --account personal --peer <微信用户ID>
node bin/cli.js unlock --state-dir D:\dsh-weixin-suite-state
node bin/cli.js prune --state-dir D:\dsh-weixin-suite-state --days 30
```

`logout` 只移除本插件本地绑定，服务端撤销需在微信操作。`unlock` 仅移除进程已死亡的锁，PID 仍存在时拒绝执行。`prune` 仅清理过期已完成的消息元数据，保留未确认发送、未完成任务和附件。附件在 workspace 中由用户管理；不要在运行任务期间删除。

## 数据和恢复

- 默认只允许扫码本人发指令；额外私聊用户必须在本机明确授权，每账号最多 32 人。群消息拒绝。
- 凭证、上下文和游标保存在独立状态目录；POSIX 目录 0700 / 文件 0600，Windows 使用当前用户及 SYSTEM 的 ACL。
- 状态目录须为空或由本插件创建，不接受已有桥接目录，不扫描其他应用状态。
- 发送文件执行真实路径、允许目录、普通文件、大小及读前读后校验；拒绝插件状态、常见凭证目录和环境密钥文件。
- 断线退避重连；登录失效停止该账号。重启时未完成任务标记“中断”，不自动重跑。
- 文件发送先记录操作，再上传并发送。结果未知时不自动重试。`accepted` 只证明网关受理，不证明手机收到、解密成功或用户已读。
- 不能撤销已被微信接收的消息；进程锁与状态文件不是通用的系统沙箱。向其他用户开放本机 Agent 前应使用 Harness 自己的权限策略。

## 交付与发布

- [需求与方案](docs/需求与方案.md)
- [协议能力矩阵](docs/CAPABILITIES.md)
- [审查记录](docs/REVIEW.md)
- [人工验收清单](docs/ACCEPTANCE.md)
- [发布步骤](docs/PUBLISHING.md)

本次不安装、不扫码、不发送、不运行单元/集成/实机测试。已做的静态检查和未解决的验收项应一并保留在发布说明中。
