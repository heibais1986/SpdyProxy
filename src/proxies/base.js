/**
 * Temel Proxy Sınıfı
 * Tüm proxy stratejileri bu sınıftan miras almalıdır
 */
export class BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    this.config = config;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    
    // Hata ayıklama günlüğü çıktı işlevini tanımla
    this.log = config.DEBUG_MODE
      ? (message, data = "") => console.log(`[DEBUG] ${message}`, data)
      : () => {};
  }

  /**
   * Hedef sunucuya bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connect(req, dstUrl) {
    throw new Error("connect method must be implemented by subclass");
  }

  /**
   * WebSocket hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectWebSocket(req, dstUrl) {
    throw new Error("connectWebSocket method must be implemented by subclass");
  }

  /**
   * HTTP hedef sunucusuna bağlanır
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttp(req, dstUrl) {
    throw new Error("connectHttp method must be implemented by subclass");
  }

  /**
   * DNS sorgu isteğini işler
   * @param {Request} req - İstek nesnesi
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async handleDnsQuery(req) {
    // Varsayılan uygulama
    return new Response("DNS query handling not implemented for this proxy type", { status: 501 });
  }

  /**
   * Hata işleme yöntemi
   * @param {Error} error - Hata nesnesi
   * @param {string} context - Hata bağlamı açıklaması
   * @param {number} status - HTTP durum kodu
   * @returns {Response} Hata yanıtı
   */
  handleError(error, context, status = 500) {
    this.log(`${context} failed`, error.message);
    return new Response(`Error ${context.toLowerCase()}: ${error.message}`, { status });
  }

  /**
   * Cloudflare ağ sınırlama hatası olup olmadığını kontrol eder
   * @param {Error} error - Hata nesnesi
   * @returns {boolean} Cloudflare ağ sınırlama hatası olup olmadığı
   */
  isCloudflareNetworkError(error) {
    // Varsayılan uygulama
    return false;
  }

  /**
   * Genel HTTP proxy bağlantı yöntemi
   * @param {Request} req - İstek nesnesi
   * @param {string} dstUrl - Hedef URL
   * @param {string} proxyUrl - Proxy URL'si
   * @param {string} proxyType - Proxy türü (günlük için)
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async connectHttpViaProxy(req, dstUrl, proxyUrl, proxyType) {
    const targetUrl = new URL(dstUrl);
    const proxyUrlObj = new URL(proxyUrl);
    proxyUrlObj.searchParams.set('target', dstUrl);
    
    // Cloudflare'in gizliliği ifşa eden başlık bilgilerini temizle
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // Gerekli başlıkları ayarla
    cleanedHeaders.set("Host", proxyUrlObj.hostname);
    
    try {
      // Bağlantı için proxy kullan
      const fetchRequest = new Request(proxyUrlObj.toString(), {
        method: req.method,
        headers: cleanedHeaders,
        body: req.body,
      });
      
      this.log(`Using ${proxyType} proxy to connect to`, dstUrl);
      return await fetch(fetchRequest);
    } catch (error) {
      // Birleşik hata işleme yöntemini kullan
      return this.handleError(error, `${proxyType} proxy connection`);
    }
  }

  /**
   * HTTP başlıklarını filtrele
   * @param {Headers} headers - HTTP başlıkları
   * @returns {Headers} Filtrelenmiş HTTP başlıkları
   */
  filterHeaders(headers) {
    // Yönlendirilmemesi gereken HTTP başlıklarını filtrele (şu başlıkları yoksay: host, accept-encoding, cf-*, cdn-*, referer, referrer)
    const HEADER_FILTER_RE = /^(host|accept-encoding|cf-|cdn-|referer|referrer)/i;
    const cleanedHeaders = new Headers();
    
    for (const [k, v] of headers) {
      if (!HEADER_FILTER_RE.test(k)) {
        cleanedHeaders.set(k, v);
      }
    }
    
    return cleanedHeaders;
  }

  /**
   * WebSocket el sıkışması için gereken rastgele Sec-WebSocket-Key oluşturur
   * @returns {string} WebSocket anahtarı
   */
  generateWebSocketKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
  }

  /**
   * İstemci ve uzak soket arasında WebSocket çerçevelerini çift yönlü olarak aktarır
   * @param {WebSocket} ws - WebSocket nesnesi
   * @param {Socket} socket - Soket nesnesi
   * @param {WritableStreamDefaultWriter} writer - Yazıcı
   * @param {ReadableStreamDefaultReader} reader - Okuyucu
   */
  relayWebSocketFrames(ws, socket, writer, reader) {
    // İstemciden gelen mesajları dinle, çerçevelere paketle ve uzak sokete gönder
    ws.addEventListener("message", async (event) => {
      let payload;
      if (typeof event.data === "string") {
        payload = this.encoder.encode(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        payload = new Uint8Array(event.data);
      } else {
        payload = event.data;
      }
      const frame = this.packTextFrame(payload);
      try {
        await writer.write(frame);
      } catch (e) {
        this.log("Remote write error", e);
      }
    });
    
    // Uzaktan alınan WebSocket çerçevelerini istemciye eşzamansız olarak aktar
    (async () => {
      const frameReader = new this.SocketFramesReader(reader, this);
      try {
        while (true) {
          const frame = await frameReader.nextFrame();
          if (!frame) break;
          // İşlem koduna göre veri çerçevelerini işle
          switch (frame.opcode) {
            case 1: // Metin çerçevesi
            case 2: // İkili çerçeve
              ws.send(frame.payload);
              break;
            case 8: // Kapatma çerçevesi
              this.log("Received Close frame, closing WebSocket");
              ws.close(1000);
              return;
            default:
              this.log(`Received unknown frame type, Opcode: ${frame.opcode}`);
          }
        }
      } catch (e) {
        this.log("Error reading remote frame", e);
      } finally {
        ws.close();
        writer.releaseLock();
        socket.close();
      }
    })();
    
    // İstemci WebSocket'i kapandığında, uzak soket bağlantısını da kapat
    ws.addEventListener("close", () => socket.close());
  }

  /**
   * Metin mesajını bir WebSocket çerçevesine paketler
   * @param {Uint8Array} payload - Yük
   * @returns {Uint8Array} Paketlenmiş çerçeve
   */
  packTextFrame(payload) {
    const FIN_AND_OP = 0x81; // FIN bayrağı ve metin çerçevesi işlem kodu
    const maskBit = 0x80; // Maske biti (istemci tarafından gönderilen mesajlar için 1 olarak ayarlanmalıdır)
    const len = payload.length;
    let header;
    if (len < 126) {
      header = new Uint8Array(2);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = new Uint8Array(4);
      header[0] = FIN_AND_OP;
      header[1] = maskBit | 126;
      header[2] = (len >> 8) & 0xff;
      header[3] = len & 0xff;
    } else {
      throw new Error("Payload too large");
    }
    // 4 baytlık rastgele maske oluştur
    const mask = new Uint8Array(4);
    crypto.getRandomValues(mask);
    const maskedPayload = new Uint8Array(len);
    // Yüke maske uygula
    for (let i = 0; i < len; i++) {
      maskedPayload[i] = payload[i] ^ mask[i % 4];
    }
    // Çerçeve başlığını, maskeyi ve maskelenmiş yükü birleştir
    return this.concatUint8Arrays(header, mask, maskedPayload);
  }

  /**
   * Parçalanmış mesajları destekleyen WebSocket çerçevelerini ayrıştırmak ve yeniden birleştirmek için sınıf
   */
  SocketFramesReader = class {
    /**
     * Kurucu
     * @param {ReadableStreamDefaultReader} reader - Okuyucu
     * @param {BaseProxy} parent - Üst sınıf örneği
     */
    constructor(reader, parent) {
      this.reader = reader;
      this.parent = parent;
      this.buffer = new Uint8Array();
      this.fragmentedPayload = null;
      this.fragmentedOpcode = null;
    }
    
    /**
     * Arabellekte ayrıştırma için yeterli bayt olduğundan emin olur
     * @param {number} length - Uzunluk
     * @returns {Promise<boolean>} Yeterli bayt olup olmadığı
     */
    async ensureBuffer(length) {
      while (this.buffer.length < length) {
        const { value, done } = await this.reader.read();
        if (done) return false;
        this.buffer = this.parent.concatUint8Arrays(this.buffer, value);
      }
      return true;
    }
    
    /**
     * Sonraki WebSocket çerçevesini ayrıştırır ve parçalanmayı işler
     * @returns {Promise<object|null>} Çerçeve nesnesi
     */
    async nextFrame() {
      while (true) {
        if (!(await this.ensureBuffer(2))) return null;
        const first = this.buffer[0],
          second = this.buffer[1],
          fin = (first >> 7) & 1,
          opcode = first & 0x0f,
          isMasked = (second >> 7) & 1;
        let payloadLen = second & 0x7f,
          offset = 2;
        // Yük uzunluğu 126 ise, gerçek uzunluğu almak için sonraki iki baytı ayrıştır
        if (payloadLen === 126) {
          if (!(await this.ensureBuffer(offset + 2))) return null;
          payloadLen = (this.buffer[offset] << 8) | this.buffer[offset + 1];
          offset += 2;
        } else if (payloadLen === 127) {
          throw new Error("127 length mode is not supported");
        }
        let mask;
        if (isMasked) {
          if (!(await this.ensureBuffer(offset + 4))) return null;
          mask = this.buffer.slice(offset, offset + 4);
          offset += 4;
        }
        if (!(await this.ensureBuffer(offset + payloadLen))) return null;
        let payload = this.buffer.slice(offset, offset + payloadLen);
        if (isMasked && mask) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        // İşlenmiş baytları arabellekten kaldır
        this.buffer = this.buffer.slice(offset + payloadLen);
        if (opcode === 0) {
          if (this.fragmentedPayload === null)
            throw new Error("Received continuation frame without initiation");
          this.fragmentedPayload = this.parent.concatUint8Arrays(this.fragmentedPayload, payload);
          if (fin) {
            const completePayload = this.fragmentedPayload;
            const completeOpcode = this.fragmentedOpcode;
            this.fragmentedPayload = this.fragmentedOpcode = null;
            return { fin: true, opcode: completeOpcode, payload: completePayload };
          }
        } else {
          // Parçalanmış veri varsa ancak geçerli çerçeve bir devam çerçevesi değilse, parçalanma durumunu sıfırla
          if (!fin) {
            this.fragmentedPayload = payload;
            this.fragmentedOpcode = opcode;
            continue;
          } else {
            if (this.fragmentedPayload) {
              this.fragmentedPayload = this.fragmentedOpcode = null;
            }
            return { fin, opcode, payload };
          }
        }
      }
    }
  };

  /**
   * Birden çok Uint8Array'i birleştirir
   * @param {...Uint8Array} arrays - Birleştirilecek diziler
   * @returns {Uint8Array} Birleştirilmiş dizi
   */
  concatUint8Arrays(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  /**
   * HTTP yanıt başlıklarını ayrıştırır
   * @param {Uint8Array} buff - Arabellek
   * @returns {object|null} Ayrıştırma sonucu
   */
  parseHttpHeaders(buff) {
    const text = this.decoder.decode(buff);
    // "\r\n\r\n" ile belirtilen HTTP başlık sonu işaretçisini bul
    const headerEnd = text.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = text.slice(0, headerEnd).split("\r\n");
    const statusLine = headerSection[0];
    // HTTP durum satırını eşleştir
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
    if (!statusMatch) throw new Error(`Invalid status line: ${statusLine}`);
    const headers = new Headers();
    // Yanıt başlıklarını ayrıştır
    for (let i = 1; i < headerSection.length; i++) {
      const line = headerSection[i];
      const idx = line.indexOf(": ");
      if (idx !== -1) {
        headers.append(line.slice(0, idx), line.slice(idx + 2));
      }
    }
    return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
  }

  /**
   * Çift CRLF'ye kadar okur
   * @param {ReadableStreamDefaultReader} reader - Okuyucu
   * @returns {Promise<string>} Okunan metin
   */
  async readUntilDoubleCRLF(reader) {
    let respText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        respText += this.decoder.decode(value, { stream: true });
        if (respText.includes("\r\n\r\n")) break;
      }
      if (done) break;
    }
    return respText;
  }

  /**
   * Tam HTTP yanıtını ayrıştırır
   * @param {ReadableStreamDefaultReader} reader - Okuyucu
   * @returns {Promise<Response>} Yanıt nesnesi
   */
  async parseResponse(reader) {
    let buff = new Uint8Array();
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buff = this.concatUint8Arrays(buff, value);
        const parsed = this.parseHttpHeaders(buff);
        if (parsed) {
          const { status, statusText, headers, headerEnd } = parsed;
          const isChunked = headers.get("transfer-encoding")?.includes("chunked");
          const contentLength = parseInt(headers.get("content-length") || "0", 10);
          const data = buff.slice(headerEnd + 4);
          // Yanıt gövdesi verilerini ReadableStream aracılığıyla dağıt
          // this bağlamını kaydet
          const self = this;
          return new Response(
            new ReadableStream({
              start: async (ctrl) => {
                try {
                  if (isChunked) {
                    console.log("Using chunked transfer mode");
                    // Parçalı aktarım modu: her bloğu sırayla oku ve sıraya al
                    for await (const chunk of self.readChunks(reader, data)) {
                      ctrl.enqueue(chunk);
                    }
                  } else {
                    console.log("Using fixed-length transfer mode, contentLength: " + contentLength);
                    let received = data.length;
                    if (data.length) ctrl.enqueue(data);
                    // Sabit uzunluk modu: content-length'e göre belirtilen bayt sayısını oku
                    while (received < contentLength) {
                      const { value, done } = await reader.read();
                      if (done) break;
                      received += value.length;
                      ctrl.enqueue(value);
                    }
                  }
                  ctrl.close();
                } catch (err) {
                  console.log("Error parsing response", err);
                  ctrl.error(err);
                }
              },
            }),
            { status, statusText, headers }
          );
        }
      }
      if (done) break;
    }
    throw new Error("Unable to parse response headers");
  }

  /**
   * Eşzamansız üreteç: parçalı HTTP yanıt verilerini okur ve her veri bloğunu sırayla üretir
   * @param {ReadableStreamDefaultReader} reader - Okuyucu
   * @param {Uint8Array} buff - Arabellek
   * @returns {AsyncGenerator<Uint8Array>} Veri bloğu üreteci
   */
  async *readChunks(reader, buff = new Uint8Array()) {
    while (true) {
      // Mevcut arabellekte CRLF ayırıcısının konumunu bul
      let pos = -1;
      for (let i = 0; i < buff.length - 1; i++) {
        if (buff[i] === 13 && buff[i + 1] === 10) {
          pos = i;
          break;
        }
      }
      // Bulunamazsa, arabelleği doldurmak için daha fazla veri okumaya devam et
      if (pos === -1) {
        const { value, done } = await reader.read();
        if (done) break;
        buff = this.concatUint8Arrays(buff, value);
        continue;
      }
      // Blok boyutunu ayrıştır (onaltılık biçim)
      const sizeStr = this.decoder.decode(buff.slice(0, pos));
      const size = parseInt(sizeStr, 16);
      this.log("Read chunk size", size);
      // Boyut 0, bloğun sonunu gösterir
      if (!size) break;
      // Ayrıştırılmış boyut bölümünü ve sonraki CRLF'yi arabellekten kaldır
      buff = buff.slice(pos + 2);
      // Arabelleğin tam bloğu içerdiğinden emin ol (sondaki CRLF dahil)
      while (buff.length < size + 2) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Unexpected EOF in chunked encoding");
        buff = this.concatUint8Arrays(buff, value);
      }
      // Blok verilerini üret (sondaki CRLF hariç)
      yield buff.slice(0, size);
      buff = buff.slice(size + 2);
    }
  }
}
