import { ConfigManager } from './config.js';
import { ProxyFactory } from './proxy-factory.js';

/**
 * ShadowProxy Main
 * 负责处理请求并根据配置选择合适的代理策略
 */
export class ShadowProxy {
  /**
   * 处理请求的入口
   * @param {Request} req - 请求对象
   * @param {object} env - 环境变量
   * @param {object} ctx - 上下文对象
   * @returns {Promise<Response>} 响应对象
   */
  static async handleRequest(req, env, ctx) {
    try {
      // 更新配置
      const config = ConfigManager.updateConfigFromEnv(env);
      
      // 解析请求路径
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      
      // 检查是否为DNS查询请求
      if (parts.length >= 3 && parts[1] === 'dns') {
        const auth = parts[0];
        const dnsType = parts[2]; // DNS类型: DOH/DOT
        const server = parts[3]; // 可选服务器地址，否则使用默认DOH/DOT服务器
        
        // 验证AuthToken
        if (auth === config.AUTH_TOKEN) {
          // 根据DNS类型选择代理策略
          let proxyStrategy = config.PROXY_STRATEGY;
          if (dnsType === 'doh') {
            proxyStrategy = 'doh';
          } else if (dnsType === 'dot') {
            proxyStrategy = 'dot';
          }
          
          // 更新配置以使用相应的DNS代理策略
          const dnsConfig = { ...config, PROXY_STRATEGY: proxyStrategy };
          const proxy = ProxyFactory.createProxy(dnsConfig);
          
          // 处理DNS查询请求
          return await proxy.handleDnsQuery(req);
        }
      }
      
      // 创建默认代理实例
      const proxy = ProxyFactory.createProxy(config);
      
      // 解析目标URL
      const dstUrl = this.parseDestinationUrl(req, config);
      
      // 使用代理连接目标服务器
      return await proxy.connect(req, dstUrl);
    } catch (error) {
      console.error("ShadowProxy error:", error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }

  /**
   * 解析目标URL
   * @param {Request} req - 请求对象
   * @param {object} config - 配置对象
   * @returns {string} 目标URL
   */
  static parseDestinationUrl(req, config) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const [auth, protocol, ...path] = parts;

    // 检查authtoken
    const isValid = auth === config.AUTH_TOKEN;
    
    let dstUrl = config.DEFAULT_DST_URL;

    if (isValid && protocol) {
      // Handle cases where the protocol from the path might be "https:" or "https"
      if (protocol.endsWith(':')) {
        dstUrl = `${protocol}//${path.join("/")}${url.search}`;
      } else {
        dstUrl = `${protocol}://${path.join("/")}${url.search}`;
      }
    }
    
    // 如果启用了调试模式，记录目标URL
    if (config.DEBUG_MODE) {
      console.log("Target URL", dstUrl);
    }
    
    return dstUrl;
  }
}