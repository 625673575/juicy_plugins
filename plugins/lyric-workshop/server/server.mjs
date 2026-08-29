/**
 * 独立后端入口 —— 插件形态专用。
 *
 * 宿主（JuicyPlayer PluginManager）以
 *   node server/server.mjs --port <空闲端口>
 * 启动本进程；页面通过注入的 window.__JUICY_API_PORT__ 访问
 * http://127.0.0.1:<port>/api/*（跨源，故这里统一开 CORS）。
 *
 * 与 vite dev/preview 中间件共用 server/handlers.mjs，业务不分叉。
 * 零第三方依赖，宿主捆绑的 Node（assets/nodejs）直接可跑。
 *
 * 启动完成后向 stdout 打一行 READY <port>，宿主据此确认就绪。
 */

import http from "node:http";
import { handleApiRequest } from "./handlers.mjs";

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
let port = portFlag >= 0 ? parseInt(args[portFlag + 1], 10) : NaN;
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  port = Number(process.env.JUICY_PLUGIN_PORT) || 0; // 0 = 随机可用端口
}

const server = http.createServer(async (req, res) => {
  const handled = await handleApiRequest(req, res, { cors: true });
  if (!handled) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: `no route ${req.url}` }));
  }
});

// 后端只服务本机的插件页面：绑定回环地址，不接受外部连接
server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  console.log(`READY ${actual}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
