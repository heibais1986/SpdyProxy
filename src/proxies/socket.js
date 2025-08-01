import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';
import { FetchProxy } from './fetch.js';
import { Socks5Proxy } from './socks5.js';
import { ThirdPartyProxy } from './third-party.js';
import { CloudProviderProxy } from './cloud-provider.js';

/**
 * Socket代理类
 * 使用Cloudflare Socket API进行连接
 */
export class SocketProxy extends BaseProxy {
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
      return await this.connectWebSocket(req, dstUrl);
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    // 如果目标URL不支持WebSocket协议，返回错误响应
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    
    // 建立到目标服务器的原始套接字连接
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: isSecure ? "on" : "off", allowHalfOpen: false }
    );
  
    // 生成WebSocket握手所需的密钥
    const key = this.generateWebSocketKey();

    // 清理头部信息
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // 构建握手所需的HTTP头部
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
    // 组装WebSocket握手的HTTP请求数据
    const handshakeReq =
      `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(cleanedHeaders.entries())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n';

    this.log("Sending WebSocket handshake request", handshakeReq);
    const writer = socket.writable.getWriter();
    await writer.write(this.encoder.encode(handshakeReq));
  
    const reader = socket.readable.getReader();
    const handshakeResp = await this.readUntilDoubleCRLF(reader);
    this.log("Received handshake response", handshakeResp);
    
    // 验证握手响应是否表明101 Switching Protocols状态
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    // 创建内部WebSocketPair
    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];
    client.accept();
    
    // 在客户端和远程套接字之间建立双向帧中继
    this.relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  }

  /**
   * 连接HTTP目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttp(req, dstUrl) {
    // 为可能的回退操作，立即克隆请求以保留其body流
    const reqForFallback = req.clone();
    const targetUrl = new URL(dstUrl);
    
    // 清理头部信息
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // 对于标准HTTP请求：设置必需的头部（如Host并禁用压缩）
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      const port = targetUrl.protocol === "https:" ? 443 : 80;
      const socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: targetUrl.protocol === "https:" ? "on" : "off", allowHalfOpen: false }
      );
      const writer = socket.writable.getWriter();
      
      // 构建请求行和头部
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      
      this.log("Sending request", requestLine);
      await writer.write(this.encoder.encode(requestLine));
    
      // 如果有请求体，将其转发到目标服务器
      if (req.body) {
        this.log("Forwarding request body");
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      
      // 解析并返回目标服务器的响应
      return await this.parseResponse(socket.readable.getReader());
    } catch (error) {
      // 检查是否是Cloudflare网络限制错误
      if (this.isCloudflareNetworkError(error)) {
        this.log("Cloudflare network restriction detected, switching to fallback proxy");
        this.log("Original error:", error.message);
        
        // 根据环境变量配置的备用策略选择合适的备用方案
        const fallbackStrategy = this.config.FALLBACK_PROXY_STRATEGY || "fetch";
        this.log("Using fallback strategy:", fallbackStrategy);
        
        // 创建备用代理实例
        const fallbackConfig = { ...this.config, PROXY_STRATEGY: fallbackStrategy };
        let fallbackProxy;
        
        // 根据备用策略创建相应的代理实例
        switch (fallbackStrategy.toLowerCase()) {
          case 'fetch':
            fallbackProxy = new FetchProxy(fallbackConfig);
            break;
          case 'socks5':
            fallbackProxy = new Socks5Proxy(fallbackConfig);
            break;
          case 'thirdparty':
            fallbackProxy = new ThirdPartyProxy(fallbackConfig);
            break;
          case 'cloudprovider':
            fallbackProxy = new CloudProviderProxy(fallbackConfig);
            break;
          default:
            fallbackProxy = new FetchProxy(fallbackConfig);
        }
        
        this.log("Attempting fallback connection with", fallbackStrategy);
        
        // 使用备用代理
        // 使用克隆出来的、body未被动过的请求来进行回退
        return await fallbackProxy.connectHttp(reqForFallback, dstUrl);
      }
      
      // 使用统一的错误处理方法
      return this.handleError(error, "Socket connection");
    }
  }

  /**
   * 检查是否为Cloudflare网络限制错误
   * @param {Error} error - 错误对象
   * @returns {boolean} 是否为Cloudflare网络限制错误
   */
  isCloudflareNetworkError(error) {
    // Cloudflare网络限制错误通常包含特定的错误消息
    return error.message && (
      error.message.includes("A network issue was detected") ||
      error.message.includes("Network connection failure") ||
      error.message.includes("connection failed") ||
      error.message.includes("timed out") ||
      error.message.includes("Stream was cancelled") ||
      error.message.includes("proxy request failed") ||
      error.message.includes("cannot connect to the specified address") ||
      error.message.includes("TCP Loop detected") ||
      error.message.includes("Connections to port 25 are prohibited")
    );
  }

  async handleDnsQuery(req) {
    // Socket代理不直接处理DNS查询请求，需要使用DoH或DoT代理
    return new Response("Socket proxy does not support DNS query handling. Please use DoH or DoT proxy.", { status: 400 });
  }
}