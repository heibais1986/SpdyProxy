import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';
import { FetchProxy } from './fetch.js';
import { Socks5Proxy } from './socks5.js';
import { ThirdPartyProxy } from './third-party.js';
import { CloudProviderProxy } from './cloud-provider.js';

/**
 * Soket Proxy Sınıfı
 * Bağlantı için Cloudflare Soket API'sini kullanır
 */
export class SocketProxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    super(config);
  }

  /**
   * Hedef sunucuya bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connect(req, dstUrl) {
    // İsteğin bir WebSocket isteği olup olmadığını kontrol et
    const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
    const isWebSocket = upgradeHeader === "websocket";
    
    if (isWebSocket) {
      return await this.connectWebSocket(req, dstUrl);
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    // Hedef URL WebSocket protokolünü desteklemiyorsa, bir hata yanıtı döndür
    if (!/^wss?:\/\/i.test(dstUrl)) {
      return new Response("Target does not support WebSocket", { status: 400 });
    }
    
    const isSecure = targetUrl.protocol === "wss:";
    const port = targetUrl.port || (isSecure ? 443 : 80);
    
    // Hedef sunucuya ham bir soket bağlantısı kur
    const socket = await connect(
      { hostname: targetUrl.hostname, port: Number(port) },
      { secureTransport: isSecure ? "on" : "off", allowHalfOpen: false }
    );
  
    // WebSocket el sıkışması için gereken anahtarı oluştur
    const key = this.generateWebSocketKey();

    // Başlık bilgilerini temizle
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // El sıkışma için gereken HTTP başlıklarını oluştur
    cleanedHeaders.set('Host', targetUrl.hostname);
    cleanedHeaders.set('Connection', 'Upgrade');
    cleanedHeaders.set('Upgrade', 'websocket');
    cleanedHeaders.set('Sec-WebSocket-Version', '13');
    cleanedHeaders.set('Sec-WebSocket-Key', key);
  
    // WebSocket el sıkışması için HTTP istek verilerini birleştir
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
    
    // El sıkışma yanıtının 101 Protokol Değiştirme durumunu gösterip göstermediğini doğrula
    if (
      !handshakeResp.includes("101") ||
      !handshakeResp.includes("Switching Protocols")
    ) {
      throw new Error("WebSocket handshake failed: " + handshakeResp);
    }
  
    // Dahili bir WebSocketPair oluştur
    const webSocketPair = new WebSocketPair();
    const client = webSocketPair[0];
    const server = webSocketPair[1];
    client.accept();
    
    // İstemci ve uzak soket arasında çift yönlü bir çerçeve rölesi kur
    this.relayWebSocketFrames(client, socket, writer, reader);
    return new Response(null, { status: 101, webSocket: server });
  }

  /**
   * HTTP hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttp(req, dstUrl) {
    // Olası bir geri dönüş işlemi için, gövde akışını korumak üzere isteği hemen klonla
    const reqForFallback = req.clone();
    const targetUrl = new URL(dstUrl);
    
    // Başlık bilgilerini temizle
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // Standart HTTP istekleri için: gerekli başlıkları ayarla (Host gibi ve sıkıştırmayı devre dışı bırak)
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      const port = targetUrl.protocol === "https:" ? 443 : 80;
      const socket = await connect(
        { hostname: targetUrl.hostname, port: Number(port) },
        { secureTransport: targetUrl.protocol === "https:" ? "on" : "off", allowHalfOpen: false }
      );
      const writer = socket.writable.getWriter();
      
      // İstek satırını ve başlıklarını oluştur
      const requestLine =
        `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n";
      
      this.log("Sending request", requestLine);
      await writer.write(this.encoder.encode(requestLine));
    
      // Bir istek gövdesi varsa, onu hedef sunucuya ilet
      if (req.body) {
        this.log("Forwarding request body");
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
      }
      
      // Hedef sunucunun yanıtını ayrıştır ve döndür
      return await this.parseResponse(socket.readable.getReader());
    } catch (error) {
      // Cloudflare ağ kısıtlama hatası olup olmadığını kontrol et
      if (this.isCloudflareNetworkError(error)) {
        this.log("Cloudflare network restriction detected, switching to fallback proxy");
        this.log("Original error:", error.message);
        
        // Ortam değişkenlerinde yapılandırılan geri dönüş stratejisine göre uygun bir geri dönüş planı seç
        const fallbackStrategy = this.config.FALLBACK_PROXY_STRATEGY || "fetch";
        this.log("Using fallback strategy:", fallbackStrategy);
        
        // Bir geri dönüş proxy örneği oluştur
        const fallbackConfig = { ...this.config, PROXY_STRATEGY: fallbackStrategy };
        let fallbackProxy;
        
        // Geri dönüş stratejisine göre ilgili proxy örneğini oluştur
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
        
        // Geri dönüş proxy'sini kullan
        // Geri dönüş için gövdesi değiştirilmemiş klonlanmış isteği kullan
        return await fallbackProxy.connectHttp(reqForFallback, dstUrl);
      }
      
      // Birleşik hata işleme yöntemini kullan
      return this.handleError(error, "Socket connection");
    }
  }

  /**
   * Cloudflare ağ kısıtlama hatası olup olmadığını kontrol eder
   * @param {Error} error - Hata nesnesi
   * @returns {boolean} Cloudflare ağ kısıtlama hatası olup olmadığı
   */
  isCloudflareNetworkError(error) {
    // Cloudflare ağ kısıtlama hataları genellikle belirli hata mesajları içerir
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
    // Soket proxy'si DNS sorgu isteklerini doğrudan işlemez, DoH veya DoT proxy'si kullanılmalıdır
    return new Response("Socket proxy does not support DNS query handling. Please use DoH or DoT proxy.", { status: 400 });
  }
}
