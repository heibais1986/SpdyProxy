/**
 * SpectreProxy
 * 支持的代理策略：
 * - socket: 使用Cloudflare Socket API (默认)
 * - fetch: 使用Fetch API
 * - socks5: 使用SOCKS5代理
 * - thirdparty: 使用第三方代理服务
 * - cloudprovider: 使用其他云服务商函数
 * 环境变量配置：
 * - AUTH_TOKEN: 认证令牌，务必修改
 * - PROXY_STRATEGY: 主代理策略 (默认: "socket")
 * - FALLBACK_PROXY_STRATEGY: 备用代理策略 (默认: "fetch")
 * - DEBUG_MODE: 调试模式 (默认: false)
 * - SOCKS5_ADDRESS: SOCKS5代理地址
 * - THIRD_PARTY_PROXY_URL: 第三方代理URL
 * - CLOUD_PROVIDER_URL: 云服务商函数URL
 * - DOH_SERVER_HOSTNAME: DoH服务器主机名 (默认: "dns.google")
 * - DOT_SERVER_HOSTNAME: DoT服务器主机名 (默认: "dns.google")
 */

import { connect } from 'cloudflare:sockets';

class ConfigManager {
  static DEFAULT_CONFIG = {
    AUTH_TOKEN: "your-auth-token",//认证令牌，务必在此修改或添加环境变量
    DEFAULT_DST_URL: "https://httpbin.org/get",
    DEBUG_MODE: false,
    PROXY_STRATEGY: "socket",
    FALLBACK_PROXY_STRATEGY: "fetch",
    PROXY_IP: "",//暂未实现，不必填写，后续可能废弃
    SOCKS5_ADDRESS: "",
    THIRD_PARTY_PROXY_URL: "",
    CLOUD_PROVIDER_URL: "",
    DOH_SERVER_HOSTNAME: "dns.google",
    DOH_SERVER_PORT: 443,
    DOH_SERVER_PATH: "/dns-query",
    DOT_SERVER_HOSTNAME: "dns.google",
    DOT_SERVER_PORT: 853,
  };

  static updateConfigFromEnv(env) {
    if (!env) return { ...this.DEFAULT_CONFIG };
    
    const config = { ...this.DEFAULT_CONFIG };
    
    for (const key of Object.keys(config)) {
      if (key in env) {
        if (typeof config[key] === 'boolean') {
          config[key] = env[key] === 'true';
        } else {
          config[key] = env[key];
        }
      }
    }
    
    return config;
  }

  static getConfigValue(config, key, defaultValue = null) {
    return config[key] !== undefined ? config[key] : defaultValue;
  }
}

class BaseProxy {
  constructor(config) {
    this.config = config;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    
    this.log = config.DEBUG_MODE
      ? (message, data = "") => console.log(`[DEBUG] ${message}`, data)
      : () => {};
  }

  async connect(req, dstUrl) {
    throw new Error("connect method must be implemented by subclass");
  }

  async connectWebSocket(req, dstUrl) {
    throw new Error("connectWebSocket method must be implemented by subclass");
  }

  async connectHttp(req, dstUrl) {
    throw new Error("connectHttp method must be implemented by subclass");
  }

  async handleDnsQuery(req) {
    return new Response("DNS query handling not implemented for this proxy type", { status: 501 });
  }

  handleError(error, context, status = 500) {
    this.log(`${context} failed`, error.message);
    return new Response(`Error ${context.toLowerCase()}: ${error.message}`, { status });
  }

  isCloudflareNetworkError(error) {
    return false;
  }

  async connectHttpViaProxy(req, dstUrl, proxyUrl, proxyType) {
    const targetUrl = new URL(dstUrl);
    const proxyUrlObj = new URL(proxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);
    
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set("Host", proxyUrlObj.hostname);
    
    try {
      const fetchRequest = new Request(proxyUrlObj.toString(), {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log(`Using ${proxyType} proxy to connect to`, dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      return this.handleError(error, `${proxyType} proxy connection`);
    }
  }

  filterHeaders(headers) {
    const HEADER_FILTER_RE = /^(host|accept-encoding|cf-|cdn-|referer|referrer)/i;
    const cleanedHeaders = new Headers();
    
    for (const [k, v] of headers) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    return cleanedHeaders;
  }

  generateWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
  }

  relayWebSocketFrames(ws, socket, writer, reader) {
    ws.addEventListener("message", async (event) => {
      let payload;
      if (typeof event.data === "string") {
        payload = this.encoder.encode(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        payload = new Uint8Array(event.data);
      } else {
        payload = event.data;
      }
      const frame = this.packTextFrame(payload);
      try {
        await writer.write(frame);
      } catch (e) {
        this.log("Remote write error", e);
      }
    });
    
    (async () => {
      const frameReader = new this.SocketFramesReader(reader, this);
      try {
        while (true) {
          const frame = await frameReader.nextFrame();
          if (!frame) break;
          switch (frame.opcode) {
            case 1: 
            case 2: 
              ws.send(frame.payload);
              break;
            case 8: 
              this.log("Received Close frame, closing WebSocket");
              ws.close(1000);
              return;
            default:
              this.log(`Received unknown frame type, Opcode: ${frame.opcode}`);
          }
        }
      } catch (e) {
        this.log("Error reading remote frame", e);
      } finally {
        ws.close();
        writer.releaseLock();
        socket.close();
      }
    })();
    
    ws.addEventListener("close", () => socket.close());
  }

  packTextFrame(payload) {
    const FIN_AND_OP = 0x81; 
    const maskBit = 0x80; 
    const len = payload.length;
    let header;
    if (len < 126) {
      header = new Uint8Array(2);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = new Uint8Array(4);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | 126;
      header[2] = (len >> 8) & 0xff;
      header[3] = len & 0xff;
    } else {
      throw new Error("Payload too large");
    }
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    const maskedPayload = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    return this.concatUint8Arrays(header, mask, maskedPayload);
  }

  SocketFramesReader = class {
    constructor(reader, parent) {
      this.reader = reader;
      this.parent = parent;
      this.buffer = new Uint8Array();
      this.fragmentedPayload = null;
      this.fragmentedOpcode = null;
    }
    
    async ensureBuffer(length) {
      while (this.buffer.length < length) {
        const { value, done } = await this.reader.read();
        if (done) return false;
        this.buffer = this.parent.concatUint8Arrays(this.buffer, value);
      }
      return true;
    }
    
    async nextFrame() {
      while (true) {
        if (!(await this.ensureBuffer(2))) return null;
        const first = this.buffer[0],
          second = this.buffer[1],
          fin = (first >> 7) & 1,
          opcode = first & 0x0f,
          isMasked = (second >> 7) & 1;
        let payloadLen = second & 0x7f,
          offset = 2;
        if (payloadLen === 126) {
          if (!(await this.ensureBuffer(offset + 2))) return null;
          payloadLen = (this.buffer[offset] << 8) | this.buffer[offset + 1];
          offset += 2;
        } else if (payloadLen === 127) {
          throw new Error("127 length mode is not supported");
        }
        let mask;
        if (isMasked) {
          if (!(await this.ensureBuffer(offset + 4))) return null;
          mask = this.buffer.slice(offset, offset + 4);
          offset += 4;
        }
        if (!(await this.ensureBuffer(offset + payloadLen))) return null;
        let payload = this.buffer.slice(offset, offset + payloadLen);
        if (isMasked && mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        this.buffer = this.buffer.slice(offset + payloadLen);
        if (opcode === 0) {
          if (this.fragmentedPayload === null)
            throw new Error("Received continuation frame without initiation");
          this.fragmentedPayload = this.parent.concatUint8Arrays(this.fragmentedPayload, payload);
          if (fin) {
            const completePayload = this.fragmentedPayload;
            const completeOpcode = this.fragmentedOpcode;
            this.fragmentedPayload = this.fragmentedOpcode = null;
            return { fin: true, opcode: completeOpcode, payload: completePayload };
          }
        } else {
          if (!fin) {
            this.fragmentedPayload = payload;
            this.fragmentedOpcode = opcode;
            continue;
          } else {
            if (this.fragmentedPayload) {
              this.fragmentedPayload = this.fragmentedOpcode = null;
            }
            return { fin, opcode, payload };
          }
        }
      }
    }
  };

  concatUint8Arrays(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  parseHttpHeaders(buff) {
    const text = this.decoder.decode(buff);
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
    const headers = new Headers();
    for (let i = 1; i < headerSection.length; i++) {
      const line = headerSection[i];
      const idx = line.indexOf(": ");
      if (idx !== -1) {
        headers.append(line.slice(0, idx), line.slice(idx + 2));
      }
    }
    return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
  }

  async readUntilDoubleCRLF(reader) {
    let respText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        respText += this.decoder.decode(value, { stream: true });
        if (respText.includes("\r\n\r\n")) break;
      }
      if (done) break;
    }
    return respText;
  }

  async parseResponse(reader) {
    let buff = new Uint8Array();
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buff = this.concatUint8Arrays(buff, value);
        const parsed = this.parseHttpHeaders(buff);
        if (parsed) {
          const { status, statusText, headers, headerEnd } = parsed;
          const isChunked = headers.get("transfer-encoding")?.includes("chunked");
          const contentLength = parseInt(headers.get("content-length") || "0", 10);
          const data = buff.slice(headerEnd + 4);
          const self = this;
          return new Response(
            new ReadableStream({
              start: async (ctrl) => {
                try {
                  if (isChunked) {
                    console.log("Using chunked transfer mode");
                    for await (const chunk of self.readChunks(reader, data)) {
                      ctrl.enqueue(chunk);
                    }
                  } else {
                    console.log("Using fixed-length transfer mode, contentLength: " + contentLength);
                    let received = data.length;
                    if (data.length) ctrl.enqueue(data);
                    while (received < contentLength) {
                      const { value, done } = await reader.read();
                      if (done) break;
                      received += value.length;
                      ctrl.enqueue(value);
                    }
                  }
                  ctrl.close();
                } catch (err) {
                  console.log("Error parsing response", err);
                  ctrl.error(err);
                }
              },
            }),
            { status, statusText, headers }
          );
        }
      }
      if (done) break;
    }
    throw new Error("Unable to parse response headers");
  }

  async *readChunks(reader, buff = new Uint8Array()) {
    while (true) {
      let pos = -1;
      for (let i = 0; i < buff.length - 1; i++) {
        if (buff[i] === 13 && buff[i + 1] === 10) {
          pos = i;
          break;
        }
      }
      if (pos === -1) {
        const { value, done } = await reader.read();
        if (done) break;
        buff = this.concatUint8Arrays(buff, value);
        continue;
      }
      const sizeStr = this.decoder.decode(buff.slice(0, pos));
      const size = parseInt(sizeStr, 16);
      this.log("Read chunk size", size);
      if (!size) break;
      buff = buff.slice(pos + 2);
      while (buff.length < size + 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected EOF in chunked encoding");
        buff = this.concatUint8Arrays(buff, value);
      }
      yield buff.slice(0, size);
      buff = buff.slice(size + 2);
    }
  }
}

class SocketProxy extends BaseProxy {
  constructor(config) {
    super(config);
  }

  async connect(req, dstUrl) {
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return await this.connectWebSocket(req, dstUrl);
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  async connectWebSocket(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: isSecure ? "on" : "off", allowHalfOpen: false }
    );
  
    const key = this.generateWebSocketKey();

    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
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
    
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];
    client.accept();
    
    this.relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  }

  async connectHttp(req, dstUrl) {
    const reqForFallback = req.clone();
    const targetUrl = new URL(dstUrl);
    
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      const port = targetUrl.protocol === "https:" ? 443 : 80;
      const socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: targetUrl.protocol === "https:" ? "on" : "off", allowHalfOpen: false }
      );
      const writer = socket.writable.getWriter();
      
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      
      this.log("Sending request", requestLine);
      await writer.write(this.encoder.encode(requestLine));
    
      if (req.body) {
        this.log("Forwarding request body");
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      
      return await this.parseResponse(socket.readable.getReader());
    } catch (error) {
      if (this.isCloudflareNetworkError(error)) {
        this.log("Cloudflare network restriction detected, switching to fallback proxy");
        this.log("Original error:", error.message);
        
        const fallbackStrategy = this.config.FALLBACK_PROXY_STRATEGY || "fetch";
        this.log("Using fallback strategy:", fallbackStrategy);
        
        const fallbackConfig = { ...this.config, PROXY_STRATEGY: fallbackStrategy };
        let fallbackProxy;
        
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
        
        return await fallbackProxy.connectHttp(reqForFallback, dstUrl);
      }
      
      return this.handleError(error, "Socket connection");
    }
  }

  isCloudflareNetworkError(error) {
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
    return new Response("Socket proxy does not support DNS query handling. Please use DoH or DoT proxy.", { status: 400 });
  }
}

class FetchProxy extends BaseProxy {
  constructor(config) {
    super(config);
    this.UPSTREAM_DNS_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
  }

  async connect(req, dstUrl) {
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return new Response("Fetch proxy does not support WebSocket", { status: 400 });
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  async connectHttp(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set("Host", targetUrl.hostname);
    
    try {
      const fetchRequest = new Request(dstUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to connect to", dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      return this.handleError(error, "Fetch connection");
    }
  }

  async connectWebSocket(req, dstUrl) {
    return new Response("Fetch proxy does not support WebSocket", { status: 400 });
  }

  async handleDnsQuery(req) {
    try {
      const upstreamDnsUrl = `https://${this.UPSTREAM_DNS_SERVER.hostname}${this.UPSTREAM_DNS_SERVER.path}`;
      
      const cleanedHeaders = this.filterHeaders(req.headers);
      
      cleanedHeaders.set("Host", this.UPSTREAM_DNS_SERVER.hostname);
      cleanedHeaders.set("Content-Type", "application/dns-message");
      cleanedHeaders.set("Accept", "application/dns-message");
      
      const fetchRequest = new Request(upstreamDnsUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to handle DNS query");
      return await fetch(fetchRequest);
    } catch (error) {
      return this.handleError(error, "Fetch DNS query handling", 502);
    }
  }
}

class Socks5Proxy extends BaseProxy {
  constructor(config) {
    super(config);
    this.parsedSocks5Address = this.parseSocks5Address(config.SOCKS5_ADDRESS);
  }

  async connect(req, dstUrl) {
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return await this.connectWebSocket(req, dstUrl);
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  async connectWebSocket(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    if (!/^wss?:\/\//i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    
    const socket = await this.socks5Connect(
      2, 
      targetUrl.hostname,
      Number(targetUrl.port) || (targetUrl.protocol === "wss:" ? 443 : 80)
    );
  
    const key = this.generateWebSocketKey();

    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
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
    
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];
    client.accept();
    
    this.relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  }

  async connectHttp(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      const socket = await this.socks5Connect(
        2, 
        targetUrl.hostname,
        Number(targetUrl.port) || (targetUrl.protocol === "https:" ? 443 : 80)
      );
      
      const writer = socket.writable.getWriter();
      
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      
      this.log("Sending request", requestLine);
      await writer.write(this.encoder.encode(requestLine));
    
      if (req.body) {
        this.log("Forwarding request body");
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      
      return await this.parseResponse(socket.readable.getReader());
    } catch (error) {
      return this.handleError(error, "SOCKS5 connection");
    }
  }

  async socks5Connect(addressType, addressRemote, portRemote) {
    const { username, password, hostname, port } = this.parsedSocks5Address;
    const socket = connect({
      hostname,
      port,
    });

    const socksGreeting = new Uint8Array([5, 2, 0, 2]);

    const writer = socket.writable.getWriter();

    await writer.write(socksGreeting);
    this.log('sent socks greeting');

    const reader = socket.readable.getReader();
    const encoder = new TextEncoder();
    let res = (await reader.read()).value;
    if (res[0] !== 0x05) {
      this.log(`socks server version error: ${res[0]} expected: 5`);
      throw new Error(`socks server version error: ${res[0]} expected: 5`);
    }
    if (res[1] === 0xff) {
      this.log("no acceptable methods");
      throw new Error("no acceptable methods");
    }

    if (res[1] === 0x02) {
      this.log("socks server needs auth");
      if (!username || !password) {
        this.log("please provide username/password");
        throw new Error("please provide username/password");
      }
      const authRequest = new Uint8Array([
        1,
        username.length,
        ...encoder.encode(username),
        password.length,
        ...encoder.encode(password)
      ]);
      await writer.write(authRequest);
      res = (await reader.read()).value;
      if (res[0] !== 0x01 || res[1] !== 0x00) {
        this.log("fail to auth socks server");
        throw new Error("fail to auth socks server");
      }
    }

    let DSTADDR; 
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

class ThirdPartyProxy extends BaseProxy {
  constructor(config) {
    super(config);
  }

  async connect(req, dstUrl) {
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return new Response("Third party proxy may not support WebSocket", { status: 400 });
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  async connectHttp(req, dstUrl) {
    const thirdPartyProxyUrl = this.config.THIRD_PARTY_PROXY_URL;
    if (!thirdPartyProxyUrl) {
      return this.handleError(new Error("Third party proxy URL is not configured"), "Third party proxy connection", 500);
    }

    const proxyUrlObj = new URL(thirdPartyProxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', 
    });

    try {
      this.log(`Using third party proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Third party proxy connection");
    }
  }

  async connectWebSocket(req, dstUrl) {
    return new Response("Third party proxy may not support WebSocket", { status: 400 });
  }
}

class CloudProviderProxy extends BaseProxy {
  constructor(config) {
    super(config);
  }

  async connect(req, dstUrl) {
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  async connectHttp(req, dstUrl) {
    const cloudProviderUrl = this.config.CLOUD_PROVIDER_URL;
    if (!cloudProviderUrl) {
      return this.handleError(new Error("Cloud provider URL is not configured"), "Cloud provider proxy connection", 500);
    }

    const proxyUrlObj = new URL(cloudProviderUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', 
    });

    try {
      this.log(`Using cloud provider proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Cloud provider proxy connection");
    }
  }

  async connectWebSocket(req, dstUrl) {
    return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
  }
}

class DoHProxy extends BaseProxy {
  constructor(config) {
    super(config);
    this.UPSTREAM_DOH_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      port: config.DOH_SERVER_PORT || 443,
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
  }

  async handleDnsQuery(req) {
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/dns-message') {
      return new Response('This is a DNS proxy. Please use a DoH client.', { status: 400 });
    }

    let clientDnsQuery;
    try {
      clientDnsQuery = await req.arrayBuffer();

      const cleanedHeaders = this.filterHeaders(req.headers);

      cleanedHeaders.set('Host', this.UPSTREAM_DOH_SERVER.hostname);
      cleanedHeaders.set('Content-Type', 'application/dns-message');
      cleanedHeaders.set('Content-Length', clientDnsQuery.byteLength.toString());
      cleanedHeaders.set('Accept', 'application/dns-message');
      cleanedHeaders.set('Connection', 'close'); 

      const socket = connect(this.UPSTREAM_DOH_SERVER, { secureTransport: 'on', allowHalfOpen: false });
      const writer = socket.writable.getWriter();

      const httpHeaders =
        `POST ${this.UPSTREAM_DOH_SERVER.path} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';

      const requestHeaderBytes = this.encoder.encode(httpHeaders);
      const requestBodyBytes = new Uint8Array(clientDnsQuery);

      const fullRequest = new Uint8Array(requestHeaderBytes.length + requestBodyBytes.length);
      fullRequest.set(requestHeaderBytes, 0);
      fullRequest.set(requestBodyBytes, requestHeaderBytes.length);

      await writer.write(fullRequest);
      writer.releaseLock();

      const reader = socket.readable.getReader();
      let responseBytes = new Uint8Array();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const newBuffer = new Uint8Array(responseBytes.length + value.length);
        newBuffer.set(responseBytes, 0);
        newBuffer.set(value, responseBytes.length);
        responseBytes = newBuffer;
      }

      reader.releaseLock();
      await socket.close();

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

      return new Response(dnsResponseBody, {
        headers: { 'content-type': 'application/dns-message' },
      });
    } catch (error) {
      try {
        const fallbackProxy = new FetchProxy(this.config);
        const fallbackRequest = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: clientDnsQuery 
        });
        return await fallbackProxy.handleDnsQuery(fallbackRequest);
      } catch (fallbackError) {
        return this.handleError(fallbackError, "DoH proxying with connect", 502);
      }
    }
  }

  async connect(req, dstUrl) {
    return await this.handleDnsQuery(req);
  }

  async connectHttp(req, dstUrl) {
    return await this.handleDnsQuery(req);
  }

  async connectWebSocket(req, dstUrl) {
    return new Response("DoH proxy does not support WebSocket", { status: 400 });
  }
}

class DoTProxy extends BaseProxy {
  constructor(config) {
    super(config);
    this.UPSTREAM_DOT_SERVER = {
      hostname: config.DOT_SERVER_HOSTNAME || 'some-niche-dns.com',
      port: config.DOT_SERVER_PORT || 853,
    };
  }

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
      new DataView(lengthBuffer.buffer).setUint16(0, queryLength, false); 
      
      const dotRequest = new Uint8Array(2 + queryLength);
      dotRequest.set(lengthBuffer, 0);
      dotRequest.set(new Uint8Array(clientDnsQuery), 2);
      
      await writer.write(dotRequest);
      writer.releaseLock();
      
      const reader = socket.readable.getReader();
      let responseChunks = [];
      let totalLength = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseChunks.push(value);
        totalLength += value.length;
      }

      reader.releaseLock();
      await socket.close();
      
      const fullResponse = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of responseChunks) {
          fullResponse.set(chunk, offset);
          offset += chunk.length;
      }

      const responseLength = new DataView(fullResponse.buffer).getUint16(0, false);
      const dnsResponse = fullResponse.slice(2, 2 + responseLength);

      return new Response(dnsResponse, {
        headers: { 'content-type': 'application/dns-message' },
      });

    } catch (socketError) {
      this.log('DoT socket connection failed, falling back to DoH via fetch.', socketError);
      
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

  async connect(req, dstUrl) {
    return await this.handleDnsQuery(req);
  }

  async connectHttp(req, dstUrl) {
    return await this.handleDnsQuery(req);
  }

  async connectWebSocket(req, dstUrl) {
    return new Response("DoT proxy does not support WebSocket", { status: 400 });
  }
}

class ProxyFactory {
  static createProxy(config) {
    const strategy = config.PROXY_STRATEGY || 'socket';
    
    switch (strategy.toLowerCase()) {
      case 'socket':
        return new SocketProxy(config);
      case 'fetch':
        return new FetchProxy(config);
      case 'socks5':
        return new Socks5Proxy(config);
      case 'thirdparty':
        return new ThirdPartyProxy(config);
      case 'cloudprovider':
        return new CloudProviderProxy(config);
      case 'doh':
        return new DoHProxy(config);
      case 'dot':
        return new DoTProxy(config);
      default:
        return new SocketProxy(config);
    }
  }
}

class ShadowProxy {
  static async handleRequest(req, env, ctx) {
    try {
      const config = ConfigManager.updateConfigFromEnv(env);
      
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      
      if (parts.length >= 3 && parts[1] === 'dns') {
        const auth = parts[0];
        const dnsType = parts[2]; 
        const server = parts[3]; 
        
        if (auth === config.AUTH_TOKEN) {
          let proxyStrategy = config.PROXY_STRATEGY;
          if (dnsType === 'doh') {
            proxyStrategy = 'doh';
          } else if (dnsType === 'dot') {
            proxyStrategy = 'dot';
          }
          
          const dnsConfig = { ...config, PROXY_STRATEGY: proxyStrategy };
          const proxy = ProxyFactory.createProxy(dnsConfig);
          
          return await proxy.handleDnsQuery(req);
        }
      }
      
      const proxy = ProxyFactory.createProxy(config);
      
      const dstUrl = this.parseDestinationUrl(req, config);
      
      return await proxy.connect(req, dstUrl);
    } catch (error) {
      console.error("ShadowProxy error:", error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }

  static parseDestinationUrl(req, config) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const [auth, protocol, ...path] = parts;

    const isValid = auth === config.AUTH_TOKEN;
    
    let dstUrl = config.DEFAULT_DST_URL;

    if (isValid && protocol) {
      if (protocol.endsWith(':')) {
        dstUrl = `${protocol}//${path.join("/")}${url.search}`;
      } else {
        dstUrl = `${protocol}://${path.join("/")}${url.search}`;
      }
    }
    
    if (config.DEBUG_MODE) {
      console.log("Target URL", dstUrl);
    }
    
    return dstUrl;
  }
}

export default {
  async fetch(request, env, ctx) {
    return await ShadowProxy.handleRequest(request, env, ctx);
  }
};
