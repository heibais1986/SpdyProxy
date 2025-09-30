import { BaseProxy } from './base.js';

/**
 * Bulut Sağlayıcı Proxy Sınıfı
 * Gerçek IP'yi sızdırmaktan kaçınmak için bağlantı için bir sıçrama tahtası olarak diğer bulut sağlayıcılarının Sunucusuz işlevlerini kullanır, ancak diğer bulut sağlayıcıları hakkında bazı bilgileri sızdırır
 * Örneğin, Vercel, Vercel'in Ana Bilgisayarı gibi bilgileri sızdıracaktır
 * Not: Bu proxy, WebSocket bağlantılarını desteklemeyebilir, farklı platformların farklı kuralları vardır
 */
export class CloudProviderProxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma
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
      // Kullanılan diğer bulut sağlayıcılarının WebSocket desteği onaylanamadığından doğrudan bir hata döndür
      // Bulut sağlayıcısının WebSocket'i desteklediği onaylanırsa, ilgili bağlantı mantığı uygulanabilir
      return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
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
    const cloudProviderUrl = this.config.CLOUD_PROVIDER_URL;
    if (!cloudProviderUrl) {
      return this.handleError(new Error("Cloud provider URL is not configured"), "Cloud provider proxy connection", 500);
    }

    const proxyUrlObj = new URL(cloudProviderUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);

    // Doğrudan orijinal başlıkları kullanarak yeni bir istek oluştur, artık filtreleme yok
    // Başlıkları kaldırıp bulut sağlayıcısına gönderirken olası sorunları önlemek için, başlıklar burada artık filtrelenmiyor
    // Başlıklar, Cloudflare'in başlık bilgilerini kaldırmak için bulut sağlayıcı işlevinde işlenmelidir
    // base.js'deki filterHeaders yöntemine başvurabilirsiniz
    const proxyRequest = new Request(proxyUrlObj.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual', // Proxy'nin kendisinin yönlendirilmesini önle
    });

    try {
      this.log(`Using cloud provider proxy via fetch to connect to`, dstUrl);
      return await fetch(proxyRequest);
    } catch (error) {
      return this.handleError(error, "Cloud provider proxy connection");
    }
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
     // Kullanılan diğer bulut sağlayıcılarının WebSocket desteği onaylanamadığından doğrudan bir hata döndür
     // Bulut sağlayıcısının WebSocket'i desteklediği onaylanırsa, ilgili bağlantı mantığı uygulanabilir
    return new Response("Cloud provider proxy may not support WebSocket", { status: 400 });
  }
}