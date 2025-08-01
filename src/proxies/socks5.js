import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';

/**
 * SOCKS5代理类
 * 使用SOCKS5代理进行连接
 */
export class Socks5Proxy extends BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    super(config);
    this.parsedSocks5Address = this.parseSocks5Address(config.SOCKS5_ADDRESS);
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
    
    // 通过SOCKS5代理连接
    const socket = await this.socks5Connect(
      2, // domain name
      targetUrl.hostname,
      Number(targetUrl.port) || (targetUrl.protocol === "wss:" ? 443 : 80)
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
    const targetUrl = new URL(dstUrl);
    
    // 清理头部信息
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // 对于标准HTTP请求：设置必需的头部（如Host并禁用压缩）
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      // 通过SOCKS5代理连接
      const socket = await this.socks5Connect(
        2, // domain name
        targetUrl.hostname,
        Number(targetUrl.port) || (targetUrl.protocol === "https:" ? 443 : 80)
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
      // 使用统一的错误处理方法
      return this.handleError(error, "SOCKS5 connection");
    }
  }

  /**
   * 通过SOCKS5代理连接
   * @param {number} addressType - 地址类型
   * @param {string} addressRemote - 远程地址
   * @param {number} portRemote - 远程端口
   * @returns {Promise<Socket>} Socket对象
   */
  async socks5Connect(addressType, addressRemote, portRemote) {
    const { username, password, hostname, port } = this.parsedSocks5Address;
    // Connect to the SOCKS server
    const socket = connect({
      hostname,
      port,
    });

    // Request head format (Worker -> Socks Server):
    // +----+----------+----------+
    // |VER | NMETHODS | METHODS  |
    // +----+----------+----------+
    // | 1  |    1     | 1 to 255 |
    // +----+----------+----------+

    // https://en.wikipedia.org/wiki/SOCKS#SOCKS5
    // For METHODS:
    // 0x00 NO AUTHENTICATION REQUIRED
    // 0x02 USERNAME/PASSWORD https://datatracker.ietf.org/doc/html/rfc1929
    const socksGreeting = new Uint8Array([5, 2, 0, 2]);

    const writer = socket.writable.getWriter();

    await writer.write(socksGreeting);
    this.log('sent socks greeting');

    const reader = socket.readable.getReader();
    const encoder = new TextEncoder();
    let res = (await reader.read()).value;
    // Response format (Socks Server -> Worker):
    // +----+--------+
    // |VER | METHOD |
    // +----+--------+
    // | 1  |   1    |
    // +----+--------+
    if (res[0] !== 0x05) {
      this.log(`socks server version error: ${res[0]} expected: 5`);
      throw new Error(`socks server version error: ${res[0]} expected: 5`);
    }
    if (res[1] === 0xff) {
      this.log("no acceptable methods");
      throw new Error("no acceptable methods");
    }

    // if return 0x0502
    if (res[1] === 0x02) {
      this.log("socks server needs auth");
      if (!username || !password) {
        this.log("please provide username/password");
        throw new Error("please provide username/password");
      }
      // +----+------+----------+------+----------+
      // |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
      // +----+------+----------+------+----------+
      // | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
      // +----+------+----------+------+----------+
      const authRequest = new Uint8Array([
        1,
        username.length,
        ...encoder.encode(username),
        password.length,
        ...encoder.encode(password)
      ]);
      await writer.write(authRequest);
      res = (await reader.read()).value;
      // expected 0x0100
      if (res[0] !== 0x01 || res[1] !== 0x00) {
        this.log("fail to auth socks server");
        throw new Error("fail to auth socks server");
      }
    }

    // Request data format (Worker -> Socks Server):
    // +----+-----+-------+------+----------+----------+
    // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
    // +----+-----+-------+------+----------+----------+
    // | 1  |  1  | X'00' |  1   | Variable |    2     |
    // +----+-----+-------+------+----------+----------+
    // ATYP: address type of following address
    // 0x01: IPv4 address
    // 0x03: Domain name
    // 0x04: IPv6 address
    // DST.ADDR: desired destination address
    // DST.PORT: desired destination port in network octet order

    // addressType
    // 1--> ipv4  addressLength =4
    // 2--> domain name
    // 3--> ipv6  addressLength =16
    let DSTADDR; // DSTADDR = ATYP + DST.ADDR
    switch (addressType) {
      case 1:
        DSTADDR = new Uint8Array(
          [1, ...addressRemote.split('.').map(Number)]
        );
        break;
      case 2:
        DSTADDR = new Uint8Array(
          [3, addressRemote.length, ...encoder.encode(addressRemote)]
        );
        break;
      case 3:
        DSTADDR = new Uint8Array(
          [4, ...addressRemote.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]
        );
        break;
      default:
        this.log(`invalid addressType is ${addressType}`);
        throw new Error(`invalid addressType is ${addressType}`);
    }
    const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
    await writer.write(socksRequest);
    this.log('sent socks request');

    res = (await reader.read()).value;
    // Response format (Socks Server -> Worker):
    //  +----+-----+-------+------+----------+----------+
    // |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
    // +----+-----+-------+------+----------+----------+
    // | 1  |  1  | X'00' |  1   | Variable |    2     |
    // +----+-----+-------+------+----------+----------+
    if (res[1] === 0x00) {
      this.log("socks connection opened");
    } else {
      this.log("fail to open socks connection");
      throw new Error("fail to open socks connection");
    }
    writer.releaseLock();
    reader.releaseLock();
    return socket;
  }

  /**
   * 解析SOCKS5地址
   * @param {string} address - SOCKS5地址
   * @returns {object} 解析后的地址信息
   */
  parseSocks5Address(address) {
    let [latter, former] = address.split("@").reverse();
    let username, password, hostname, port;
    if (former) {
      const formers = former.split(":");
      if (formers.length !== 2) {
        throw new Error('Invalid SOCKS address format');
      }
      [username, password] = formers;
    }
    const latters = latter.split(":");
    port = Number(latters.pop());
    if (isNaN(port)) {
      throw new Error('Invalid SOCKS address format');
    }
    hostname = latters.join(":");
    const regex = /^\[.*\]$/;
    if (hostname.includes(":") && !regex.test(hostname)) {
      throw new Error('Invalid SOCKS address format');
    }
    return {
      username,
      password,
      hostname,
      port,
    }
  }
}