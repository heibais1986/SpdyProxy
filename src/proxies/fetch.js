import { BaseProxy } from './base.js';

/**
 * Fetch Proxy Sınıfı
 * Bağlantı için Fetch API'sini kullanır
 */
export class FetchProxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    super(config);
    // Yukarı akış DNS sunucu yapılandırması
    this.UPSTREAM_DNS_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
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
      // Fetch, WebSocket'i desteklemez, hata döndür
      return new Response("Fetch proxy does not support WebSocket", { status: 400 });
    } else {
      return await this.connectHttp(req, dstUrl);
    }
  }

  /**
   * HTTP hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttp(req, dstUrl) {
    const targetUrl = new URL(dstUrl);
    
    // Başlık bilgilerini temizle
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // Gerekli başlıkları ayarla
    cleanedHeaders.set("Host", targetUrl.hostname);
    
    try {
      // Bağlantı için fetch kullan
      const fetchRequest = new Request(dstUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to connect to", dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      // Birleşik hata işleme yöntemini kullan
      return this.handleError(error, "Fetch connection");
    }
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    // Fetch, WebSocket'i desteklemez, hata döndür
    return new Response("Fetch proxy does not support WebSocket", { status: 400 });
  }

  /**
   * DNS sorgu isteğini işler
   * @param {Request} req - İstek nesnesi
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async handleDnsQuery(req) {
    // Fetch proxy'si DNS sorgu isteklerini doğrudan işleyebilir
    try {
      // Yukarı akış DNS sunucu URL'sini oluştur
      const upstreamDnsUrl = `https://${this.UPSTREAM_DNS_SERVER.hostname}${this.UPSTREAM_DNS_SERVER.path}`;
      
      // Başlık bilgilerini temizle
      const cleanedHeaders = this.filterHeaders(req.headers);
      
      // Gerekli başlıkları ayarla
      cleanedHeaders.set("Host", this.UPSTREAM_DNS_SERVER.hostname);
      cleanedHeaders.set("Content-Type", "application/dns-message");
      cleanedHeaders.set("Accept", "application/dns-message");
      
      // DNS sorgu isteğini iletmek için fetch kullan
      const fetchRequest = new Request(upstreamDnsUrl, {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log("Using fetch to handle DNS query");
      return await fetch(fetchRequest);
    } catch (error) {
      // Birleşik hata işleme yöntemini kullan
      return this.handleError(error, "Fetch DNS query handling", 502);
    }
  }
}