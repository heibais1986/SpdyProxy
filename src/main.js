import { ConfigManager } from './config.js';
import { ProxyFactory } from './proxy-factory.js';

/**
 * ShadowProxy Ana
 * İstekleri işlemekten ve yapılandırmaya göre uygun proxy stratejisini seçmekten sorumlu
 */
export class ShadowProxy {
  /**
   * İstekleri işlemek için giriş noktası
   * @param {Request} req - İstek nesnesi
   * @param {object} env - Ortam değişkenleri
   * @param {object} ctx - Bağlam nesnesi
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  static async handleRequest(req, env, ctx) {
    try {
      // Yapılandırmayı güncelle
      const config = ConfigManager.updateConfigFromEnv(env);
      
      // İstek yolunu ayrıştır
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      
      // DNS sorgu isteği olup olmadığını kontrol et
      if (parts.length >= 3 && parts[1] === 'dns') {
        const auth = parts[0];
        const dnsType = parts[2]; // DNS türü: DOH/DOT
        const server = parts[3]; // İsteğe bağlı sunucu adresi, aksi takdirde varsayılan DOH/DOT sunucusunu kullan
        
        // AuthToken'i doğrula
        if (auth === config.AUTH_TOKEN) {
          // DNS türüne göre proxy stratejisi seç
          let proxyStrategy = config.PROXY_STRATEGY;
          if (dnsType === 'doh') {
            proxyStrategy = 'doh';
          } else if (dnsType === 'dot') {
            proxyStrategy = 'dot';
          }
          
          // İlgili DNS proxy stratejisini kullanmak için yapılandırmayı güncelle
          const dnsConfig = { ...config, PROXY_STRATEGY: proxyStrategy };
          const proxy = ProxyFactory.createProxy(dnsConfig);
          
          // DNS sorgu isteğini işle
          return await proxy.handleDnsQuery(req);
        }
      }
      
      // Varsayılan proxy örneği oluştur
      const proxy = ProxyFactory.createProxy(config);
      
      // Hedef URL'yi ayrıştır
      const dstUrl = this.parseDestinationUrl(req, config);
      
      // Hedef sunucuya bağlanmak için proxy kullan
      return await proxy.connect(req, dstUrl);
    } catch (error) {
      console.error("ShadowProxy error:", error);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }

  /**
   * Hedef URL'yi ayrıştırır
   * @param {Request} req - İstek nesnesi
   * @param {object} config - Yapılandırma nesnesi
   * @returns {string} Hedef URL
   */
  static parseDestinationUrl(req, config) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const [auth, protocol, ...path] = parts;

    // authtoken'i kontrol et
    const isValid = auth === config.AUTH_TOKEN;
    
    let dstUrl = config.DEFAULT_DST_URL;

    if (isValid && protocol) {
      // Yoldan gelen protokolün "https:" veya "https" olabileceği durumları işle
      if (protocol.endsWith(':')) {
        dstUrl = `${protocol}//${path.join("/")}${url.search}`;
      } else {
        dstUrl = `${protocol}://${path.join("/")}${url.search}`;
      }
    }
    
    // Hata ayıklama modu etkinse, hedef URL'yi günlüğe kaydet
    if (config.DEBUG_MODE) {
      console.log("Target URL", dstUrl);
    }
    
    return dstUrl;
  }
}