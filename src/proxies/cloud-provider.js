import { BaseProxy } from './base.js';

/**
 * 云服务商代理类
 * 使用其他云服务商的Serverless函数作为跳板进行连接，避免泄露真实IP，但将泄露其他云服务商的一些信息
 * 例如Vercel将会泄露Vercel的Host等信息
 * 注意：此代理可能不支持WebSocket连接，各个平台的规则不同
 */
export class CloudProviderProxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置
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
      // 由于无法确认使用的其他云服务商的WebSocket支持情况，直接返回错误
      // 如果确定云服务商支持WebSocket，可以实现相应的连接逻辑
      return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
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
    const cloudProviderUrl = this.config.CLOUD_PROVIDER_URL;
    if (!cloudProviderUrl) {
      return this.handleError(new Error("Cloud provider URL is not configured"), "Cloud provider proxy connection", 500);
    }

    const proxyUrlObj = new URL(cloudProviderUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    // 创建一个新的请求，直接使用原始头部，不再过滤
    // 为避免去除头部发送到云服务商时可能导致的问题，此处不再过滤头部
    // 应当在云服务商函数中处理头部，去除掉Cloudflare的头部信息
    // 可以参考 base.js中的 filterHeaders 方法
    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', // 防止代理本身发生重定向
    });

    try {
      this.log(`Using cloud provider proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Cloud provider proxy connection");
    }
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
     // 由于无法确认使用的其他云服务商的WebSocket支持情况，直接返回错误
     // 如果确定云服务商支持WebSocket，可以实现相应的连接逻辑
    return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
  }
}