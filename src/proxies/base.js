/**
 * 基础代理类
 * 所有代理策略都应继承此类
 */
export class BaseProxy {
  /**
   * 构造函数
   * @param {object} config - 配置对象
   */
  constructor(config) {
    this.config = config;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    
    // 定义调试日志输出函数
    this.log = config.DEBUG_MODE
      ? (message, data = "") => console.log(`[DEBUG] ${message}`, data)
      : () => {};
  }

  /**
   * 连接目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connect(req, dstUrl) {
    throw new Error("connect method must be implemented by subclass");
  }

  /**
   * 连接WebSocket目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectWebSocket(req, dstUrl) {
    throw new Error("connectWebSocket method must be implemented by subclass");
  }

  /**
   * 连接HTTP目标服务器
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttp(req, dstUrl) {
    throw new Error("connectHttp method must be implemented by subclass");
  }

  /**
   * 处理DNS查询请求
   * @param {Request} req - 请求对象
   * @returns {Promise<Response>} 响应对象
   */
  async handleDnsQuery(req) {
    // 默认实现
    return new Response("DNS query handling not implemented for this proxy type", { status: 501 });
  }

  /**
   * 错误处理方法
   * @param {Error} error - 错误对象
   * @param {string} context - 错误上下文描述
   * @param {number} status - HTTP状态码
   * @returns {Response} 错误响应
   */
  handleError(error, context, status = 500) {
    this.log(`${context} failed`, error.message);
    return new Response(`Error ${context.toLowerCase()}: ${error.message}`, { status });
  }

  /**
   * 检查是否为Cloudflare网络限制错误
   * @param {Error} error - 错误对象
   * @returns {boolean} 是否为Cloudflare网络限制错误
   */
  isCloudflareNetworkError(error) {
    // 默认实现
    return false;
  }

  /**
   * 通用的HTTP代理连接方法
   * @param {Request} req - 请求对象
   * @param {string} dstUrl - 目标URL
   * @param {string} proxyUrl - 代理URL
   * @param {string} proxyType - 代理类型（用于日志）
   * @returns {Promise<Response>} 响应对象
   */
  async connectHttpViaProxy(req, dstUrl, proxyUrl, proxyType) {
    const targetUrl = new URL(dstUrl);
    const proxyUrlObj = new URL(proxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);
    
    // 清理Cloudflare泄露隐私的头部信息
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // 设置必需的头部
    cleanedHeaders.set("Host", proxyUrlObj.hostname);
    
    try {
      // 使用代理进行连接
      const fetchRequest = new Request(proxyUrlObj.toString(), {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log(`Using ${proxyType} proxy to connect to`, dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      // 使用统一的错误处理方法
      return this.handleError(error, `${proxyType} proxy connection`);
    }
  }

  /**
   * 过滤HTTP头
   * @param {Headers} headers - HTTP头
   * @returns {Headers} 过滤后的HTTP头
   */
  filterHeaders(headers) {
    // 过滤不应转发的HTTP头（忽略以下头部：host、accept-encoding、cf-*、cdn-*、referer、referrer）
    const HEADER_FILTER_RE = /^(host|accept-encoding|cf-|cdn-|referer|referrer)/i;
    const cleanedHeaders = new Headers();
    
    for (const [k, v] of headers) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    return cleanedHeaders;
  }

  /**
   * 生成WebSocket握手所需的随机Sec-WebSocket-Key
   * @returns {string} WebSocket密钥
   */
  generateWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
  }

  /**
   * 在客户端和远程套接字之间双向中继WebSocket帧
   * @param {WebSocket} ws - WebSocket对象
   * @param {Socket} socket - Socket对象
   * @param {WritableStreamDefaultWriter} writer - 写入器
   * @param {ReadableStreamDefaultReader} reader - 读取器
   */
  relayWebSocketFrames(ws, socket, writer, reader) {
    // 监听来自客户端的消息，将其打包成帧并发送到远程套接字
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
    
    // 异步中继从远程接收的WebSocket帧到客户端
    (async () => {
      const frameReader = new this.SocketFramesReader(reader, this);
      try {
        while (true) {
          const frame = await frameReader.nextFrame();
          if (!frame) break;
          // 根据操作码处理数据帧
          switch (frame.opcode) {
            case 1: // 文本帧
            case 2: // 二进制帧
              ws.send(frame.payload);
              break;
            case 8: // 关闭帧
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
    
    // 当客户端WebSocket关闭时，也关闭远程套接字连接
    ws.addEventListener("close", () => socket.close());
  }

  /**
   * 将文本消息打包成WebSocket帧
   * @param {Uint8Array} payload - 载荷
   * @returns {Uint8Array} 打包后的帧
   */
  packTextFrame(payload) {
    const FIN_AND_OP = 0x81; // FIN标志和文本帧操作码
    const maskBit = 0x80; // 掩码位（客户端发送的消息必须设置为1）
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
    // 生成4字节随机掩码
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    const maskedPayload = new Uint8Array(len);
    // 对载荷应用掩码
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    // 连接帧头、掩码和掩码后的载荷
    return this.concatUint8Arrays(header, mask, maskedPayload);
  }

  /**
   * 用于解析和重组WebSocket帧的类，支持分片消息
   */
  SocketFramesReader = class {
    /**
     * 构造函数
     * @param {ReadableStreamDefaultReader} reader - 读取器
     * @param {BaseProxy} parent - 父类实例
     */
    constructor(reader, parent) {
      this.reader = reader;
      this.parent = parent;
      this.buffer = new Uint8Array();
      this.fragmentedPayload = null;
      this.fragmentedOpcode = null;
    }
    
    /**
     * 确保缓冲区有足够的字节用于解析
     * @param {number} length - 长度
     * @returns {Promise<boolean>} 是否有足够的字节
     */
    async ensureBuffer(length) {
      while (this.buffer.length < length) {
        const { value, done } = await this.reader.read();
        if (done) return false;
        this.buffer = this.parent.concatUint8Arrays(this.buffer, value);
      }
      return true;
    }
    
    /**
     * 解析下一个WebSocket帧并处理分片
     * @returns {Promise<object|null>} 帧对象
     */
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
        // 如果载荷长度为126，解析下两个字节获取实际长度
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
        // 从缓冲区中移除已处理的字节
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
          // 如果有分片数据但当前帧不是延续帧，重置分片状态
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

  /**
   * 连接多个Uint8Array
   * @param {...Uint8Array} arrays - 要连接的数组
   * @returns {Uint8Array} 连接后的数组
   */
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

  /**
   * 解析HTTP响应头
   * @param {Uint8Array} buff - 缓冲区
   * @returns {object|null} 解析结果
   */
  parseHttpHeaders(buff) {
    const text = this.decoder.decode(buff);
    // 查找由"\r\n\r\n"指示的HTTP头部结束标志
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    // 匹配HTTP状态行
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
    const headers = new Headers();
    // 解析响应头
    for (let i = 1; i < headerSection.length; i++) {
      const line = headerSection[i];
      const idx = line.indexOf(": ");
      if (idx !== -1) {
        headers.append(line.slice(0, idx), line.slice(idx + 2));
      }
    }
    return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
  }

  /**
   * 读取直到双CRLF
   * @param {ReadableStreamDefaultReader} reader - 读取器
   * @returns {Promise<string>} 读取的文本
   */
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

  /**
   * 解析完整的HTTP响应
   * @param {ReadableStreamDefaultReader} reader - 读取器
   * @returns {Promise<Response>} 响应对象
   */
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
          // 通过ReadableStream分发响应体数据
          // 保存this上下文
          const self = this;
          return new Response(
            new ReadableStream({
              start: async (ctrl) => {
                try {
                  if (isChunked) {
                    console.log("Using chunked transfer mode");
                    // 分块传输模式：按顺序读取并入队每个块
                    for await (const chunk of self.readChunks(reader, data)) {
                      ctrl.enqueue(chunk);
                    }
                  } else {
                    console.log("Using fixed-length transfer mode, contentLength: " + contentLength);
                    let received = data.length;
                    if (data.length) ctrl.enqueue(data);
                    // 固定长度模式：根据content-length读取指定字节数
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

  /**
   * 异步生成器：读取分块HTTP响应数据并按顺序产出每个数据块
   * @param {ReadableStreamDefaultReader} reader - 读取器
   * @param {Uint8Array} buff - 缓冲区
   * @returns {AsyncGenerator<Uint8Array>} 数据块生成器
   */
  async *readChunks(reader, buff = new Uint8Array()) {
    while (true) {
      // 在现有缓冲区中查找CRLF分隔符的位置
      let pos = -1;
      for (let i = 0; i < buff.length - 1; i++) {
        if (buff[i] === 13 && buff[i + 1] === 10) {
          pos = i;
          break;
        }
      }
      // 如果未找到，继续读取更多数据来填充缓冲区
      if (pos === -1) {
        const { value, done } = await reader.read();
        if (done) break;
        buff = this.concatUint8Arrays(buff, value);
        continue;
      }
      // 解析块大小（十六进制格式）
      const sizeStr = this.decoder.decode(buff.slice(0, pos));
      const size = parseInt(sizeStr, 16);
      this.log("Read chunk size", size);
      // 大小为0表示块结束
      if (!size) break;
      // 从缓冲区中移除已解析的大小部分和后续的CRLF
      buff = buff.slice(pos + 2);
      // 确保缓冲区包含完整的块（包括尾部的CRLF）
      while (buff.length < size + 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected EOF in chunked encoding");
        buff = this.concatUint8Arrays(buff, value);
      }
      // 产出块数据（不包括尾部的CRLF）
      yield buff.slice(0, size);
      buff = buff.slice(size + 2);
    }
  }
}