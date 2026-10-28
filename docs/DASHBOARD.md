# 微信助理管理页面

候选版本：0.1.0-rc.1。参考 Harness 0.2.1-rc.3，源码提交 22ddee3792402c3e70ec5f86a63c3e3e895a2f60。尚未运行实际加载及 UI 测试。

## 安装体验

通过 DSH 原生插件安装 Git 组合包并启用后，客户端扩展注册“微信助理”侧栏按钮和主页面。首次打开引导扫码，自动创建本插件专用状态及工作目录。无需另开终端登录、复制 token 或起独立 Web 管理服务。

页面包括概览、已有会话、账号与绑定、设置。中文/英文跟随 DSH；窄屏会话列表与详情分屏。危险操作需要页面内确认。这里只列出本插件登记的微信会话，不迁移其他程序的账号或历史。

## 原生扩展结构

- `package.json` 声明 `./client`、`dsh.client` 和依赖模块；`client.js` 直接通过 Harness 模块表使用其 React，无额外前端构建步骤、CDN 或 React 副本。
- `sidebar.panellist` 提供入口，`main` 提供页面。完整会话使用 `uiWorkspace.openSession()` 和原生默认会话面板。
- 页面仅在挂载时轮询状态，退出取消查询。绑定流程属于 Host，关闭页面不取消手机扫码；停用插件或点击取消会中止绑定。
- Host 通过 `connection.fetch.register` 注册 POST `/api/weixin-suite`；客户端用 `connection.rpc.call('/api', 'weixin-suite', ...)`。
- 复用现有 carrier 的认证与 Origin 检查，参考版本的 shared Fetch 路由仅放行 owner Peer，其他身份返回 403。没有新端口、独立 cookie 或管理密钥。

## 管理接口

请求/响应沿用 DSH Connection RPC envelope，payload 为 `{ action, input }`。请求体限 64 KiB，响应禁止缓存。写操作串行处理，页面错误只返回清理后的说明。

| action | 用途 |
|---|---|
| snapshot / session | 脱敏状态、会话列表、近期文本摘要、待处理交互 |
| bind / bind-verify / bind-cancel | 发起扫码、提交配对数字、取消绑定 |
| account | 暂停、恢复、移除本地绑定 |
| settings | 校验并保存页面设置 |
| session-stop / session-new | 取消任务/队列、重置上下文 |
| answer | 复用微信的审批/问题回答校验 |

状态响应不返回账号 token、context token、二维码原始协议标识或微信用户 ID。二维码以本地生成的数据图片传入页面；近期消息本身属于私密内容，只对 DSH 所有者开放。历史文本按每个聊天最多 120 条、每条 4000 字符保存，附件显示类型说明，完整工具记录查看 DSH 会话。

页面设置存入独立 `settings.json`。同名页面设置覆盖基础插件配置，`stateDir`、`workspace`、`accountIds` 等部署字段仍由原生插件配置管理。模型和 preset 对新会话生效；已有会话继续使用自己的模型/preset。保存目录时核验实际路径，发送时再次校验文件权限与真实路径。工作目录始终属于允许发送的范围。

暂停先持久化意图，再取消账号轮询、发送、任务和等待交互；移除先停止，再删除凭证登记，最后清理本地路由。不撤销微信服务端的机器人关系，也不删除 DSH 已保存的完整会话。停止任务不能撤销已被微信接受的消息。

## 验收重点

实际 Git 安装及侧栏自动加载、桌面/Web 两种 carrier、首次扫码和配对、页面关闭再打开、断线及过期、暂停与入队竞争、重启后状态、会话原生跳转、审批与补答、目录及附件限制、插件停用后的资源清理。详见 ACCEPTANCE.md。
