# 发布前准备

当前版本 `0.1.0-rc.1` 是未执行测试的候选源码。完成 ACCEPTANCE.md 后再决定发正式版。已配置真实 GitHub 仓库 Xzp-0302/dsh-weixin-suite；作者和 npm 包名归属仍由发布者确认。

1. 已使用独立 Git 仓库。不要上传父目录、references、任何桥接源码、登录状态、个人 workspace 文件或 node_modules。
2. 确认 `dsh-weixin-suite` 包名是否可用；若更换名字，同步修改 package.json 的 name、cordis.patch.yml 的 name 和 README 安装命令。配置行 id 可保持稳定。
3. repository、homepage、bugs 已填写真实地址；按需填写 author，确认版本和 engines.dsh。
4. 验收源码及实际 npm 文件清单，保留 LICENSE 和 THIRD_PARTY_NOTICES.md。不要添加自动执行登录或网络发送的安装脚本。
5. 用户自行运行 npm 打包/发布；本次未执行这些命令。

```powershell
npm pack --dry-run --ignore-scripts
npm pack --ignore-scripts
# 用户确认包内容和账号后自行发布：
npm publish --access public --tag next --ignore-scripts
```

## 市场索引

Harness 官方文档中的市场是一个 JSON 索引源，并非本插件可以直接写入的唯一官方市场。包的 `dsh.bundle.patch` 使它成为可安装组合包；目录网站还可能有自己的提交表单。

`scripts/market.js` 为已经发布的 npm 版本生成索引。命令要求真实作者、仓库、发布日期，避免把开发日期伪装成发布时间：

```powershell
node scripts/market.js --author <真实作者名> --repository https://github.com/<用户>/<仓库> --published-at <实际发布时间ISO8601>
```

输出为 `market/index.json`，图标内联。脚本不联网，不发布、不上传、不修改 Harness profile。把生成后的市场目录托管到自己的 HTTPS 静态站点，再在 Harness“发现”中添加索引源；或者把仓库提交到你选择的社区目录。

若使用私有 npm registry，可附加 `--registry https://registry.example.com`；安装者需自行配置 registry 登录，索引中不能含凭证。

## 许可和兼容性

实现参考了 MIT 许可的 Tencent/openclaw-weixin 协议代码，已保留版权和许可说明。发布前保留第三方声明。依赖自身的许可随对应依赖分发。

公开发布不能标注“腾讯官方”“DeepSeek 官方”或“全部已实测”。建议初版说明：个人微信 iLink 适配、固定参考版本、人工验收环境、可选组件及已知服务端限制。

官方市场格式： https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market

## GitHub 安装与版本发布

本地交付提交和标签不等于已上传 GitHub。发布者审查并完成验收后，可把分支和 `v0.1.0-rc.1` 标签推送到远端。不要移动已经发布的版本标签；后续修复递增 rc 版本。

安装 URL：`git+https://github.com/Xzp-0302/dsh-weixin-suite.git#v0.1.0-rc.1`。组合包包含可直接加载的客户端文件，无需用户手动构建前端。安装后启用插件，在左侧“微信助理”完成绑定；不再要求预先 CLI 登录或编辑 YAML。

## 中国大陆 npm 镜像

`registry.npmmirror.com` 是 npm 公共包镜像，不作为 Git 仓库托管地，也不能直接 `npm publish` 到该只读镜像。先发布至 npmjs.org，再等待镜像同步；必要时通过 npmmirror 提供的同步入口请求同步。GitHub 的 Git 安装不依赖本包已存在于 npm 镜像，但安装依赖时仍需可用 registry 和网络。未完成 npm 发布前，不应把 npm 安装方式标成已可用。

本次按发布者要求清理旧实验版本的本地标签并重新从 v0.1.0-rc.1 开始。远端标签由发布者清理，不自动强制推送。今后 Git 用户可在助理设置中确认更新；原生 DSH npm 更新入口仍受其 registry 来源限制，插件的 Git 替换与回退说明见 UPGRADING.md。
