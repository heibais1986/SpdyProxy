import { connect } from "cloudflare:sockets";

// Genel Yapılandırma
const DEFAULT_CONFIG = {
  AUTH_TOKEN: "defaulttoken", // Varsayılan kimlik doğrulama belirteci, değiştirilmelidir
  DEFAULT_DST_URL: "https://httpbin.org/get",
  DEBUG_MODE: true,
  ENABLE_UA_RANDOMIZATION: true,
  ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION: false, // Rastgele Accept-Language
  ENABLE_SOCKS5_FALLBACK: true, // Socks5 geri dönüşünü etkinleştir
};

// Socks5 API'si
const SOCKS5_API_URLS = [
  "https://api1.example.com/socks5",
  "https://api2.example.com/socks5", 
  "https://api3.example.com/socks5"
];

// Ana bilgisayar istek yöntemi yapılandırma koleksiyonu (anahtar: ana bilgisayar, değer: 'nativeFetch' | 'socks5')
const HOST_REQUEST_CONFIG = new Map([
  ["api.openai.com", "socks5"],
  ["generativelanguage.googleapis.com", "nativeFetch"],
  ["api.anthropic.com", "socks5"],
  ["api.cohere.ai", "nativeFetch"],
  ["httpbin.org", "nativeFetch"],
]);

// URL Ön Ayar eşlemesi (yol eşlemesini tam URL'ye basitleştirin)
const URL_PRESETS = new Map([
  ["gemini", "https://generativelanguage.googleapis.com"],
  ["openai", "https://api.openai.com"],
  ["anthropic", "https://api.anthropic.com"],
  ["cohere", "https://api.cohere.ai"],
  ["httpbin", "https://httpbin.org"],
]);
let CONFIG = { ...DEFAULT_CONFIG };

function updateConfigFromEnv(env) {
  if (!env) return;
  for (const key of Object.keys(CONFIG)) {
    if (key in env) {
      if (typeof CONFIG[key] === 'boolean') CONFIG[key] = env[key] === 'true';
      else if (typeof CONFIG[key] === 'number') CONFIG[key] = Number(env[key]);
      else CONFIG[key] = env[key];
    }
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_FILTER_RE = /^(host|cf-|cdn-|referer|referrer)/i;
let log = () => {};
let userAgentManager;

function getRequestMethodForHost(hostname) {
  return HOST_REQUEST_CONFIG.get(hostname) || 'nativeFetch';
}

function resolveUrl(urlOrPreset) {
  return URL_PRESETS.get(urlOrPreset) || urlOrPreset;
}

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
      this.acceptLanguages = [
        'tr-TR,tr;q=0.9,en;q=0.8',
        'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'tr-TR,tr;q=0.9',
        'en-US,en;q=0.9',
        'en-US,en;q=0.9,es;q=0.8',
        'en-US,en;q=0.9,tr-TR;q=0.8,tr;q=0.7',
        'en-GB,en;q=0.9',
        'en-GB,en-US;q=0.9,en;q=0.8',
        'en-GB,en;q=0.9,fr;q=0.8',
        'en-SG,en;q=0.9,tr-TR;q=0.8,tr;q=0.7',
        'tr-TR,tr;q=0.9,en-SG;q=0.8,en;q=0.7',
        'en-SG,en;q=0.9,ms;q=0.8'
      ];
    }
    getRandomUserAgent() {
        if (!CONFIG.ENABLE_UA_RANDOMIZATION) return null;
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    }
    getCompatibleUserAgent(originalUA) {
        if (!CONFIG.ENABLE_UA_RANDOMIZATION || !originalUA) return null;
        const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(originalUA);
        const compatibleAgents = this.userAgents.filter(ua => isMobile === /Android|iPhone|iPad|iPod|Mobile/i.test(ua));
        return compatibleAgents.length > 0 ? compatibleAgents[Math.floor(Math.random() * compatibleAgents.length)] : this.getRandomUserAgent();
    }
    getRandomAcceptLanguage() {
        if (!CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) return null;
        return this.acceptLanguages[Math.floor(Math.random() * this.acceptLanguages.length)];
    }
}

async function parseSocks5Proxy() {
    try {
      const randomApiUrl = SOCKS5_API_URLS[Math.floor(Math.random() * SOCKS5_API_URLS.length)];
      const response = await fetch(randomApiUrl, { method: 'GET' });
      if (!response.ok) throw new Error(`Socks5 proxy alınamadı: ${response.status}`);
      const proxyData = await response.text();
      if (!proxyData || proxyData.trim() === '') throw new Error('Socks5 proxy verisi alınamadı');
      const proxyList = proxyData.trim().split('\n').filter(line => line.trim());
      if (proxyList.length === 0) throw new Error('Proxy listesi boş');
      const selectedProxy = proxyList[Math.floor(Math.random() * proxyList.length)];
      let proxyStr = selectedProxy.trim();
      let username = null, password = null, host = null, port = null;
      if (proxyStr.startsWith('socks5://')) proxyStr = proxyStr.substring(9);
      if (proxyStr.includes('@')) {
        const [authPart, addressPart] = proxyStr.split('@');
        if (authPart) [username, password] = authPart.split(':');
        [host, port] = addressPart.split(':');
      } else {
        [host, port] = proxyStr.split(':');
      }
      port = parseInt(port);
      if (!host || !port || isNaN(port)) throw new Error(`Proxy formatı eksik: ${selectedProxy}`);
      return { host, port, username, password, hasAuth: !!(username && password) };
    } catch (error) {
      log('Socks5 proxy ayrıştırma başarısız oldu:', error.message);
      throw error;
    }
}

async function performSocks5Handshake(reader, writer, targetHost, targetPort, username, password) {
    const hasAuth = !!(username && password);
    await writer.write(hasAuth ? new Uint8Array([0x05, 0x01, 0x02]) : new Uint8Array([0x05, 0x01, 0x00]));
    const authResult = await reader.read();
    if (authResult.done || authResult.value[0] !== 0x05) throw new Error('Socks5 sürümü eşleşmiyor veya yanıt hatası');
    const selectedMethod = authResult.value[1];
    if (hasAuth && selectedMethod !== 0x02) throw new Error('Socks5 sunucusu kullanıcı adı/şifre kimlik doğrulamasını desteklemiyor');
    if (!hasAuth && selectedMethod !== 0x00) throw new Error('Socks5 sunucusu kimlik doğrulama gerektiriyor ancak sağlanmadı');
    if (hasAuth) {
      const usernameBytes = encoder.encode(username);
      const passwordBytes = encoder.encode(password);
      const authData = new Uint8Array(3 + usernameBytes.length + passwordBytes.length);
      authData.set([0x01, usernameBytes.length], 0);
      authData.set(usernameBytes, 2);
      authData.set([passwordBytes.length], 2 + usernameBytes.length);
      authData.set(passwordBytes, 3 + usernameBytes.length);
      await writer.write(authData);
      const authResult2 = await reader.read();
      if (authResult2.done || authResult2.value[1] !== 0x00) throw new Error('Socks5 kullanıcı adı/şifre kimlik doğrulaması başarısız oldu');
    }
    const hostBytes = encoder.encode(targetHost);
    const connectRequest = new Uint8Array(7 + hostBytes.length);
    connectRequest.set([0x05, 0x01, 0x00, 0x03, hostBytes.length], 0);
    connectRequest.set(hostBytes, 5);
    connectRequest.set([(targetPort >> 8) & 0xFF, targetPort & 0xFF], 5 + hostBytes.length);
    await writer.write(connectRequest);
    const connectResult = await reader.read();
    if (connectResult.done || connectResult.value[1] !== 0x00) throw new Error(`Socks5 bağlantı isteği başarısız oldu: Hata kodu ${connectResult.value[1]}`);
    log('Socks5 el sıkışması tamamlandı');
}

async function fetchViaSocks5(req, dsturl) {
    const targetUrl = new URL(dsturl);
    try {
      const proxyConfig = await parseSocks5Proxy();
      const headers = new Headers(req.headers);
      for (const key of req.headers.keys()) if (HEADER_FILTER_RE.test(key)) headers.delete(key);
      const randomUA = userAgentManager.getRandomUserAgent();
      if (randomUA) headers.set("User-Agent", randomUA);
      if (CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) {
        const randomLang = userAgentManager.getRandomAcceptLanguage();
        if (randomLang) headers.set("Accept-Language", randomLang);
      }
      headers.set("Host", targetUrl.hostname);
      headers.set("Connection", "close");
      const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
      const socket = await createNewConnection(proxyConfig.host, proxyConfig.port, false);
      try {
        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();
        await performSocks5Handshake(reader, writer, targetUrl.hostname, port, proxyConfig.username, proxyConfig.password);
        let requestStr = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
        headers.forEach((v, k) => requestStr += `${k}: ${v}\r\n`);
        requestStr += '\r\n';
        await writer.write(encoder.encode(requestStr));
        if (req.body) for await (const chunk of req.body) await writer.write(chunk);
        writer.releaseLock();
        return await parseResponse(reader, socket);
      } catch (e) {
        if (!socket.closed) socket.close();
        throw e;
      }
    } catch (error) {
      log('Socks5 proxy isteği başarısız oldu:', error.message);
      throw error;
    }
}

async function createNewConnection(hostname, port, isSecure) {
  return connect({ hostname, port: Number(port) }, { secureTransport: isSecure ? "on" : "off", allowHalfOpen: true });
}

function initializeManagers() {
  if (!userAgentManager) userAgentManager = new UserAgentManager();
}

function concatUint8Arrays(arr1, arr2) {
  const result = new Uint8Array(arr1.length + arr2.length);
  result.set(arr1);
  result.set(arr2, arr1.length);
  return result;
}

function findSubarray(arr, subarr, start = 0) {
  for (let i = start; i <= arr.length - subarr.length; i++) {
    let found = true;
    for (let j = 0; j < subarr.length; j++) if (arr[i + j] !== subarr[j]) { found = false; break; }
    if (found) return i;
  }
  return -1;
}

const CRLF = new Uint8Array([13, 10]);
const HEADER_END_MARKER = new Uint8Array([13, 10, 13, 10]);

// Fix: Use indexOf(': ') for robust HTTP header parsing
function parseHttpHeaders(buff) {
    const headerEndIndex = findSubarray(buff, HEADER_END_MARKER);
    if (headerEndIndex === -1) return null;
    const text = decoder.decode(buff.slice(0, headerEndIndex));
    const lines = text.split("\r\n");
    const statusMatch = lines[0].match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Geçersiz durum satırı: ${lines[0]}`);
    const headers = new Headers();
    for (let i = 1; i < lines.length; i++) {
      const idx = lines[i].indexOf(': ');
      if (idx !== -1) {
        const key = lines[i].slice(0, idx);
        const value = lines[i].slice(idx + 2);
        headers.append(key, value);
      }
    }
    return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd: headerEndIndex };
}

// Enhancement: Read chunked data, use dynamic buffer and handle Trailer Headers
async function* readChunks(reader, initialData) {
    let buffer = initialData;
    let offset = 0;
    while (true) {
        let lineEnd = findSubarray(buffer, CRLF, offset);
        while (lineEnd === -1) {
            const { value, done } = await reader.read();
            if (done) {
                if (buffer.length > offset) throw new Error("Chunked encoding: Akış, chunk boyutunu ayrıştırırken beklenmedik şekilde sona erdi");
                return;
            }
            if (offset > 0) {
                buffer = buffer.slice(offset);
                offset = 0;
            }
            buffer = concatUint8Arrays(buffer, value);
            lineEnd = findSubarray(buffer, CRLF, offset);
        }
        const sizeHex = decoder.decode(buffer.slice(offset, lineEnd)).trim();
        const size = parseInt(sizeHex, 16);
        if (isNaN(size)) throw new Error(`Geçersiz chunk boyutu: ${sizeHex}`);
        offset = lineEnd + 2;
        if (size === 0) {
            log("Son chunk okundu (size=0), Trailer işleniyor");
            // Simplify: Loop until an empty line is found (i.e., consecutive CRLF)
            while (findSubarray(buffer, CRLF, offset) !== offset) {
                let nextLine = findSubarray(buffer, CRLF, offset);
                if (nextLine !== -1) {
                    offset = nextLine + 2; // Skip trailer line
                    continue;
                }
                const { value, done } = await reader.read();
                if (done) throw new Error("Chunked encoding: Akış, Trailer'ı ayrıştırırken beklenmedik şekilde sona erdi");
                buffer = concatUint8Arrays(buffer.slice(offset), value);
                offset = 0;
            }
            log("Chunked transfer bitti");
            return;
        }
        while (buffer.length < offset + size + 2) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Chunked encoding: Data chunk eksik");
            buffer = concatUint8Arrays(buffer, value);
        }
        yield buffer.slice(offset, offset + size);
        offset += size + 2;
    }
}

async function parseResponse(reader, socket) {
  let buff = new Uint8Array();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buff = concatUint8Arrays(buff, value);
      if (done && !buff.length) throw new Error("Yanıt ayrıştırılamadı: Akış erken bitti ve veri yok");
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        const isChunked = headers.get("transfer-encoding")?.toLowerCase().includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        const initialBodyData = buff.slice(headerEnd + 4);
        return new Response(new ReadableStream({
          async start(ctrl) {
            try {
              if (isChunked) {
                log("Yanıt Modu: Chunked Kodlama (Parçalı)");
                for await (const chunk of readChunks(reader, initialBodyData)) ctrl.enqueue(chunk);
              } else {
                log(`Yanıt Modu: Sabit Uzunluk (Content-Length: ${contentLength})`);
                let received = initialBodyData.length;
                if (received > 0) ctrl.enqueue(initialBodyData);
                while (received < contentLength) {
                  const { value, done } = await reader.read();
                  if (done) { log("Uyarı: Akış Content-Length'e ulaşmadan bitti"); break; }
                  received += value.length;
                  ctrl.enqueue(value);
                }
              }
              ctrl.close();
            } catch (err) {
              log("Akış yanıtı işleme hatası", err);
              ctrl.error(err);
            } finally {
              if (socket && !socket.closed) socket.close();
            }
          },
          cancel() {
            log("Akış istemci tarafından iptal edildi");
            if (socket && !socket.closed) socket.close();
          },
        }), { status, statusText, headers });
      }
      if (done) throw new Error("Yanıt başlığı ayrıştırılamadı: Akış bitti");
    }
  } catch (error) {
    log("Yanıt ayrıştırılırken hata oluştu", error);
    if (socket && !socket.closed) socket.close();
    throw error;
  }
}

async function nativeFetch(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    try {
        const headers = new Headers(req.headers);
        for (const key of req.headers.keys()) if (HEADER_FILTER_RE.test(key)) headers.delete(key);
        const ua = userAgentManager.getCompatibleUserAgent(req.headers.get('user-agent'));
        if (ua) headers.set('User-Agent', ua);
        if (CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) {
            const lang = userAgentManager.getRandomAcceptLanguage();
            if(lang) headers.set('Accept-Language', lang);
        }
        headers.set("Host", targetUrl.hostname);
        headers.set("Connection", "close");
        const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
        const socket = await createNewConnection(targetUrl.hostname, port, targetUrl.protocol === "https:");
        try {
            const writer = socket.writable.getWriter();
            let requestStr = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`;
            headers.forEach((v, k) => requestStr += `${k}: ${v}\r\n`);
            requestStr += '\r\n';
            await writer.write(encoder.encode(requestStr));
            if (req.body) for await (const chunk of req.body) await writer.write(chunk);
            writer.releaseLock();
            return await parseResponse(socket.readable.getReader(), socket);
        } catch (error) {
            if (!socket.closed) socket.close();
            throw error;
        }
    } catch (error) {
        log('Doğrudan bağlantı başarısız oldu, Socks5 Geri Dönüş deneniyor:', error.message);
        if (CONFIG.ENABLE_SOCKS5_FALLBACK) {
            try { return await fetchViaSocks5(req, dstUrl); } 
            catch (socks5Error) { log('Socks5 Geri Dönüş de başarısız oldu:', socks5Error.message); throw socks5Error; }
        }
        throw error;
    }
}

async function smartFetch(req, dstUrl) {
    const hostname = new URL(dstUrl).hostname;
    const requestMethod = getRequestMethodForHost(hostname);
    log(`Host ${hostname} için istek yöntemi: ${requestMethod}`);
    try {
      return requestMethod === 'socks5' ? await fetchViaSocks5(req, dstUrl) : await nativeFetch(req, dstUrl);
    } catch (error) {
      log(`Akıllı yönlendirme isteği başarısız oldu (${requestMethod}):`, error.message);
      throw error;
    }
}

async function smartFetchWithRetry(req, dstUrl, maxRetries = 2) {
    const isIdempotent = !['POST', 'PATCH'].includes(req.method.toUpperCase());
    if (!isIdempotent) {
      log(`İstek yöntemi ${req.method}, idempotent değil, yeniden deneme yapılmıyor`);
      return await smartFetch(req, dstUrl);
    }
    for (let i = 0; i <= maxRetries; i++) {
      try {
        const reqClone = req.clone();
        const response = await smartFetch(reqClone, dstUrl);
        if (response.status >= 500 && i < maxRetries) {
          log(`${response.status} hatası alındı, ${Math.pow(2, i)} saniye sonra yeniden denenecek...`);
          await response.body?.cancel(); // Use cancel to efficiently close the connection
          throw new Error(`Sunucu hatası: ${response.status}`);
        }
        return response;
      } catch (error) {
        log(`Deneme ${i + 1} başarısız oldu: ${error.message}`);
        if (i === maxRetries) {
          log("Maksimum yeniden deneme sayısına ulaşıldı, hata fırlatılıyor");
          throw error;
        }
        const delay = Math.pow(2, i) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error("Yeniden deneme mantığı beklenmedik şekilde sona erdi");
}

async function handleRequest(req, env) {
    CONFIG = { ...DEFAULT_CONFIG, ...env };
    updateConfigFromEnv(env);
    initializeManagers();
    log = CONFIG.DEBUG_MODE ? (message, data = "") => console.log(`[${new Date().toISOString()}] ${message}`, data) : () => {};
    const url = new URL(req.url);
    try {
        const pathSegments = url.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 0) {
            const dstUrl = CONFIG.DEFAULT_DST_URL + url.search;
            return await smartFetchWithRetry(req, dstUrl);
        }
        const authToken = pathSegments[0];
        if (authToken === "defaulttoken") return new Response("Lütfen varsayılan AUTH_TOKEN'ı değiştirin", { status: 401 });
        if (authToken !== CONFIG.AUTH_TOKEN || pathSegments.length < 2) {
            return new Response("Geçersiz yol. `/{authtoken}/{target_url}` veya `/{preset}` bekleniyor.", { status: 400 });
        }
        
        const presetCandidate = pathSegments[1];
        let resolvedUrl;

        if (URL_PRESETS.has(presetCandidate)) {
            resolvedUrl = URL_PRESETS.get(presetCandidate);
            const remainingPath = pathSegments.slice(2).join('/');
            if (remainingPath) {
                resolvedUrl += '/' + remainingPath;
            }
        } else {
            const authtokenPrefix = `/${authToken}/`;
            let targetUrl = decodeURIComponent(url.pathname.substring(url.pathname.indexOf(authtokenPrefix) + authtokenPrefix.length));
            resolvedUrl = resolveUrl(targetUrl); // resolveUrl, ön ayarlarda değilse yalnızca targetUrl'yi döndürür
            if (!/^https?:\/\//i.test(resolvedUrl)) {
                 return new Response("Geçersiz hedef URL. Protokol (http/https) gereklidir.", { status: 400 });
            }
        }

        const dstUrl = resolvedUrl + url.search;
        log("Hedef URL", dstUrl);
        return await smartFetchWithRetry(req, dstUrl);
    } catch (error) {
        log("İstek işleme başarısız oldu", error);
        return new Response("Kötü Ağ Geçidi", { status: 502 });
    }
}

export default { fetch: handleRequest };
export const onRequest = (ctx) => handleRequest(ctx.request, ctx.env);
nv);
ctx.env);
