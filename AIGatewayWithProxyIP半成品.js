import { connect } from "cloudflare:sockets";
/**
 * AI Gateway with Proxy IP Fallback 
 * 功能：随机UA，随机Accept-Language，dns解析，主连接使用socket直连，fallback使用cf反代ip（采取SNI PROXY的方式）
 * SNI PROXY：以原始域名作为SNI 进行TLS握手，但将IP地址改为ProxyIP
 * 轮询proxyIP的方案：使用dns解析域名的A记录，随机选取一个IP作为ProxyIP
 * 暂时无法使用，遇到了暂时无法解决的问题（分离 TCP 连接和 TLS 握手失败，未找到长期稳定可以获取，更新ProxyIP的方法）
 */
// 全局配置
const DEFAULT_CONFIG = {
  AUTH_TOKEN: "defaulttoken",
  DEFAULT_DST_URL: "https://httpbin.org/get",
  DEBUG_MODE: true,
  ENABLE_UA_RANDOMIZATION: true,
  ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION: false, // 随机 Accept-Language
  PROXY_DOMAINS: [""], // CF反代IP域名列表
};

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
      } else if (key === 'PROXY_DOMAINS' && typeof env[key] === 'string') {
        CONFIG[key] = env[key].split(',').map(d => d.trim()).filter(Boolean);
      } else {
        CONFIG[key] = env[key];
      }
    }
  }
}

// 文本编码器/解码器
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 忽略的请求头正则
const HEADER_FILTER_RE = /^(host|cf-|cdn-|referer|referrer)/i;

// 日志函数
let log = () => {};

// 管理器实例
let userAgentManager;

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


// 创建新连接的辅助函数
async function createNewConnection(hostname, port, isSecure) {
  log(`创建新连接 ${hostname}:${port}`);

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
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i+1] === 10) {
        pos = i;
        break;
      }
    }
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break;
      buff = concatUint8Arrays(buff, value);
      continue;
    }
    
    const size = parseInt(decoder.decode(buff.slice(0, pos)), 16);
    log("读取分块大小", size);
    if (!size) break;
    
    buff = buff.slice(pos + 2);
    while (buff.length < size + 2) {
      const { value, done } = await reader.read();
      if (done) throw new Error("分块编码中意外结束");
      buff = concatUint8Arrays(buff, value);
    }
    
    yield buff.slice(0, size);
    buff = buff.slice(size + 2);
  }
}

// 解析响应
async function parseResponse(reader, targetHost, targetPort, socket) {
  let buff = new Uint8Array();
  
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buff = concatUint8Arrays(buff, value);
      if (done && !buff.length) break;
      
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        const isChunked = headers.get("transfer-encoding")?.includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        const data = buff.slice(headerEnd + 4);
        
        // 所有响应均通过流式处理
        // 将socket的readable管道化
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                // 如果缓冲区有数据，先推入
                if (data.length) {
                  ctrl.enqueue(data);
                }
                // 持续从socket读取并推送到流中，直到socket关闭
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) {
                    break;
                  }
                  ctrl.enqueue(value);
                }
                ctrl.close();
              } catch (err) {
                log("流式响应错误", err);
                ctrl.error(err);
              } finally {
                if (!socket.closed) {
                  socket.close();
                }
              }
            },
            cancel() {
              if (!socket.closed) {
                socket.close();
              }
            },
          }),
          { status, statusText, headers }
        );
      }
    }
  } catch (error) {
    if (!socket.closed) socket.close();
    throw error;
  }
  
  throw new Error("无法解析响应头");
}


/**
 * 为给定的域名构建一个DNS查询消息。
 * @param {string} domain 要查询的域名。
 * @returns {Uint8Array} DNS查询消息。
 */
function buildDnsQuery(domain) {
  const header = new Uint8Array([
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), // 事务ID
    0x01, 0x00, 
    0x00, 0x01, 
    0x00, 0x00, 
    0x00, 0x00, 
    0x00, 0x00, 
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
 * 辅助函数，通过socket发送HTTP请求
 * @param {string} hostname - 目标主机名或IP
 * @param {number} port - 目标端口
 * @param {boolean} isSecure - 是否使用TLS
 * @param {Request} req - 原始请求对象
 * @param {Headers} headers - 清理和修改后的请求头
 * @param {URL} targetUrl - 目标URL对象
 * @returns {Promise<Response>}
 */
async function sendRequestViaSocket(hostname, port, isSecure, req, headers, targetUrl) {
  const socket = await createNewConnection(hostname, port, isSecure);
  try {
    const writer = socket.writable.getWriter();
    const requestLine = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
    
    log(`通过 socket 发送请求到 ${hostname}:${port}`);
    await writer.write(encoder.encode(requestLine));
    
    if (req.body) {
      for await (const chunk of req.body) {
        await writer.write(chunk);
      }
    }
    writer.releaseLock();
    return await parseResponse(socket.readable.getReader(), hostname, port, socket);
  } catch (error) {
    if (!socket.closed) {
      socket.close();
    }
    // 重新抛出错误，让调用者处理
    throw error;
  }
}

/**
 * 原生HTTP请求
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
  const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
  const isSecure = targetUrl.protocol === "https:";

  // 设置主机头
  cleanedHeaders.set("Host", targetUrl.hostname);
  cleanedHeaders.set("Connection", "close");

  // 克隆请求
  const reqForFallback = req.clone();

  try {
    // 尝试直接连接
    log(`尝试直接连接到 ${targetUrl.hostname}:${port}`);
    return await sendRequestViaSocket(targetUrl.hostname, port, isSecure, req, cleanedHeaders, targetUrl);
  } catch (error) {
    log('直接 socket 连接失败，尝试 Fallback:', error.message);
    
    //Fallback 逻辑
    if (CONFIG.PROXY_DOMAINS && CONFIG.PROXY_DOMAINS.length > 0) {
      const randomDomain = CONFIG.PROXY_DOMAINS[Math.floor(Math.random() * CONFIG.PROXY_DOMAINS.length)];
      const proxyIP = await resolveDomainRandomIP(randomDomain);

      if (proxyIP) {
        log(`使用代理IP ${proxyIP} (来自 ${randomDomain}) 进行 Fallback 连接`);
        try {
          // 使用克隆的请求进行 fallback
          return await sendRequestViaSocket(proxyIP, port, isSecure, reqForFallback, cleanedHeaders, targetUrl);
        } catch (proxyError) {
          log('ProxyIP连接失败:', proxyError.message);
          // 抛出原始错误以保持一致性
          throw error;
        }
      } else {
        log(`无法为 ${randomDomain} 解析IP，Fallback 失败`);
      }
    }
    
    // 如果没有 fallback 选项或 fallback 失败，重新抛出原始错误
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
      return await nativeFetch(req, dstUrl);
    }
    if (authToken === "defaulttoken") {
      const msg = "请修改默认AUTH_TOKEN，建议随机字符串10位以上";
      log(msg);
      return new Response(msg, { status: 401 });
    }

    const authToken = pathSegments[0];
    const hasTargetUrl = pathSegments.length >= 2;

    // 如果鉴权令牌不匹配或缺少目标URL
    if (authToken !== CONFIG.AUTH_TOKEN || !hasTargetUrl) {
      const msg = "Invalid path. Expected `/{authtoken}/{target_url}`. please check authentictoken or targeturl";
      log(msg, { authToken, hasTargetUrl });
      return new Response(msg, { status: 400 });
    }

    // 提取目标URL
    const authtokenPrefix = `/${authToken}/`;
    let targetUrl = url.pathname.substring(url.pathname.indexOf(authtokenPrefix) + authtokenPrefix.length);
    targetUrl = decodeURIComponent(targetUrl);

    // 验证URL协议 (http/https)
    if (!/^https?:\/\//i.test(targetUrl)) {
      const msg = "Invalid target URL. Protocol (http/https) is required.";
      log(msg, { targetUrl });
      return new Response(msg, { status: 400 });
    }

    const dstUrl = targetUrl + url.search;
    log("目标URL", dstUrl);
    return await nativeFetch(req, dstUrl);

  } catch (error) {
    log("请求处理失败", error);
    return new Response("Bad Gateway", { status: 502 });
  }
}

// 导出Worker handlers
export default { fetch: handleRequest };
export const onRequest = (ctx) => handleRequest(ctx.request, ctx.env);
