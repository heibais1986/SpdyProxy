/**
 * Yapılandırma Yöneticisi
 * Ortam değişkenlerini ve genel yapılandırmayı işlemekten sorumlu
 */
export class ConfigManager {
  // Varsayılan yapılandırma
  static DEFAULT_CONFIG = {
    // Kimlik doğrulama belirteci, burada veya ortam değişkenlerinde değiştirilmelidir
    AUTH_TOKEN: "your-auth-token",
    // Varsayılan hedef URL
    DEFAULT_DST_URL: "https://httpbin.org/get",
    // Hata ayıklama modu, varsayılan olarak kapalı
    DEBUG_MODE: false,
    // Ana proxy stratejisi
    PROXY_STRATEGY: "socket",
    // Geri dönüş stratejisi, ana strateji kullanılamadığında isteği geri dönüş stratejisine yönlendirir
    // Seçenekler: fetch, socks5, thirdparty, cloudprovider, yalnızca HTTP istekleri için geçerlidir
    // Normal kullanıcılar için geri dönüş stratejisi olarak fetch kullanılması önerilir
    // Gizliliğini korumak isteyen ancak kendi socks5 veya üçüncü taraf proxy'lerini kurması sakıncalı olan kullanıcılar için cloudprovider stratejisi önerilir
    // Gizliliğini sıkı bir şekilde koruması gereken ve kendi socks5 veya üçüncü taraf proxy'lerini kurma koşullarına sahip kullanıcılar için socks5 veya thirdparty stratejisi önerilir
    FALLBACK_PROXY_STRATEGY: "fetch",

    // Proxy IP
    //PROXY_IP: "", // Henüz uygulanmadı, lütfen doldurmayın
    // SOCKS5 proxy adresi, "host:port" formatında
    SOCKS5_ADDRESS: "",
    // thirdparty stratejisi için proxy adresi
    THIRD_PARTY_PROXY_URL: "",
    // Diğer bulut sağlayıcı işlev URL'si
    CLOUD_PROVIDER_URL: "",
    // DoH sunucu yapılandırması, varsayılan olarak Google'ın DoH sunucusunu kullanır
    DOH_SERVER_HOSTNAME: "dns.google",
    DOH_SERVER_PORT: 443,
    DOH_SERVER_PATH: "/dns-query",
    // DoT sunucu yapılandırması, varsayılan olarak Google'ın DoT sunucusunu kullanır
    DOT_SERVER_HOSTNAME: "dns.google",
    DOT_SERVER_PORT: 853,
  };

  /**
   * Yapılandırmayı ortam değişkenlerinden günceller
   * @param {object} env - Ortam değişkenleri nesnesi
   * @returns {object} Güncellenmiş yapılandırma
   */
  static updateConfigFromEnv(env) {
    if (!env) return { ...this.DEFAULT_CONFIG };
    
    const config = { ...this.DEFAULT_CONFIG };
    
    for (const key of Object.keys(config)) {
      if (key in env) {
        if (typeof config[key] === 'boolean') {
          config[key] = env[key] === 'true';
        } else {
          config[key] = env[key];
        }
      }
    }
    
    return config;
  }

  /**
   * Yapılandırma değerini alır
   * @param {object} config - Yapılandırma nesnesi
   * @param {string} key - Yapılandırma anahtarı
   * @param {*} defaultValue - Varsayılan değer
   * @returns {*} Yapılandırma değeri
   */
  static getConfigValue(config, key, defaultValue = null) {
    return config[key] !== undefined ? config[key] : defaultValue;
  }
}