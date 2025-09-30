import { ShadowProxy } from './src/main.js';

/**
 * ShadowProxy Başlatıcı
 * Cloudflare Workers için fetch olay işleyicisini dışa aktarır
 */
export default {
  async fetch(request, env, ctx) {
    return await ShadowProxy.handleRequest(request, env, ctx);
  }
};