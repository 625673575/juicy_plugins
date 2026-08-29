/**
 * vite dev / preview 中间件（开发形态）
 *
 * 前端请求同源 /api/*，业务处理全部在 server/handlers.mjs——与插件形态的
 * 独立后端（server/server.mjs）共用同一实现，避免开发 / 生产分叉。
 */

import { handleApiRequest } from "./handlers.mjs";

function createMiddleware() {
  return async (req, res, next) => {
    if (!(await handleApiRequest(req, res, { cors: false }))) return next();
  };
}

export function lyricApiPlugin() {
  const middleware = createMiddleware();
  return {
    name: "lyric-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
