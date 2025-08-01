import { BaseProxy } from './base.js';

/**
 * Fetch代理类
 * 使用Fetch API进行连接
 */
export class FetchProxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    super(config);
    // 上游DNS服务器配置
    this.UPSTREAM_DNS_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
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
      // Fetch不支持WebSocket，返回错误
      return new Response("Fetch proxy does not support WebSocket", { status: 400 });
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
    const targetUrl = new URL(dstUrl);
    
    // 清理头部信息
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // 设置必需的头部
    cleanedHeaders.set("Host", targetUrl.hostname);
    
    try {
      // 使用fetch进行连接
      const fetchRequest = new Request(dstUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to connect to", dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      // 使用统一的错误处理方法
      return this.handleError(error, "Fetch connection");
    }
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    // Fetch不支持WebSocket，返回错误
    return new Response("Fetch proxy does not support WebSocket", { status: 400 });
  }

  /**
   * 处理DNS查询请求
   * @param {Request} req - 请求对象
   * @returns {Promise<Response>} 响应对象
   */
  async handleDnsQuery(req) {
    // Fetch代理可以直接处理DNS查询请求
    try {
      // 构建上游DNS服务器URL
      const upstreamDnsUrl = `https://${this.UPSTREAM_DNS_SERVER.hostname}${this.UPSTREAM_DNS_SERVER.path}`;
      
      // 清理头部信息
      const cleanedHeaders = this.filterHeaders(req.headers);
      
      // 设置必需的头部
      cleanedHeaders.set("Host", this.UPSTREAM_DNS_SERVER.hostname);
      cleanedHeaders.set("Content-Type", "application/dns-message");
      cleanedHeaders.set("Accept", "application/dns-message");
      
      // 使用fetch转发DNS查询请求
      const fetchRequest = new Request(upstreamDnsUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to handle DNS query");
      return await fetch(fetchRequest);
    } catch (error) {
      // 使用统一的错误处理方法
      return this.handleError(error, "Fetch DNS query handling", 502);
    }
  }
}