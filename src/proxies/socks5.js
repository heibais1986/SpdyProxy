import { connect } from 'cloudflare:sockets';
import { BaseProxy } from './base.js';

/**
 * SOCKS5 Proxy Sınıfı
 * Bağlantı için SOCKS5 proxy'sini kullanır
 */
export class Socks5Proxy extends BaseProxy {
  /**
   * Kurucu
   * @param {object} config - Yapılandırma nesnesi
   */
  constructor(config) {
    super(config);
    this.parsedSocks5Address = this.parseSocks5Address(config.SOCKS5_ADDRESS);
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
    
    // SOCKS5 proxy üzerinden bağlan
    const socket = await this.socks5Connect(
      2, // alan adı
      targetUrl.hostname,
      Number(targetUrl.port) || (targetUrl.protocol === "wss:" ? 443 : 80)
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
    const targetUrl = new URL(dstUrl);
    
    // Başlık bilgilerini temizle
    const cleanedHeaders = this.filterHeaders(req.headers);
    
    // Standart HTTP istekleri için: gerekli başlıkları ayarla (Host gibi ve sıkıştırmayı devre dışı bırak)
    cleanedHeaders.set("Host", targetUrl.hostname);
    cleanedHeaders.set("accept-encoding", "identity");
  
    try {
      // SOCKS5 proxy üzerinden bağlan
      const socket = await this.socks5Connect(
        2, // alan adı
        targetUrl.hostname,
        Number(targetUrl.port) || (targetUrl.protocol === "https:" ? 443 : 80)
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
      // Birleşik hata işleme yöntemini kullan
      return this.handleError(error, "SOCKS5 connection");
    }
  }

  /**
   * SOCKS5 proxy üzerinden bağlanır
   * @param {number} addressType - Adres türü
   * @param {string} addressRemote - Uzak adres
   * @param {number} portRemote - Uzak bağlantı noktası
   * @returns {Promise<Socket>} Soket nesnesi
   */
  async socks5Connect(addressType, addressRemote, portRemote) {
    const { username, password, hostname, port } = this.parsedSocks5Address;
    // Connect to the SOCKS server
    const socket = connect({
      hostname,
      port,
    });

    // İstek başlığı formatı (Çalışan -> Socks Sunucusu):
    // +----+----------+----------+
    // |VER | NMETHODS | METHODS  |
    // +----+----------+----------+
    // | 1  |    1     | 1 to 255 |
    // +----+----------+----------+

    // https://en.wikipedia.org/wiki/SOCKS#SOCKS5
    // YÖNTEMLER için:
    // 0x00 KİMLİK DOĞRULAMASI GEREKLİ DEĞİL
    // 0x02 KULLANICI ADI/ŞİFRE https://datatracker.ietf.org/doc/html/rfc1929
    const socksGreeting = new Uint8Array([5, 2, 0, 2]);

    const writer = socket.writable.getWriter();

    await writer.write(socksGreeting);
    this.log('sent socks greeting');

    const reader = socket.readable.getReader();
    const encoder = new TextEncoder();
    let res = (await reader.read()).value;
    // Yanıt formatı (Socks Sunucusu -> Çalışan):
    // +----+--------+
    // |VER | METHOD |
    // +----+--------+
    // | 1  |   1    |
    // +----+--------+
    if (res[0] !== 0x05) {
      this.log(`socks server version error: ${res[0]} expected: 5`);
      throw new Error(`socks server version error: ${res[0]} expected: 5`);
    }
    if (res[1] === 0xff) {
      this.log("no acceptable methods");
      throw new Error("no acceptable methods");
    }

    // 0x0502 döndürürse
    if (res[1] === 0x02) {
      this.log("socks server needs auth");
      if (!username || !password) {
        this.log("please provide username/password");
        throw new Error("please provide username/password");
      }
      // +----+------+----------+------+----------+
      // |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
      // +----+------+----------+------+----------+
      // | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
      // +----+------+----------+------+----------+
      const authRequest = new Uint8Array([
        1,
        username.length,
        ...encoder.encode(username),
        password.length,
        ...encoder.encode(password)
      ]);
      await writer.write(authRequest);
      res = (await reader.read()).value;
      // expected 0x0100
      if (res[0] !== 0x01 || res[1] !== 0x00) {
        this.log("fail to auth socks server");
        throw new Error("fail to auth socks server");
      }
    }

    // İstek veri formatı (Çalışan -> Socks Sunucusu):
    // +----+-----+-------+------+----------+----------+
    // |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
    // +----+-----+-------+------+----------+----------+
    // | 1  |  1  | X'00' |  1   | Variable |    2     |
    // +----+-----+-------+------+----------+----------+
    // ATYP: aşağıdaki adresin adres türü
    // 0x01: IPv4 adresi
    // 0x03: Alan adı
    // 0x04: IPv6 adresi
    // DST.ADDR: istenen hedef adresi
    // DST.PORT: ağ bayt sırasında istenen hedef bağlantı noktası

    // adresTürü
    // 1--> ipv4 adresUzunluğu =4
    // 2--> alan adı
    // 3--> ipv6 adresUzunluğu =16
    let DSTADDR; // DSTADDR = ATYP + DST.ADDR
    switch (addressType) {
      case 1:
        DSTADDR = new Uint8Array(
          [1, ...addressRemote.split('.').map(Number)]
        );
        break;
      case 2:
        DSTADDR = new Uint8Array(
          [3, addressRemote.length, ...encoder.encode(addressRemote)]
        );
        break;
      case 3:
        DSTADDR = new Uint8Array(
          [4, ...addressRemote.split(':').flatMap(x => [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2), 16)])]
        );
        break;
      default:
        this.log(`invalid addressType is ${addressType}`);
        throw new Error(`invalid addressType is ${addressType}`);
    }
    const socksRequest = new Uint8Array([5, 1, 0, ...DSTADDR, portRemote >> 8, portRemote & 0xff]);
    await writer.write(socksRequest);
    this.log('sent socks request');

    res = (await reader.read()).value;
    // Yanıt formatı (Socks Sunucusu -> Çalışan):
    //  +----+-----+-------+------+----------+----------+
    // |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
    // +----+-----+-------+------+----------+----------+
    // | 1  |  1  | X'00' |  1   | Variable |    2     |
    // +----+-----+-------+------+----------+----------+
    if (res[1] === 0x00) {
      this.log("socks connection opened");
    } else {
      this.log("fail to open socks connection");
      throw new Error("fail to open socks connection");
    }
    writer.releaseLock();
    reader.releaseLock();
    return socket;
  }

  /**
   * SOCKS5 adresini ayrıştırır
   * @param {string} address - SOCKS5 adresi
   * @returns {object} Ayrıştırılmış adres bilgileri
   */
  parseSocks5Address(address) {
    let [latter, former] = address.split("@").reverse();
    let username, password, hostname, port;
    if (former) {
      const formers = former.split(":");
      if (formers.length !== 2) {
        throw new Error('Invalid SOCKS address format');
      }
      [username, password] = formers;
    }
    const latters = latter.split(":");
    port = Number(latters.pop());
    if (isNaN(port)) {
      throw new Error('Invalid SOCKS address format');
    }
    hostname = latters.join(":");
    const regex = /^.*\]$/;
    if (hostname.includes(":") && !regex.test(hostname)) {
      throw new Error('Invalid SOCKS address format');
    }
    return {
      username,
      password,
      hostname,
      port,
    }
  }
}
