# juicy_plugins

JuicyPlayer 的社区插件仓库。每个 `plugins/<id>/` 目录是一个独立插件，CI 自动构建并发布 zip；播放器拉取本仓库根的 `registry.json` 展示可下载插件列表，下载解压后自动出现在「工具」菜单里。

## 插件契约

一个插件 = `plugins/<id>/` 目录，至少包含：

```
plugins/<id>/
├─ plugin.json     # 清单（必需）
├─ src/ ...        # 前端源码（有 package.json 就会 CI 构建）
└─ server/         # 可选：node 后端
```

`plugin.json` schema：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明",
  "entry": "dist/index.html",
  "backend": { "type": "node", "entry": "server/server.mjs" }
}
```

- `id` 必须与目录名一致，ASCII 字母 / 数字 / 中划线
- `version` 走 semver，升级发版就改这里
- `backend` 可选，见下文「node 后端」

**宿主如何识别**：插件 zip 解压到 `%APPDATA%/JuicyPlayer/tools/<id>/` 后，只要 `dist/index.html` 存在就会被自动扫描并出现在 Tools 弹窗（`plugin.json` 提供显示名与描述）。

**zip 布局**：根目录即插件根（`plugin.json`、`dist/`、`server/` 在 zip 根），由 `scripts/pack.mjs` 生成，宿主解压一步到位。

**node 后端**：声明的 `backend.entry` 会由宿主用内置 Node 启动（`node server/server.mjs --port <空闲端口>`，只绑 127.0.0.1），宿主把端口注入页面 `window.__JUICY_API_PORT__`；需要本地 API 的插件（如跨域代理、加解密中转）用它。宿主**不接受任意命令行**，只接受 node + 插件目录内的相对入口。参考实现：`plugins/lyric-workshop/server/server.mjs`。

## 第三方贡献

1. Fork 本仓库，加一个 `plugins/<你的插件>/` 目录（照抄 `lyric-workshop` 的形态）
2. 本地验证：`node scripts/build-all.mjs <你的插件id>`（安装依赖 → 构建 → 自测 → 打包 zip）
3. 提 PR —— CI 会自动构建校验；merge 后自动打包发布到 Release 并更新 `registry.json`

要求：

- `plugin.json` 合法且 `id` 与目录名一致；`version` 走 semver
- 产物自包含（构建后无需 npm install 就能运行）
- 不含混淆代码、远端脚本注入、采集/上传用户数据的行为

## 本地命令（仓库根）

```bash
node scripts/build-all.mjs            # 全部插件：install + build + 自测 + 打包
node scripts/build-all.mjs <id>       # 只构建一个
node scripts/pack.mjs <id>            # 只打包（要求已构建出 dist/）
node scripts/build-registry.mjs       # 由打包产物重建 registry.json
```

开发单个插件：进 `plugins/<id>/` 直接 `npm run dev`（Vite dev server，与插件形态共用同一套后端业务代码）。

## 与宿主数据交互

插件页面与 JuicyPlayer 宿主之间有三条通道：native bridge + resource provider（读写本地数据）、node backend（本地代理/加解密）、宿主常驻 HTTP API（曲库/播放/队列/歌词/DSP，`http://127.0.0.1:8080/api/v1`，CORS 全开）。完整参考：[docs/player-api.md](docs/player-api.md)。
