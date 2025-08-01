import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';
import { FetchProxy } from './fetch.js';

/**
 * DoH (DNS over HTTPS) 代理类
 * 用于代理DNS查询请求
 */
export class DoHProxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    super(config);
    // 上游DoH服务器信息
    this.UPSTREAM_DOH_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      port: config.DOH_SERVER_PORT || 443,
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
  }

  /**
   * 处理DNS查询请求
   * @param {Request} req - 请求对象
   * @returns {Promise<Response>} 响应对象
   */
  async handleDnsQuery(req) {
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/dns-message') {
      return new Response('This is a DNS proxy. Please use a DoH client.', { status: 400 });
    }

    let clientDnsQuery;
    try {
      clientDnsQuery = await req.arrayBuffer();

      // 过滤请求头，确保不泄露敏感信息
      const cleanedHeaders = this.filterHeaders(req.headers);

      // DOH请求头
      cleanedHeaders.set('Host', this.UPSTREAM_DOH_SERVER.hostname);
      cleanedHeaders.set('Content-Type', 'application/dns-message');
      cleanedHeaders.set('Content-Length', clientDnsQuery.byteLength.toString());
      cleanedHeaders.set('Accept', 'application/dns-message');
      cleanedHeaders.set('Connection', 'close'); // 完成后关闭连接，简化处理

      // 建立TLS连接
      const socket = connect(this.UPSTREAM_DOH_SERVER, { secureTransport: 'on', allowHalfOpen: false });
      const writer = socket.writable.getWriter();

      // 构建HTTP POST请求
      const httpHeaders =
        `POST ${this.UPSTREAM_DOH_SERVER.path} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';

      const requestHeaderBytes = this.encoder.encode(httpHeaders);
      const requestBodyBytes = new Uint8Array(clientDnsQuery);

      // 合并请求头和请求体
      const fullRequest = new Uint8Array(requestHeaderBytes.length + requestBodyBytes.length);
      fullRequest.set(requestHeaderBytes, 0);
      fullRequest.set(requestBodyBytes, requestHeaderBytes.length);

      // 请求
      await writer.write(fullRequest);
      writer.releaseLock();

      // 读取并解析响应
      const reader = socket.readable.getReader();
      let responseBytes = new Uint8Array();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 合并数据块
        const newBuffer = new Uint8Array(responseBytes.length + value.length);
        newBuffer.set(responseBytes, 0);
        newBuffer.set(value, responseBytes.length);
        responseBytes = newBuffer;
      }

      reader.releaseLock();
      await socket.close();

      // 5. 剥离HTTP响应头，提取Body，只返回DNS响应结果
      const separator = new Uint8Array([13, 10, 13, 10]);
      let separatorIndex = -1;
      for (let i = 0; i < responseBytes.length - 3; i++) {
        if (responseBytes[i] === separator[0] && responseBytes[i + 1] === separator[1] && 
            responseBytes[i + 2] === separator[2] && responseBytes[i + 3] === separator[3]) {
          separatorIndex = i;
          break;
        }
      }

      if (separatorIndex === -1) {
        throw new Error("Could not find HTTP header/body separator in response.");
      }

      const dnsResponseBody = responseBytes.slice(separatorIndex + 4);

      // 返回DNS响应
      return new Response(dnsResponseBody, {
        headers: { 'content-type': 'application/dns-message' },
      });
    } catch (error) {
      // socket策略失败时，回退到fetch策略
      try {
        const fallbackProxy = new FetchProxy(this.config);
        // 不能重用原始请求，它的主体已被读取。我们使用已有的主体数据创建一个新的请求。
        const fallbackRequest = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: clientDnsQuery // 之前读取的缓冲区
        });
        return await fallbackProxy.handleDnsQuery(fallbackRequest);
      } catch (fallbackError) {
        return this.handleError(fallbackError, "DoH proxying with connect", 502);
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
    // DoH代理专门处理DNS查询请求
    return await this.handleDnsQuery(req);
  }

  /**
   * 连接HTTP目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttp(req, dstUrl) {
    // DoH代理专门处理DNS查询请求
    return await this.handleDnsQuery(req);
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    // DoH代理不支持WebSocket
    return new Response("DoH proxy does not support WebSocket", { status: 400 });
  }
}