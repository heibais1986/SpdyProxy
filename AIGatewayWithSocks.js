
import { connect } from "cloudflare:sockets";

// 全局配置
const DEFAULT_CONFIG = {
  AUTH_TOKEN: "defaulttoken", // 默认鉴权令牌,必须更改
  DEFAULT_DST_URL: "https://httpbin.org/get",
  DEBUG_MODE: true,
  ENABLE_UA_RANDOMIZATION: true,
  ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION: false, // 随机 Accept-Language
  ENABLE_SOCKS5_FALLBACK: true, // 启用 Socks5 fallback
};

// Socks5 API
const SOCKS5_API_URLS = [
  "https://api1.example.com/socks5",
  "https://api2.example.com/socks5", 
  "https://api3.example.com/socks5"
];

// 主机请求方式配置集合 (key: host, value: 'nativeFetch' | 'socks5')
const HOST_REQUEST_CONFIG = new Map([
  // 模板示例 - 替换为实际的host配置
  ["api.openai.com", "socks5"],
  ["generativelanguage.googleapis.com", "nativeFetch"],
  ["api.anthropic.com", "socks5"],
  ["api.cohere.ai", "nativeFetch"],
  ["httpbin.org", "nativeFetch"],
  // 添加更多主机配置...
]);

// URL预设映射 (简化路径映射到完整URL)
const URL_PRESETS = new Map([
  // 模板示例 - 替换worker地址为实际地址
  ["gemini", "https://generativelanguage.googleapis.com/v1beta"],
  ["openai", "https://api.openai.com/v1"],
  ["anthropic", "https://api.anthropic.com/v1"],
  ["cohere", "https://api.cohere.ai/v1"],
  ["httpbin", "https://httpbin.org"],
  // 添加更多预设映射...
]);

// 使用默认配置创建可更新的副本
let CONFIG = { ...DEFAULT_CONFIG };

// 从环境变量更新配置
function updateConfigFromEnv(env) {
  if (!env) return;
  for (const key of Object.keys(CONFIG)) {
    if (key in env) {
      if (typeof CONFIG[key] === 'boolean') {
        CONFIG[key] = env[key] === 'true';
      } else if (typeof CONFIG[key] === 'number') {
        CONFIG[key] = Number(env[key]);
      } else {
        CONFIG[key] = env[key];
      }
    }
  }
}

// 文本编码器/解码器
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 忽略的请求头正则 - 移除 referer 和 referrer 过滤
const HEADER_FILTER_RE = /^(host|cf-|cdn-|referer|referrer)/i;

// 日志函数
let log = () => {};

// 管理器实例
let userAgentManager;

/**
 * 根据主机名获取请求方式
 * @param {string} hostname 主机名
 * @returns {string} 'nativeFetch' | 'socks5'
 */
function getRequestMethodForHost(hostname) {
  // 如果配置中有该主机，返回配置的方式
  if (HOST_REQUEST_CONFIG.has(hostname)) {
    return HOST_REQUEST_CONFIG.get(hostname);
  }
  // 默认使用 nativeFetch
  return 'nativeFetch';
}

/**
 * 解析预设URL或完整URL
 * @param {string} urlOrPreset URL预设名称或完整URL
 * @returns {string} 完整的URL
 */
function resolveUrl(urlOrPreset) {
  // 如果是预设名称，返回映射的URL
  if (URL_PRESETS.has(urlOrPreset)) {
    return URL_PRESETS.get(urlOrPreset);
  }
  // 否则返回原始输入（应该是完整URL）
  return urlOrPreset;
}

/**
 * User-Agent 管理器，存储一些常用的UA供随机化使用
 */
class UserAgentManager {
  constructor() {
    this.userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'Mozilla/5.0 (Linux; Android 13; SM-S908U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    ];
    this.currentIndex = Math.floor(Math.random() * this.userAgents.length);
    
    // Accept-Language 值列表
    this.acceptLanguages = [
      'zh-CN,zh;q=0.9,en;q=0.8',
      'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'zh-CN,zh;q=0.9',
      'en-US,en;q=0.9',
      'en-US,en;q=0.9,es;q=0.8',
      'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'en-GB,en;q=0.9',
      'en-GB,en-US;q=0.9,en;q=0.8',
      'en-GB,en;q=0.9,fr;q=0.8',
      'en-SG,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'zh-CN,zh;q=0.9,en-SG;q=0.8,en;q=0.7',
      'en-SG,en;q=0.9,ms;q=0.8'
    ];
  }

  // 随机UA
  getRandomUserAgent() {
    if (!CONFIG.ENABLE_UA_RANDOMIZATION) return null;
    this.currentIndex = (this.currentIndex + 1 + Math.floor(Math.random() * 2)) % this.userAgents.length;
    return this.userAgents[this.currentIndex];
  }
  
  // 兼容UA方法
  getCompatibleUserAgent(originalUA) {
    if (!CONFIG.ENABLE_UA_RANDOMIZATION || !originalUA) return null;
    const isWindows = /Windows/.test(originalUA);
    const isMac = /Macintosh/.test(originalUA);
    const isLinux = /Linux/.test(originalUA);
    const isAndroid = /Android/.test(originalUA);
    const isiPhone = /iPhone/.test(originalUA);
    const compatibleAgents = this.userAgents.filter(ua => {
      if (isWindows) return /Windows/.test(ua);
      if (isMac) return /Macintosh/.test(ua);
      if (isAndroid) return /Android/.test(ua);
      if (isiPhone) return /iPhone/.test(ua);
      if (isLinux) return /Linux/.test(ua);
      return true;
    });
    return compatibleAgents[Math.floor(Math.random() * compatibleAgents.length)];
  }
  
  // 随机Accept-Language
  getRandomAcceptLanguage() {
    if (!CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) return null;
    return this.acceptLanguages[Math.floor(Math.random() * this.acceptLanguages.length)];
  }
}

/**
 * 解析 Socks5 代理
 * 支持格式：
 * - socks5://user:password@host:port
 * - socks5://@host:port
 * - user:password@host:port  
 * - host:port
 * @returns {Promise<Object>} 解析后的 Socks5 配置
 */
async function parseSocks5Proxy() {
  try {
    // 随机选择一个 API
    const randomApiUrl = SOCKS5_API_URLS[Math.floor(Math.random() * SOCKS5_API_URLS.length)];
    log('尝试从 API 获取 Socks5 代理:', randomApiUrl);
    
    // 获取 Socks5 代理信息
    const response = await fetch(randomApiUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`获取 Socks5 代理失败: ${response.status}`);
    }
    
    const proxyData = await response.text();
    if (!proxyData || proxyData.trim() === '') {
      throw new Error('未获取到 Socks5 代理数据');
    }
    
    // 处理多个代理的情况
    const proxyList = proxyData.trim().split('\n').filter(line => line.trim());
    if (proxyList.length === 0) {
      throw new Error('代理列表为空');
    }
    
    log(`获取到 ${proxyList.length} 个代理，随机选择一个`);
    
    // 随机选择一个代理
    const selectedProxy = proxyList[Math.floor(Math.random() * proxyList.length)];
    log('选择的代理:', selectedProxy);
    
    // 解析代理格式
    let proxyStr = selectedProxy.trim();
    let username = null;
    let password = null;
    let host = null;
    let port = null;
    
    // 移除 socks5:// 前缀
    if (proxyStr.startsWith('socks5://')) {
      proxyStr = proxyStr.substring(9);
    }
    
    // 检查是否包含认证信息
    if (proxyStr.includes('@')) {
      const parts = proxyStr.split('@');
      if (parts.length !== 2) {
        throw new Error(`代理格式错误: ${selectedProxy}`);
      }
      
      const [authPart, addressPart] = parts;
      
      // 解析认证部分 (可能为空，如 socks5://@host:port)
      if (authPart.trim() !== '') {
        const authSplit = authPart.split(':');
        if (authSplit.length === 2) {
          username = authSplit[0];
          password = authSplit[1];
        }
      }
      
      // 解析地址部分
      const addressSplit = addressPart.split(':');
      if (addressSplit.length !== 2) {
        throw new Error(`代理地址格式错误: ${addressPart}`);
      }
      host = addressSplit[0];
      port = parseInt(addressSplit[1]);
      
    } else {
      // 没有认证信息，直接是 host:port 格式
      const addressSplit = proxyStr.split(':');
      if (addressSplit.length !== 2) {
        throw new Error(`代理格式错误: ${selectedProxy}`);
      }
      host = addressSplit[0];
      port = parseInt(addressSplit[1]);
    }
    
    if (!host || !port || isNaN(port)) {
      throw new Error(`代理格式不完整: ${selectedProxy}`);
    }
    
    const proxyConfig = {
      host,
      port,
      username,
      password,
      hasAuth: !!(username && password)
    };
    
    log('解析的代理配置:', `${host}:${port} (认证: ${proxyConfig.hasAuth})`);
    return proxyConfig;
    
  } catch (error) {
    log('解析 Socks5 代理失败:', error.message);
    throw new Error(`解析 Socks5 代理失败: ${error.message}`);
  }
}

/**
 * 执行 Socks5 握手协议
 */
async function performSocks5Handshake(reader, writer, targetHost, targetPort, username, password) {
  try {
    log(`开始 Socks5 握手: 目标 ${targetHost}:${targetPort}`);
    
    // 认证方法协商
    const hasAuth = username && password;
    const authMethods = hasAuth ? 
      new Uint8Array([0x05, 0x01, 0x02]) :  // SOCKS5, 1个方法, 用户名密码认证
      new Uint8Array([0x05, 0x01, 0x00]);   // SOCKS5, 1个方法, 无认证
        
    await writer.write(authMethods);
    log('发送认证方法协商');
    
    const authResult = await reader.read();
    if (authResult.done || authResult.value.length < 2) {
      throw new Error('Socks5 认证方法协商响应格式错误');
    }
    const authResponse = authResult.value.slice(0, 2);
    
    if (authResponse[0] !== 0x05) {
      throw new Error('Socks5 版本不匹配');
    }
    
    const selectedMethod = authResponse[1];
    log('服务器选择的认证方法:', selectedMethod);
    
    if (hasAuth && selectedMethod !== 0x02) {
      throw new Error('Socks5 服务器不支持用户名密码认证');
    } else if (!hasAuth && selectedMethod !== 0x00) {
      throw new Error('Socks5 服务器需要认证但未提供认证信息');
    }
    
    // 用户名密码认证
    if (hasAuth && selectedMethod === 0x02) {
      log('执行用户名密码认证');
      const usernameBytes = encoder.encode(username);
      const passwordBytes = encoder.encode(password);
      const authData = new Uint8Array(3 + usernameBytes.length + passwordBytes.length);
      authData[0] = 0x01; // 用户名密码认证版本
      authData[1] = usernameBytes.length;
      authData.set(usernameBytes, 2);
      authData[2 + usernameBytes.length] = passwordBytes.length;
      authData.set(passwordBytes, 3 + usernameBytes.length);
      
      await writer.write(authData);
      
      const authResult2 = await reader.read();
      if (authResult2.done || authResult2.value.length < 2) {
        throw new Error('Socks5 认证响应格式错误');
      }
      
      if (authResult2.value[1] !== 0x00) {
        throw new Error('Socks5 用户名密码认证失败');
      }
      log('认证成功');
    }
    
    // 连接请求
    log('发送连接请求');
    const hostBytes = encoder.encode(targetHost);
    const connectRequest = new Uint8Array(7 + hostBytes.length);
    connectRequest[0] = 0x05; // SOCKS5
    connectRequest[1] = 0x01; // CONNECT
    connectRequest[2] = 0x00; // 保留
    connectRequest[3] = 0x03; // 域名类型
    connectRequest[4] = hostBytes.length;
    connectRequest.set(hostBytes, 5);
    connectRequest[5 + hostBytes.length] = (targetPort >> 8) & 0xFF;
    connectRequest[6 + hostBytes.length] = targetPort & 0xFF;
    
    await writer.write(connectRequest);
    
    const connectResult = await reader.read();
    if (connectResult.done || connectResult.value.length < 10) {
      throw new Error('Socks5 连接响应格式错误');
    }
    
    const connectResponse = connectResult.value.slice(0, 10);
    if (connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) {
      const errorMessages = {
        0x01: '服务器故障',
        0x02: '连接不被允许',
        0x03: '网络不可达',
        0x04: '主机不可达',
        0x05: '连接被拒绝',
        0x06: 'TTL超时',
        0x07: '不支持的命令',
        0x08: '不支持的地址类型'
      };
      const errorMsg = errorMessages[connectResponse[1]] || `未知错误码: ${connectResponse[1]}`;
      throw new Error(`Socks5 连接请求失败: ${errorMsg}`);
    }
    
    log('Socks5 握手完成');
  } catch (error) {
    log('Socks5 握手失败:', error.message);
    throw error;
  }
}

/**
 * 使用 Socks5 进行访问
 * @param {Request} req 请求对象
 * @param {string} dsturl 目标URL
 * @returns {Promise<Response>} 响应对象
 */
async function fetchViaSocks5(req, dsturl) {
  const targetUrl = new URL(dsturl);
  
  try {
    log('尝试通过 Socks5 代理访问:', dsturl);
    
    // 获取 Socks5 代理配置
    const proxyConfig = await parseSocks5Proxy();
    
    // 处理请求头，去除指定的请求头
    const cleanedHeaders = new Headers();
    for (const [key, value] of req.headers.entries()) {
      if (!HEADER_FILTER_RE.test(key)) {
        cleanedHeaders.set(key, value);
      }
    }
    
    // 根据选项添加随机 UA 和语言
    const randomUA = userAgentManager.getRandomUserAgent();
    if (randomUA) {
      cleanedHeaders.set("User-Agent", randomUA);
      log('使用随机 User-Agent:', randomUA);
    }
    
    if (CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) {
      const randomLang = userAgentManager.getRandomAcceptLanguage();
      if (randomLang) {
        cleanedHeaders.set("Accept-Language", randomLang);
        log('使用随机 Accept-Language:', randomLang);
      }
    }
    
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("Connection", "close");
    
    const targetPort = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
    
    // 连接到 Socks5 代理服务器
    log(`连接到 Socks5 代理: ${proxyConfig.host}:${proxyConfig.port}`);
    const proxySocket = await createNewConnection(proxyConfig.host, proxyConfig.port, false);
    
    try {
      const reader = proxySocket.readable.getReader();
      const writer = proxySocket.writable.getWriter();
      
      // 执行 Socks5 握手
      await performSocks5Handshake(reader, writer, targetUrl.hostname, targetPort, 
                                   proxyConfig.username, proxyConfig.password);
      
      // 发送 HTTP 请求
      const requestLine = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries()).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
      
      log("通过 Socks5 发送请求:", requestLine.split('\r\n')[0]);
      await writer.write(encoder.encode(requestLine));
      
      if (req.body) {
        for await (const chunk of req.body) {
          await writer.write(chunk);
        }
      }
      
      writer.releaseLock();
      return await parseResponse(reader, targetUrl.hostname, targetPort, proxySocket);
      
    } catch (error) {
      if (!proxySocket.closed) proxySocket.close();
      throw error;
    }
    
  } catch (error) {
    log('Socks5 代理请求失败:', error.message);
    throw error;
  }
}

// 创建新连接的辅助函数
async function createNewConnection(hostname, port, isSecure) {
  log(`创建新连接 ${hostname}:${port} (安全: ${isSecure})`);

  return await connect(
    { hostname, port: Number(port) },
    {
      secureTransport: isSecure ? "on" : "off",
      allowHalfOpen: true
    }
  );
}

// 初始化管理器
function initializeManagers() {
  if (!userAgentManager) userAgentManager = new UserAgentManager();
}

// 连接Uint8Array
function concatUint8Arrays(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// 解析HTTP头部
function parseHttpHeaders(buff) {
  try {
    const text = decoder.decode(buff);
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`无效状态行: ${statusLine}`);
    
    const headers = new Headers();
    for (let i = 1; i < headerSection.length; i++) {
      const line = headerSection[i];
      const idx = line.indexOf(": ");
      if (idx !== -1) headers.append(line.slice(0, idx), line.slice(idx + 2));
    }
    
    return { 
      status: Number(statusMatch[1]),
      statusText: statusMatch[2],
      headers,
      headerEnd
    };
  } catch (error) {
    log('解析HTTP头部错误:', error);
    throw error;
  }
}

// 读取直到双CRLF
async function readUntilDoubleCRLF(reader) {
  let respText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    respText += decoder.decode(value, { stream: true });
    if (respText.includes("\r\n\r\n")) break;
  }
  return respText;
}

// 读取分块数据
async function* readChunks(reader, buff = new Uint8Array()) {
  while (true) {
    let pos = -1;
    // 寻找分块大小行结束的 CRLF
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i+1] === 10) { // CR LF
        pos = i;
        break;
      }
    }
    
    // 如果找不到，说明分块大小行不完整，需要从socket读取更多数据
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break; // 流结束
      buff = concatUint8Arrays(buff, value);
      continue;
    }
    
    const sizeHex = decoder.decode(buff.slice(0, pos));
    const size = parseInt(sizeHex, 16);
    
    // 如果大小为0，表示是最后一个分块，流结束
    if (isNaN(size) || size === 0) {
      log("读取到最后一个分块 (size=0)，流结束");
      break;
    }
    
    // 移除大小行和CRLF
    buff = buff.slice(pos + 2);
    
    // 循环读取直到获得完整的一个数据块
    while (buff.length < size + 2) { // +2 是为了数据块末尾的CRLF
      const { value, done } = await reader.read();
      if (done) throw new Error("分块编码中意外结束");
      buff = concatUint8Arrays(buff, value);
    }
    
    // 提取纯数据块 (payload)
    const chunkData = buff.slice(0, size);
    yield chunkData;
    
    // 移除已处理的数据块和它末尾的CRLF
    buff = buff.slice(size + 2);
  }
}

// 解析响应
async function parseResponse(reader, targetHost, targetPort, socket) {
  let buff = new Uint8Array();
  
  try {
    // 循环读取，直到解析出完整的HTTP头部
    while (true) {
      const { value, done } = await reader.read();
      if (value) buff = concatUint8Arrays(buff, value);
      
      // 如果流结束但缓冲区为空，则退出
      if (done && !buff.length) {
         throw new Error("无法解析响应：流提前结束且无数据");
      }
      
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        
        // 关键逻辑：检查是分块编码还是定长编码
        const isChunked = headers.get("transfer-encoding")?.toLowerCase().includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        
        // 提取HTTP头部之后的数据，这部分是响应体的开始
        const initialBodyData = buff.slice(headerEnd + 4);
        
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                if (isChunked) {
                  // 如果是分块编码，使用 readChunks 生成器进行解析
                  log("响应模式：分块编码 (Chunked)");
                  for await (const chunk of readChunks(reader, initialBodyData)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
                  // 如果是定长编码，按长度读取
                  log(`响应模式：定长 (Content-Length: ${contentLength})`);
                  let receivedLength = initialBodyData.length;
                  if (initialBodyData.length > 0) {
                    ctrl.enqueue(initialBodyData);
                  }
                  
                  // 循环读取直到满足 Content-Length
                  while (receivedLength < contentLength) {
                    const { value, done } = await reader.read();
                    if (done) {
                        log("警告：流在达到Content-Length之前结束");
                        break;
                    }
                    receivedLength += value.length;
                    ctrl.enqueue(value);
                  }
                }
                
                // 所有数据处理完毕
                ctrl.close();
              } catch (err) {
                log("流式响应处理错误", err);
                ctrl.error(err);
              } finally {
                // 确保socket被关闭
                if (socket && !socket.closed) {
                  socket.close();
                }
              }
            },
            cancel() {
              log("流被客户端取消");
              if (socket && !socket.closed) {
                socket.close();
              }
            },
          }),
          { status, statusText, headers }
        );
      }
      // 如果流结束了还没解析出头部，抛出错误
      if (done) {
        throw new Error("无法解析响应头：流已结束");
      }
    }
  } catch (error) {
    log("解析响应时发生错误", error);
    if (socket && !socket.closed) {
      socket.close();
    }
    // 重新抛出错误，让上层捕获
    throw error;
  }
}

/**
 * 为给定的域名构建一个DNS查询消息。
 * @param {string} domain 要查询的域名。
 * @returns {Uint8Array} DNS查询消息。
 */
function buildDnsQuery(domain) {
  const header = new Uint8Array([
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), // 事务ID
    0x01, 0x00, // 标志: 标准查询
    0x00, 0x01, // 问题数: 1
    0x00, 0x00, // 回答数: 0
    0x00, 0x00, // 权威记录数: 0
    0x00, 0x00, // 附加记录数: 0
  ]);

  const labels = domain.split('.');
  const question = new Uint8Array(domain.length + 2 + 4);
  let offset = 0;
  for (const label of labels) {
    question[offset++] = label.length;
    for (let i = 0; i < label.length; i++) {
      question[offset++] = label.charCodeAt(i);
    }
  }
  question[offset++] = 0; // 域名结束

  // 查询类型 (A) 和类 (IN)
  question[offset++] = 0x00;
  question[offset++] = 0x01; // 类型 A
  question[offset++] = 0x00;
  question[offset++] = 0x01; // 类 IN

  return concatUint8Arrays(header, question.slice(0, offset));
}

/**
 * 从二进制DNS响应中解析IP地址。
 * @param {Uint8Array} buffer 包含DNS响应的缓冲区。
 * @returns {string[]} 从A记录中提取的IP地址数组。
 */
function parseDnsResponse(buffer) {
  const dataView = new DataView(buffer.buffer);
  const answerCount = dataView.getUint16(6);
  let offset = 12; // 跳过头部
  
  // 跳过问题部分
  while (buffer[offset] !== 0) {
    if (offset > buffer.length) return []; // 防止死循环
    offset += buffer[offset] + 1;
  }
  offset += 5; // 跳过问题末尾的0字节和类型/类

  const addresses = [];
  for (let i = 0; i < answerCount; i++) {
    if (offset + 12 > buffer.length) break;

    // 跳过名称（通常是指针，占2字节）
    offset += 2;
        const type = dataView.getUint16(offset);
    offset += 2; // 跳过类型
    offset += 6; // 跳过类和TTL
    const rdLength = dataView.getUint16(offset);
    offset += 2; // 跳过rdLength

    if (type === 1 && rdLength === 4) { // A记录
      addresses.push(`${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`);
    }
    offset += rdLength;
  }
  
  return addresses;
}

/**
 * 查询域名的A记录，并从结果中随机返回一个IP。
 * @param {string} domain 要查询的域名。
 * @returns {Promise<string|null>} 一个随机的IP地址，如果找不到则返回null。
 */
async function resolveDomainRandomIP(domain) {
  log(`为域执行二进制DNS查询: ${domain}`);
  const query = buildDnsQuery(domain);
  try {
    const response = await fetch('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: query,
    });
    if (!response.ok) {
      throw new Error(`DNS查询失败，状态为 ${response.status}`);
    }
    const addresses = parseDnsResponse(new Uint8Array(await response.arrayBuffer()));
    if (addresses.length === 0) {
      log(`未找到域 ${domain} 的A记录`);
      return null;
    }
    const randomIP = addresses[Math.floor(Math.random() * addresses.length)];
    log(`为 ${domain} 解析到随机IP: ${randomIP}`);
    return randomIP;
  } catch (error) {
    log('二进制DNS解析错误:', error);
    throw error;
  }
}

/**
 * HTTP请求 (支持路由判断)
 * @param {Request} req 请求对象
 * @param {string} dstUrl 目标URL
 * @returns {Promise<Response>} 响应对象
 */
async function nativeFetch(req, dstUrl) {
  // 清理请求头和应用随机化
  const cleanedHeaders = new Headers();
  for (const [k, v] of req.headers) {
    if (!HEADER_FILTER_RE.test(k)) cleanedHeaders.set(k, v);
  }

  const randomUA = userAgentManager.getCompatibleUserAgent(req.headers.get('user-agent'));
  if (randomUA) {
    cleanedHeaders.set('User-Agent', randomUA);
    log('使用User-Agent:', randomUA);
  }

  if (CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) {
    const randomLang = userAgentManager.getRandomAcceptLanguage();
    if (randomLang) {
      cleanedHeaders.set('Accept-Language', randomLang);
      log('使用Accept-Language:', randomLang);
    }
  }

  const targetUrl = new URL(dstUrl);

  // HTTP（S）连接
  try {
    // socket请求逻辑
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("Connection", "close");
    const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
    const socket = await createNewConnection(targetUrl.hostname, port, targetUrl.protocol === "https:");
    
    try {
      const writer = socket.writable.getWriter();
      const requestLine = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries()).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
      log("发送直连请求", requestLine.split('\r\n')[0]);
      await writer.write(encoder.encode(requestLine));
      
      if (req.body) {
        for await (const chunk of req.body) {
          await writer.write(chunk);
        }
      }
      
      writer.releaseLock();
      return await parseResponse(socket.readable.getReader(), targetUrl.hostname, port, socket);
      
    } catch (error) {
      if (!socket.closed) socket.close();
      throw error;
    }
    
  } catch (error) {
    log('直连失败，尝试 Socks5 Fallback:', error.message);
    
    // 检查是否启用 Socks5 fallback
    if (CONFIG.ENABLE_SOCKS5_FALLBACK) {
      try {
        // 使用 Socks5 作为 fallback
        return await fetchViaSocks5(req, dstUrl);
      } catch (socks5Error) {
        log('Socks5 Fallback 也失败了:', socks5Error.message);
        throw socks5Error;
      }
    } else {
      // 如果没有启用 Socks5 fallback，直接抛出原始错误
      throw error;
    }
  }
}

/**
 * 智能路由请求处理函数
 * @param {Request} req 请求对象
 * @param {string} dstUrl 目标URL
 * @returns {Promise<Response>} 响应对象
 */
async function smartFetch(req, dstUrl) {
  const targetUrl = new URL(dstUrl);
  const hostname = targetUrl.hostname;
  
  // 获取该主机名的请求方式配置
  const requestMethod = getRequestMethodForHost(hostname);
  log(`主机 ${hostname} 使用请求方式: ${requestMethod}`);
  
  try {
    if (requestMethod === 'socks5') {
      // 直接使用 Socks5
      return await fetchViaSocks5(req, dstUrl);
    } else {
      // 使用 nativeFetch (包含 fallback 逻辑)
      return await nativeFetch(req, dstUrl);
    }
  } catch (error) {
    log(`智能路由请求失败 (${requestMethod}):`, error.message);
    throw error;
  }
}

/**
 * 请求处理入口
 */
async function handleRequest(req, env) {
  // 克隆并更新配置（避免污染全局状态）
  CONFIG = { ...DEFAULT_CONFIG, ...env };
  updateConfigFromEnv(env);
  
  // 初始化管理器
  initializeManagers();
  
  // 设置日志
  log = CONFIG.DEBUG_MODE
    ? (message, data = "") => console.log(`[${new Date().toISOString()}] ${message}`, data)
    : () => {};
  
  const url = new URL(req.url);
  
  // 路由处理
  try {
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // 如果路径为空, 则请求默认目标地址
    if (pathSegments.length === 0) {
      log("无路径请求，转发至默认URL", CONFIG.DEFAULT_DST_URL);
      const dstUrl = CONFIG.DEFAULT_DST_URL + url.search;
      return await smartFetch(req, dstUrl);
    }

    const authToken = pathSegments[0];
    // 检查是否使用了默认的AUTH_TOKEN
    if (authToken === "defaulttoken") {
      const msg = "请修改默认AUTH_TOKEN，建议随机字符串10位以上";
      log(msg);
      return new Response(msg, { status: 401 });
    }
    
    const hasTargetUrl = pathSegments.length >= 2;

    // 如果鉴权令牌不匹配或缺少目标URL
    if (authToken !== CONFIG.AUTH_TOKEN || !hasTargetUrl) {
      const msg = "Invalid path. Expected `/{authtoken}/{target_url}` or `/{authtoken}/{preset_name}`. please check authentictoken or targeturl";
      log(msg, { authToken, hasTargetUrl });
      return new Response(msg, { status: 400 });
    }

    // 提取目标URL或预设名称
    const authtokenPrefix = `/${authToken}/`;
    let targetUrlOrPreset = url.pathname.substring(url.pathname.indexOf(authtokenPrefix) + authtokenPrefix.length);
    targetUrlOrPreset = decodeURIComponent(targetUrlOrPreset);

    // 解析URL预设或直接使用完整URL
    let resolvedUrl = resolveUrl(targetUrlOrPreset);
    
    // 如果是预设名称，需要添加后续路径
    if (URL_PRESETS.has(targetUrlOrPreset)) {
      // 获取预设后的剩余路径
      const presetPath = `/${authToken}/${targetUrlOrPreset}`;
      const remainingPath = url.pathname.substring(presetPath.length);
      if (remainingPath) {
        resolvedUrl += remainingPath;
      }
      log(`使用URL预设: ${targetUrlOrPreset} -> ${resolvedUrl}`);
    } else {
      // 验证URL协议 (http/https)
      if (!/^https?:\/\//i.test(resolvedUrl)) {
        const msg = "Invalid target URL. Protocol (http/https) is required.";
        log(msg, { targetUrl: resolvedUrl });
        return new Response(msg, { status: 400 });
      }
    }

    const dstUrl = resolvedUrl + url.search;
    log("目标URL", dstUrl);
    return await smartFetch(req, dstUrl);

  } catch (error) {
    log("请求处理失败", error);
    return new Response("Bad Gateway", { status: 502 });
  }
}

// 导出Worker handlers
export default { fetch: handleRequest };
export const onRequest = (ctx) => handleRequest(ctx.request, ctx.env);
