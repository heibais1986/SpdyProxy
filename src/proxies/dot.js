import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';

/**
 * DoT 代理类
 * 用于代理DOT查询请求
 */
export class DoTProxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    super(config);
    // 获取上游DoT服务器信息
    this.UPSTREAM_DOT_SERVER = {
      hostname: config.DOT_SERVER_HOSTNAME || 'some-niche-dns.com',
      port: config.DOT_SERVER_PORT || 853,
    };
  }

  /**
   * 处理DNS查询请求
   * @param {Request} req - 请求对象
   * @returns {Promise<Response>} 响应对象
   */
  async handleDnsQuery(req) {
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/dns-message') {
      return new Response('This is a DNS proxy. Please use a DoT client.', { status: 400 });
    }

    let clientDnsQuery;
    try {
      clientDnsQuery = await req.arrayBuffer();
      const socket = connect(this.UPSTREAM_DOT_SERVER, { secureTransport: 'on', allowHalfOpen: false });
      const writer = socket.writable.getWriter();
      const queryLength = clientDnsQuery.byteLength;
      const lengthBuffer = new Uint8Array(2);
      new DataView(lengthBuffer.buffer).setUint16(0, queryLength, false); // Big-endian
      const dotRequest = new Uint8Array(2 + queryLength);
      dotRequest.set(lengthBuffer, 0);
      dotRequest.set(new Uint8Array(clientDnsQuery), 2);
      await writer.write(dotRequest);
      writer.releaseLock();
      const reader = socket.readable.getReader();
      let responseChunks = [];
      let totalLength = 0;
      
      // DoT 的响应可能分片，需要循环读取
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseChunks.push(value);
        totalLength += value.length;
      }

      reader.releaseLock();
      await socket.close();
      
      // 合并分片
      const fullResponse = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of responseChunks) {
          fullResponse.set(chunk, offset);
          offset += chunk.length;
      }

      // 解析 DoT 响应（去掉2字节长度前缀）
      const responseLength = new DataView(fullResponse.buffer).getUint16(0, false);
      const dnsResponse = fullResponse.slice(2, 2 + responseLength);

      //返回DNS查询结果
      return new Response(dnsResponse, {
        headers: { 'content-type': 'application/dns-message' },
      });

    } catch (socketError) {
      this.log('DoT socket connection failed, falling back to DoH via fetch.', socketError);
      
      // DOT使用socket策略请求失败（一般因目标DOT服务器使用了Cloudflare网络），使用Fetch请求DOH作为回退
      // 由于使用Fetch请求Cloudflare网络的DOT服务器频繁出现问题，所以使用Fetch请求DOH作为回退
      try {
        this.log('Attempting DoH fallback...');
        const upstreamDnsUrl = `https://${this.config.DOH_SERVER_HOSTNAME}${this.config.DOH_SERVER_PATH || '/dns-query'}`;
        
        const dohHeaders = new Headers();
        dohHeaders.set("Host", this.config.DOH_SERVER_HOSTNAME);
        dohHeaders.set("Content-Type", "application/dns-message");
        dohHeaders.set("Accept", "application/dns-message");
        
        const fallbackRequest = new Request(upstreamDnsUrl, {
            method: 'POST',
            headers: dohHeaders,
            body: clientDnsQuery,
        });
        
        return await fetch(fallbackRequest);

      } catch (fallbackError) {
        this.log('DoH fallback also failed.', fallbackError);
        return this.handleError(fallbackError, 'DoT and subsequent DoH fallback');
      }
    }
  }

  /**
   * 连接目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connect(req, dstUrl) {
    // DoT代理专门处理DNS查询请求
    return await this.handleDnsQuery(req);
  }

  /**
   * 连接HTTP目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttp(req, dstUrl) {
    // DoT代理专门处理DNS查询请求
    return await this.handleDnsQuery(req);
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    // DoT代理不支持WebSocket
    return new Response("DoT proxy does not support WebSocket", { status: 400 });
  }
}