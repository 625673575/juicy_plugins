/**
 * lyric-workshop（歌词工坊）Vite 配置
 *
 * 关键点：音乐平台的歌词接口都有 CORS / 加密（网易 eapi、QQ QRC 3DES、酷狗 KRC XOR），
 * 浏览器无法直连。API 业务在 server/handlers.mjs，两种挂法共用：
 *   - 开发：dev / preview 中间件（server/middleware.mjs），前端请求同源 /api/*
 *   - 插件：独立后端（server/server.mjs），宿主捆绑 Node 启动，端口经
 *           window.__JUICY_API_PORT__ 注入（见 src/lib/api.js）
 *
 * 构建产物在工程内 dist/，由仓库根 scripts/pack.mjs 连同 server/ 一起打进 zip。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { lyricApiPlugin } from './server/middleware.mjs';

export default defineConfig({
  plugins: [react(), lyricApiPlugin()],
  base: './',
  server: {
    host: true,
    port: 5175,
  },
  preview: {
    host: true,
    port: 4175,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
