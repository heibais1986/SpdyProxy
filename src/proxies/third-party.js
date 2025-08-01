import { BaseProxy } from './base.js';

/**
 * 第三方代理类
 * 使用第三方代理服务进行连接
 */
export class ThirdPartyProxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    super(config);
  }

  /**
   * 连接目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connect(req, dstUrl) {
    // 检查请求是否为WebSocket请求
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      // 第三方代理可能不支持WebSocket，返回错误
      return new Response("Third party proxy may not support WebSocket", { status: 400 });
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  /**
   * 连接HTTP目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttp(req, dstUrl) {
    const thirdPartyProxyUrl = this.config.THIRD_PARTY_PROXY_URL;
    if (!thirdPartyProxyUrl) {
      return this.handleError(new Error("Third party proxy URL is not configured"), "Third party proxy connection", 500);
    }

    const proxyUrlObj = new URL(thirdPartyProxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    // 创建一个新的请求，直接使用原始头部，不再过滤
    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', // 防止代理本身发生重定向
    });

    try {
      this.log(`Using third party proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Third party proxy connection");
    }
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    // 第三方代理可能不支持WebSocket，返回错误
    return new Response("Third party proxy may not support WebSocket", { status: 400 });
  }
}