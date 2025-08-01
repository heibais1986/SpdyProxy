import { ShadowProxy } from './src/main.js';

/**
 * ShadowProxy启动器
 * 为Cloudflare Workers导出fetch事件处理程序
 */
export default {
  async fetch(request, env, ctx) {
    return await ShadowProxy.handleRequest(request, env, ctx);
  }
};