import { connect } from "cloudflare:sockets";
/**
 * AI Gateway with Proxy IP Fallback 
 * İşlevler: Rastgele UA, Rastgele Accept-Language, DNS çözümlemesi, ana bağlantı için doğrudan soket bağlantısı, geri dönüş için CF ters proxy IP'si (SNI PROXY yöntemiyle)
 * SNI PROXY: TLS el sıkışması için orijinal alan adını SNI olarak kullanır, ancak IP adresini ProxyIP ile değiştirir.
 * proxyIP'yi yoklama yöntemi: Alan adının A kaydını çözümlemek için DNS kullanın ve bir IP'yi rastgele ProxyIP olarak seçin.
 * Şu anda kullanılamıyor, çözülemeyen sorunlarla karşılaşıldı (TCP bağlantısı ve TLS el sıkışması ayrılamadı, uzun süreli istikrarlı bir şekilde ProxyIP'yi elde etme ve güncelleme yöntemi bulunamadı)
 */
// Genel yapılandırma
const DEFAULT_CONFIG = {
  AUTH_TOKEN: "defaulttoken",
  DEFAULT_DST_URL: "https://httpbin.org/get",
  DEBUG_MODE: true,
  ENABLE_UA_RANDOMIZATION: true,
  ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION: false, // Rastgele Accept-Language
  PROXY_DOMAINS: [""], // CF ters proxy IP alan adı listesi
};

// Varsayılan yapılandırma ile güncellenebilir bir kopya oluşturun
let CONFIG = { ...DEFAULT_CONFIG };

// Ortam değişkenlerinden yapılandırmayı güncelleyin
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

// Metin kodlayıcı/kod çözücü
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Yoksayılan istek başlığı regex'i
const HEADER_FILTER_RE = /^(host|cf-|cdn-|referer|referrer)/i;

// Günlük fonksiyonu
let log = () => {};

// Yönetici örneği
let userAgentManager;

/**
 * User-Agent yöneticisi, rastgeleleştirme için sık kullanılan UA'ları saklar
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
    
    // Accept-Language değer listesi
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

  // Rastgele UA
  getRandomUserAgent() {
    if (!CONFIG.ENABLE_UA_RANDOMIZATION) return null;
    this.currentIndex = (this.currentIndex + 1 + Math.floor(Math.random() * 2)) % this.userAgents.length;
    return this.userAgents[this.currentIndex];
  }
  
  // Uyumlu UA yöntemi
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
  
  // Rastgele Accept-Language
  getRandomAcceptLanguage() {
    if (!CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) return null;
    return this.acceptLanguages[Math.floor(Math.random() * this.acceptLanguages.length)];
  }
}


// Yeni bağlantı oluşturma yardımcı fonksiyonu
async function createNewConnection(hostname, port, isSecure) {
  log(`Yeni bağlantı oluşturuluyor ${hostname}:${port}`);

  return await connect(
    { hostname, port: Number(port) },
    {
      secureTransport: isSecure ? "on" : "off",
      allowHalfOpen: true
    }
  );
}


// Yöneticileri başlat
function initializeManagers() {
  if (!userAgentManager) userAgentManager = new UserAgentManager();
}

// Uint8Array'leri birleştir
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

// HTTP başlıklarını ayrıştır
function parseHttpHeaders(buff) {
  try {
    const text = decoder.decode(buff);
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Geçersiz durum satırı: ${statusLine}`);
    
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
    log('HTTP başlıklarını ayrıştırma hatası:', error);
    throw error;
  }
}

// Çift CRLF'ye kadar oku
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

// Parçalı verileri oku
async function* readChunks(reader, buff = new Uint8Array()) {
  while (true) {
    let pos = -1;
    // Parça boyut satırı sonunu belirten CRLF'yi arayın
    for (let i = 0; i < buff.length - 1; i++) {
      if (buff[i] === 13 && buff[i+1] === 10) { // CR LF
        pos = i;
        break;
      }
    }
    
    // Bulunamazsa, parça boyut satırı eksik demektir, soketten daha fazla veri okumak gerekir
    if (pos === -1) {
      const { value, done } = await reader.read();
      if (done) break; // Akış sonu
      buff = concatUint8Arrays(buff, value);
      continue;
    }
    
    const sizeHex = decoder.decode(buff.slice(0, pos));
    const size = parseInt(sizeHex, 16);
    
    // Boyut 0 ise, son parçadır, akış sonu
    if (isNaN(size) || size === 0) {
      log("Son parçaya ulaşıldı (boyut=0), akış sonu");
      break;
    }
    
    // Boyut satırını ve CRLF'yi kaldır
    buff = buff.slice(pos + 2);
    
    // Tam bir veri bloğu elde edilene kadar döngüsel olarak oku
    while (buff.length < size + 2) { // +2 veri bloğunun sonundaki CRLF içindir
      const { value, done } = await reader.read();
      if (done) throw new Error("Parçalı kodlamada beklenmeyen sonlanma");
      buff = concatUint8Arrays(buff, value);
    }
    
    // Ham veri bloğunu çıkar (payload)
    const chunkData = buff.slice(0, size);
    yield chunkData;
    
    // İşlenen veri bloğunu ve sonundaki CRLF'yi kaldır
    buff = buff.slice(size + 2);
  }
}

// Yanıtı ayrıştır
async function parseResponse(reader, targetHost, targetPort, socket) {
  let buff = new Uint8Array();
  
  try {
    // Tam HTTP başlığı ayrıştırılana kadar döngüsel olarak oku
    while (true) {
      const { value, done } = await reader.read();
      if (value) buff = concatUint8Arrays(buff, value);
      
      // Akış biter ancak arabellek boşsa çık
      if (done && !buff.length) {
         throw new Error("Yanıt ayrıştırılamadı: Akış erken bitti ve veri yok");
      }
      
      const parsed = parseHttpHeaders(buff);
      if (parsed) {
        const { status, statusText, headers, headerEnd } = parsed;
        
        // Anahtar mantık: Parçalı kodlama mı yoksa sabit uzunlukta kodlama mı olduğunu kontrol et
        const isChunked = headers.get("transfer-encoding")?.toLowerCase().includes("chunked");
        const contentLength = parseInt(headers.get("content-length") || "0", 10);
        
        // HTTP başlığından sonraki verileri çıkar, bu kısım yanıt gövdesinin başlangıcıdır.
        const initialBodyData = buff.slice(headerEnd + 4);
        
        return new Response(
          new ReadableStream({
            async start(ctrl) {
              try {
                if (isChunked) {
                  // Eğer parçalı kodlamaysa, ayrıştırmak için readChunks jeneratörünü kullanın
                  log("Yanıt Modu: Parçalı Kodlama (Chunked)");
                  for await (const chunk of readChunks(reader, initialBodyData)) {
                    ctrl.enqueue(chunk);
                  }
                } else {
                  // Eğer sabit uzunlukta kodlamaysa, uzunluğa göre oku
                  log(`Yanıt Modu: Sabit Uzunluk (Content-Length: ${contentLength})`);
                  let receivedLength = initialBodyData.length;
                  if (initialBodyData.length > 0) {
                    ctrl.enqueue(initialBodyData);
                  }
                  
                  // Content-Length karşılanana kadar döngüsel olarak oku
                  while (receivedLength < contentLength) {
                    const { value, done } = await reader.read();
                    if (done) {
                        log("Uyarı: Akış Content-Length'e ulaşmadan bitti");
                        break;
                    }
                    receivedLength += value.length;
                    ctrl.enqueue(value);
                  }
                }
                
                // Tüm veriler işlendi
                ctrl.close();
              } catch (err) {
                log("Akış yanıtı işleme hatası", err);
                ctrl.error(err);
              } finally {
                // Soketin kapatıldığından emin olun
                if (socket && !socket.closed) {
                  socket.close();
                }
              }
            },
            cancel() {
              log("Akış istemci tarafından iptal edildi");
              if (socket && !socket.closed) {
                socket.close();
              }
            },
          }),
          { status, statusText, headers }
        );
      }
      // Akış bitti ancak başlık henüz ayrıştırılmadıysa hata fırlat
      if (done) {
        throw new Error("Yanıt başlığı ayrıştırılamadı: Akış bitti");
      }
    }
  } catch (error) {
    log("Yanıt ayrıştırılırken hata oluştu", error);
    if (socket && !socket.closed) {
      socket.close();
    }
    // Hatayı üst katmana yakalamak için tekrar fırlat
    throw error;
  }
}


/**
 * Verilen alan adı için bir DNS sorgu mesajı oluşturur.
 * @param {string} domain Sorgulanacak alan adı.
 * @returns {Uint8Array} DNS sorgu mesajı.
 */
function buildDnsQuery(domain) {
  const header = new Uint8Array([
    Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), // İşlem Kimliği
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
  question[offset++] = 0; // Alan adı sonu

  // Sorgu türü (A) ve sınıfı (IN)
  question[offset++] = 0x00;
  question[offset++] = 0x01; // Tip A
  question[offset++] = 0x00;
  question[offset++] = 0x01; // Sınıf IN

  return concatUint8Arrays(header, question.slice(0, offset));
}

/**
 * İkili DNS yanıtından IP adreslerini ayrıştırır.
 * @param {Uint8Array} buffer DNS yanıtını içeren arabellek.
 * @returns {string[]} A kayıtlarından çıkarılan IP adreslerinin dizisi.
 */
function parseDnsResponse(buffer) {
  const dataView = new DataView(buffer.buffer);
  const answerCount = dataView.getUint16(6);
  let offset = 12; // Başlığı atla
  
  // Soru bölümünü atla
  while (buffer[offset] !== 0) {
    if (offset > buffer.length) return []; // Sonsuz döngüyü önle
    offset += buffer[offset] + 1;
  }
  offset += 5; // Soru sonundaki 0 baytını ve türü/sınıfı atla

  const addresses = [];
  for (let i = 0; i < answerCount; i++) {
    if (offset + 12 > buffer.length) break;

    // Adı atla (genellikle işaretçi, 2 bayt)
    offset += 2;
    
    const type = dataView.getUint16(offset);
    offset += 2; // Türü atla
    offset += 6; // Sınıfı ve TTL'yi atla
    const rdLength = dataView.getUint16(offset);
    offset += 2; // rdLength'i atla

    if (type === 1 && rdLength === 4) { // A kaydı
      addresses.push(`${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`);
    }
    offset += rdLength;
  }
  
  return addresses;
}

/**
 * Bir alan adının A kayıtlarını sorgular ve sonuçlardan rastgele bir IP döndürür.
 * @param {string} domain Sorgulanacak alan adı.
 * @returns {Promise<string|null>} Rastgele bir IP adresi, bulunamazsa null döndürür.
 */
async function resolveDomainRandomIP(domain) {
  log(`Alan için ikili DNS sorgusu yürütülüyor: ${domain}`);
  const query = buildDnsQuery(domain);
  try {
    const response = await fetch('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: query,
    });
    if (!response.ok) {
      throw new Error(`DNS sorgusu başarısız oldu, durum: ${response.status}`);
    }
    const addresses = parseDnsResponse(new Uint8Array(await response.arrayBuffer()));
    if (addresses.length === 0) {
      log(`Alan ${domain} için A kaydı bulunamadı`);
      return null;
    }
    const randomIP = addresses[Math.floor(Math.random() * addresses.length)];
    log(`${domain} için rastgele IP çözümlendi: ${randomIP}`);
    return randomIP;
  } catch (error) {
    log('İkili DNS çözümleme hatası:', error);
    throw error;
  }
}

/**
 * Yardımcı fonksiyon, HTTP isteklerini soket aracılığıyla gönderir
 * @param {string} hostname - Hedef ana bilgisayar adı veya IP
 * @param {number} port - Hedef bağlantı noktası
 * @param {boolean} isSecure - TLS kullanılıp kullanılmayacağı
 * @param {Request} req - Orijinal istek nesnesi
 * @param {Headers} headers - Temizlenmiş ve değiştirilmiş istek başlıkları
 * @param {URL} targetUrl - Hedef URL nesnesi
 * @returns {Promise<Response>}
 */
async function sendRequestViaSocket(hostname, port, isSecure, req, headers, targetUrl) {
  const socket = await createNewConnection(hostname, port, isSecure);
  try {
    const writer = socket.writable.getWriter();
    const requestLine = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
      Array.from(headers.entries()).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n";
    
    log(`Soket aracılığıyla ${hostname}:${port} adresine istek gönderiliyor`);
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
    // Hatayı işlemek için çağırana yeniden fırlat
    throw error;
  }
}

/**
 * Yerel HTTP isteği
 */
async function nativeFetch(req, dstUrl) {
  // İstek başlıklarını temizle ve rastgeleleştirme uygula
  const cleanedHeaders = new Headers();
  for (const [k, v] of req.headers) {
    if (!HEADER_FILTER_RE.test(k)) cleanedHeaders.set(k, v);
  }

  const randomUA = userAgentManager.getCompatibleUserAgent(req.headers.get('user-agent'));
  if (randomUA) {
    cleanedHeaders.set('User-Agent', randomUA);
    log('User-Agent kullanılıyor:', randomUA);
  }

  if (CONFIG.ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION) {
    const randomLang = userAgentManager.getRandomAcceptLanguage();
    if (randomLang) {
      cleanedHeaders.set('Accept-Language', randomLang);
      log('Accept-Language kullanılıyor:', randomLang);
    }
  }

  const targetUrl = new URL(dstUrl);
  const port = targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80);
  const isSecure = targetUrl.protocol === "https:";

  // Host başlığını ayarla
  cleanedHeaders.set("Host", targetUrl.hostname);
  cleanedHeaders.set("Connection", "close");

  // İsteği klonla
  const reqForFallback = req.clone();

  try {
    // Doğrudan bağlanmayı dene
    log(`${targetUrl.hostname}:${port} adresine doğrudan bağlanılmaya çalışılıyor`);
    return await sendRequestViaSocket(targetUrl.hostname, port, isSecure, req, cleanedHeaders, targetUrl);
  } catch (error) {
    log('Doğrudan soket bağlantısı başarısız oldu, geri dönüş deneniyor:', error.message);
    
    //Geri dönüş mantığı
    if (CONFIG.PROXY_DOMAINS && CONFIG.PROXY_DOMAINS.length > 0) {
      const randomDomain = CONFIG.PROXY_DOMAINS[Math.floor(Math.random() * CONFIG.PROXY_DOMAINS.length)];
      const proxyIP = await resolveDomainRandomIP(randomDomain);

      if (proxyIP) {
        log(`Geri dönüş bağlantısı için proxy IP ${proxyIP} (kaynak: ${randomDomain}) kullanılıyor`);
        try {
          // Geri dönüş için klonlanmış isteği kullan
          return await sendRequestViaSocket(proxyIP, port, isSecure, reqForFallback, cleanedHeaders, targetUrl);
        } catch (proxyError) {
          log('Proxy IP bağlantısı başarısız oldu:', proxyError.message);
          // Tutarlılığı korumak için orijinal hatayı tekrar fırlat
          throw error;
        }
      } else {
        log(`${randomDomain} için IP çözümlenemedi, geri dönüş başarısız oldu`);
      }
    }
    
    // Geri dönüş seçeneği yoksa veya geri dönüş başarısız olursa, orijinal hatayı tekrar fırlat
    throw error;
  }
}


/**
 * İstek işleme girişi
 */
async function handleRequest(req, env) {
  // Yapılandırmayı klonla ve güncelle (genel durumu kirletmekten kaçınmak için)
  CONFIG = { ...DEFAULT_CONFIG, ...env };
  updateConfigFromEnv(env);
  
  // Yöneticileri başlat
  initializeManagers();
  
  // Günlüğü ayarla
  log = CONFIG.DEBUG_MODE
    ? (message, data = "") => console.log(`[${new Date().toISOString()}] ${message}`, data)
    : () => {};
  
  const url = new URL(req.url);
  
  // Yönlendirme işlemesi
  try {
    const pathSegments = url.pathname.split('/').filter(Boolean);

    // Eğer yol boşsa, varsayılan hedef adrese istek gönder
    if (pathSegments.length === 0) {
      log("Yolsuz istek, varsayılan URL'ye yönlendiriliyor", CONFIG.DEFAULT_DST_URL);
      const dstUrl = CONFIG.DEFAULT_DST_URL + url.search;
      return await nativeFetch(req, dstUrl);
    }
    if (authToken === "defaulttoken") {
      const msg = "Lütfen varsayılan AUTH_TOKEN'ı değiştirin, 10 karakterden uzun rastgele bir dize önerilir";
      log(msg);
      return new Response(msg, { status: 401 });
    }

    const authToken = pathSegments[0];
    const hasTargetUrl = pathSegments.length >= 2;

    // Eğer kimlik doğrulama belirteci eşleşmezse veya hedef URL eksikse
    if (authToken !== CONFIG.AUTH_TOKEN || !hasTargetUrl) {
      const msg = "Geçersiz yol. `/{authtoken}/{target_url}` bekleniyor. lütfen kimlik doğrulama belirtecinizi veya hedef URL'yi kontrol edin";
      log(msg, { authToken, hasTargetUrl });
      return new Response(msg, { status: 400 });
    }

    // Hedef URL'yi çıkar
    const authtokenPrefix = `/${authToken}/`;
    let targetUrl = url.pathname.substring(url.pathname.indexOf(authtokenPrefix) + authtokenPrefix.length);
    targetUrl = decodeURIComponent(targetUrl);

    // URL protokolünü doğrula (http/https)
    if (!/^https?:\/\//i.test(targetUrl)) {
      const msg = "Geçersiz hedef URL. Protokol (http/https) gereklidir.";
      log(msg, { targetUrl });
      return new Response(msg, { status: 400 });
    }

    const dstUrl = targetUrl + url.search;
    log("Hedef URL", dstUrl);
    return await nativeFetch(req, dstUrl);

  } catch (error) {
    log("İstek işleme başarısız oldu", error);
    return new Response("Kötü Ağ Geçidi", { status: 502 });
  }
}

// Worker işleyicilerini dışa aktar
export default { fetch: handleRequest };
export const onRequest = (ctx) => handleRequest(ctx.request, ctx.env);
