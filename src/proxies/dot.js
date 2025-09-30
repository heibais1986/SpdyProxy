import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';

/**
 * DoT Proxy Sınıfı
 * DOT sorgu isteklerini proxy'lemek için kullanılır
 */
export class DoTProxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    super(config);
    // Yukarı akış DoT sunucu bilgilerini al
    this.UPSTREAM_DOT_SERVER = {
      hostname: config.DOT_SERVER_HOSTNAME || 'some-niche-dns.com',
      port: config.DOT_SERVER_PORT || 853,
    };
  }

  /**
   * DNS sorgu isteğini işler
   * @param {Request} req - İstek nesnesi
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async handleDnsQuery(req) {
    if (req.method !== 'POST' || req.headers.get('content-type') !== 'application/dns-message') {
      return new Response('This is a DNS proxy. Please use a DoT client.', { status: 400 });
    }

    let clientDnsQuery;
    try {
      clientDnsQuery = await req.arrayBuffer();
      const socket = connect(this.UPSTREAM_DOT_SERVER, { secureTransport: 'on', allowHalfOpen: false });
      const writer = socket.writable.getWriter();
      const queryLength = clientDnsQuery.byteLength;
      const lengthBuffer = new Uint8Array(2);
      new DataView(lengthBuffer.buffer).setUint16(0, queryLength, false); // Big-endian
      const dotRequest = new Uint8Array(2 + queryLength);
      dotRequest.set(lengthBuffer, 0);
      dotRequest.set(new Uint8Array(clientDnsQuery), 2);
      await writer.write(dotRequest);
      writer.releaseLock();
      const reader = socket.readable.getReader();
      let responseChunks = [];
      let totalLength = 0;
      
      // DoT yanıtı parçalanmış olabilir, döngüsel olarak okunması gerekir
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseChunks.push(value);
        totalLength += value.length;
      }

      reader.releaseLock();
      await socket.close();
      
      // Parçaları birleştir
      const fullResponse = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of responseChunks) {
          fullResponse.set(chunk, offset);
          offset += chunk.length;
      }

      // DoT yanıtını ayrıştır (2 baytlık uzunluk önekini kaldır)
      const responseLength = new DataView(fullResponse.buffer).getUint16(0, false);
      const dnsResponse = fullResponse.slice(2, 2 + responseLength);

      //DNS sorgu sonucunu döndür
      return new Response(dnsResponse, {
        headers: { 'content-type': 'application/dns-message' },
      });

    } catch (socketError) {
      this.log('DoT socket connection failed, falling back to DoH via fetch.', socketError);
      
      // DOT, soket stratejisi isteği başarısız olduğunda (genellikle hedef DOT sunucusu Cloudflare ağı kullandığı için), geri dönüş olarak Fetch isteği DOH kullanır
      // Cloudflare ağının DOT sunucusuna Fetch isteğiyle sık sık sorun yaşandığından, geri dönüş olarak Fetch isteği DOH kullanılır
      try {
        this.log('Attempting DoH fallback...');
        const upstreamDnsUrl = `https://${this.config.DOH_SERVER_HOSTNAME}${this.config.DOH_SERVER_PATH || '/dns-query'}`;
        
        const dohHeaders = new Headers();
        dohHeaders.set("Host", this.config.DOH_SERVER_HOSTNAME);
        dohHeaders.set("Content-Type", "application/dns-message");
        dohHeaders.set("Accept", "application/dns-message");
        
        const fallbackRequest = new Request(upstreamDnsUrl, {
            method: 'POST',
            headers: dohHeaders,
            body: clientDnsQuery,
        });
        
        return await fetch(fallbackRequest);

      } catch (fallbackError) {
        this.log('DoH fallback also failed.', fallbackError);
        return this.handleError(fallbackError, 'DoT and subsequent DoH fallback');
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
    // DoT proxy'si yalnızca DNS sorgu isteklerini işler
    return await this.handleDnsQuery(req);
  }

  /**
   * HTTP hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttp(req, dstUrl) {
    // DoT proxy'si yalnızca DNS sorgu isteklerini işler
    return await this.handleDnsQuery(req);
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    // DoT proxy'si WebSocket'i desteklemez
    return new Response("DoT proxy does not support WebSocket", { status: 400 });
  }
}