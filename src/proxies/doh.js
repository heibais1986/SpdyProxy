import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';
import { FetchProxy } from './fetch.js';

/**
 * DoH (DNS over HTTPS) Proxy Sınıfı
 * DNS sorgu isteklerini proxy'lemek için kullanılır
 */
export class DoHProxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    super(config);
    // Yukarı akış DoH sunucu bilgileri
    this.UPSTREAM_DOH_SERVER = {
      hostname: config.DOH_SERVER_HOSTNAME || 'dns.google',
      port: config.DOH_SERVER_PORT || 443,
      path: config.DOH_SERVER_PATH || '/dns-query',
    };
  }

  /**
   * DNS sorgu isteğini işler
   * @param {Request} req - İstek nesnesi
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async handleDnsQuery(req) {
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/dns-message') {
      return new Response('This is a DNS proxy. Please use a DoH client.', { status: 400 });
    }

    let clientDnsQuery;
    try {
      clientDnsQuery = await req.arrayBuffer();

      // Hassas bilgilerin sızdırılmamasını sağlamak için istek başlıklarını filtrele
      const cleanedHeaders = this.filterHeaders(req.headers);

      // DOH istek başlıkları
      cleanedHeaders.set('Host', this.UPSTREAM_DOH_SERVER.hostname);
      cleanedHeaders.set('Content-Type', 'application/dns-message');
      cleanedHeaders.set('Content-Length', clientDnsQuery.byteLength.toString());
      cleanedHeaders.set('Accept', 'application/dns-message');
      cleanedHeaders.set('Connection', 'close'); // Tamamlandıktan sonra bağlantıyı kapat, işlemi basitleştir

      // TLS bağlantısı kur
      const socket = connect(this.UPSTREAM_DOH_SERVER, { secureTransport: 'on', allowHalfOpen: false });
      const writer = socket.writable.getWriter();

      // HTTP POST isteği oluştur
      const httpHeaders =
        `POST ${this.UPSTREAM_DOH_SERVER.path} HTTP/1.1\r\n` +
        Array.from(cleanedHeaders.entries())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';

      const requestHeaderBytes = this.encoder.encode(httpHeaders);
      const requestBodyBytes = new Uint8Array(clientDnsQuery);

      // İstek başlığını ve gövdesini birleştir
      const fullRequest = new Uint8Array(requestHeaderBytes.length + requestBodyBytes.length);
      fullRequest.set(requestHeaderBytes, 0);
      fullRequest.set(requestBodyBytes, requestHeaderBytes.length);

      // İstek
      await writer.write(fullRequest);
      writer.releaseLock();

      // Yanıtı oku ve ayrıştır
      const reader = socket.readable.getReader();
      let responseBytes = new Uint8Array();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Veri bloklarını birleştir
        const newBuffer = new Uint8Array(responseBytes.length + value.length);
        newBuffer.set(responseBytes, 0);
        newBuffer.set(value, responseBytes.length);
        responseBytes = newBuffer;
      }

      reader.releaseLock();
      await socket.close();

      // 5. HTTP yanıt başlığını soy, Gövdeyi çıkar, yalnızca DNS yanıt sonucunu döndür
      const separator = new Uint8Array([13, 10, 13, 10]);
      let separatorIndex = -1;
      for (let i = 0; i < responseBytes.length - 3; i++) {
        if (responseBytes[i] === separator[0] && responseBytes[i + 1] === separator[1] && 
            responseBytes[i + 2] === separator[2] && responseBytes[i + 3] === separator[3]) {
          separatorIndex = i;
          break;
        }
      }

      if (separatorIndex === -1) {
        throw new Error("Could not find HTTP header/body separator in response.");
      }

      const dnsResponseBody = responseBytes.slice(separatorIndex + 4);

      // DNS yanıtını döndür
      return new Response(dnsResponseBody, {
        headers: { 'content-type': 'application/dns-message' },
      });
    } catch (error) {
      // soket stratejisi başarısız olduğunda, fetch stratejisine geri dön
      try {
        const fallbackProxy = new FetchProxy(this.config);
        // Orijinal istek yeniden kullanılamaz, gövdesi zaten okunmuş. Mevcut gövde verilerini kullanarak yeni bir istek oluşturuyoruz.
        const fallbackRequest = new Request(req.url, {
            method: req.method,
            headers: req.headers,
            body: clientDnsQuery // Daha önce okunan arabellek
        });
        return await fallbackProxy.handleDnsQuery(fallbackRequest);
      } catch (fallbackError) {
        return this.handleError(fallbackError, "DoH proxying with connect", 502);
      }
    }
  }

  /**
   * Hedef sunucuya bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connect(req, dstUrl) {
    // DoH proxy'si yalnızca DNS sorgu isteklerini işler
    return await this.handleDnsQuery(req);
  }

  /**
   * HTTP hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttp(req, dstUrl) {
    // DoH proxy'si yalnızca DNS sorgu isteklerini işler
    return await this.handleDnsQuery(req);
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    // DoH proxy'si WebSocket'i desteklemez
    return new Response("DoH proxy does not support WebSocket", { status: 400 });
  }
}
