import { BaseProxy } from './base.js';

/**
 * Üçüncü Taraf Proxy Sınıfı
 * Bağlantı için üçüncü taraf proxy hizmetlerini kullanır
 */
export class ThirdPartyProxy extends BaseProxy {
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
      // Üçüncü taraf proxy'si WebSocket'i desteklemeyebilir, hata döndür
      return new Response("Third party proxy may not support WebSocket", { status: 400 });
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
    const thirdPartyProxyUrl = this.config.THIRD_PARTY_PROXY_URL;
    if (!thirdPartyProxyUrl) {
      return this.handleError(new Error("Third party proxy URL is not configured"), "Third party proxy connection", 500);
    }

    const proxyUrlObj = new URL(thirdPartyProxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    // Doğrudan orijinal başlıkları kullanarak yeni bir istek oluştur, artık filtreleme yok
    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', // Proxy'nin kendisinin yönlendirilmesini önle
    });

    try {
      this.log(`Using third party proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Third party proxy connection");
    }
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    // Üçüncü taraf proxy'si WebSocket'i desteklemeyebilir, hata döndür
    return new Response("Third party proxy may not support WebSocket", { status: 400 });
  }
}