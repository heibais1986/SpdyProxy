# Proje Değişiklik Kaydı

## 2025-08-19

### ✨ Yeni Özellikler (feat)

1.  **AI API'lerine Özel Proxy Uygulaması (`AIGateway`)**
    *   **Temel Yetenek**: Özellikle AI API'leri için tasarlanmış gelişmiş bir proxy uygulaması, akış aktarımını mükemmel şekilde destekler.
    *   **Akıllı Yönlendirme**: Hedef alan adına (örn. `api.openai.com`) göre otomatik olarak `SOCKS5` proxy veya doğrudan bağlantı seçebilir, performansı ve başarı oranını artırır.
    *   **Hata Geri Dönüşü ve Yeniden Deneme**:
        *   Doğrudan bağlantı başarısız olduğunda SOCKS5'i yedek çözüm olarak destekler (`Fallback`).
        *   Idempotent istekler (örn. GET) için 5xx hatalarıyla karşılaşıldığında otomatik olarak üstel geri çekilme ile yeniden deneme yapar.
    *   **Esnek Yapılandırma**:
        *   Birden fazla kaynaktan dinamik olarak SOCKS5 proxy'leri almayı ve rastgele kullanmayı destekler.
        *   URL ön ayarlarını (`/openai`, `/gemini`) destekleyerek istek yollarını basitleştirir.
    *   **İstek Kamuflajı**:
        *   `User-Agent` ve `Accept-Language` istek başlıklarını rastgeleleştirmeyi destekler.
        *   Orijinal isteğin UA türüne (mobil/masaüstü) göre uyumlu UA'ları akıllıca eşleştirebilir.

2.  **SNI Proxy Modunun Keşfi (Kısmi Uygulama)**
    *   `AIGatewayWithProxyIP半成品.js` dosyasında, Cloudflare IP'sini ters proxy yaparak SNI proxy çözümünü denedik.
    *   **Geliştirme Fikri**:
        *   Yerleşik DoH çözümlemesiyle hedef alan adının gerçek IP'sini alın.
        *   Kullanılabilir ters proxy IP'lerine işaret eden bir alan adı tutun. (Basit bir yük dengeleme sağlamak için kısa bir TTL ayarlayın)
        *   `edgetunnel` fikrinden esinlenerek, istek başarısız olduğunda `socket`'ı klonlayın, ters proxy IP'sine iletin ve orijinal `Host` başlığını koruyun.
    *   **Mevcut Engeller**: TLS el sıkışmasından sonra `Stream was cancelled` hatası oluşuyor ve şu anda kullanılabilir ters proxy IP'lerini istikrarlı bir şekilde elde etmek için otomatik bir çözüm bulunmuyor.

3.  **`single.js`'nin Gelecek Geliştirme Yönünün Belirlenmesi**
    *   `single.js` öncelikli olarak gizlilik korumasına önem veren sıradan kullanıcılara yönelik olacaktır.
    *   En yüksek performans optimizasyonundan ziyade daha fazla protokolü desteklemeye öncelik verilecektir.
    *   Gizlilik gereksinimleri düşük olan senaryolarda, `socket` programlamanın getirdiği karmaşıklığı azaltmak için yerel `fetch` API'si öncelikli olarak kullanılacaktır.

### 🐛 Hata Düzeltmeleri (bugfix)

1.  Belirli senaryolarda akış aktarımının kesintiye uğraması veya eksik olması sorunları giderildi.

### 🗑️ Eskitme ve Kaldırma (drop)

1.  `single.js`**'den `proxyip` (SNI proxy) modu kaldırıldı**
    *   **Neden**: İstikrarlı, kullanılabilir bir ters proxy IP havuzunu sürdürmek çok zor ve zaman alıcıdır. Bu mod `single.js`'den kaldırıldı.
    *   **Referans Uygulama**: Bu teknolojiyle ilgilenen geliştiriciler, `AIGatewayWithProxyIP半成品.js`'deki keşif amaçlı kodlara başvurabilirler.

2.  **Bağlantı havuzu uygulamasından vazgeçildi**
    *   **Neden**: Cloudflare Workers'ın temel güvenlik kısıtlamalarıyla karşılaşıldı – `"Cannot perform I/O on behalf of a different request"` hatası.
    *   **Teknik Detaylar**: Bir istek tarafından oluşturulan `socket` başka bir bağımsız istek tarafından yeniden kullanılamaz. Bu, `Durable Objects` gibi yöntemlerle atlatılabilir, ancak bu yeni karmaşıklıklar getirir ve istek başlıkları gibi hassas bilgileri sızdırır, bu da gizlilik korumasının temel amacına aykırıdır.

3.  **`AIGateway`'den WebSocket desteği kaldırıldı**
    *   **Neden**:
        *   **Dar Uygulama Alanı**: Ana akım AI API'lerinde (OpenAI, Gemini), WebSocket öncelikli olarak gerçek zamanlı ses gibi az sayıda senaryo için kullanılır ve kullanıcı tabanı küçüktür.
        *   **Sıkı Gereksinimler**: Gerçek zamanlı uygulamalar gecikme ve kararlılık açısından yüksek gereksinimlere sahiptir.
        *   **Bilinmeyen Uyumluluk**: Kullanılan SOCKS5 sunucusunun veya ters proxy IP'sinin WebSocket protokolünü istikrarlı bir şekilde destekleyeceği garanti edilemez.
    *   **Alternatif Çözüm**: WebSocket proxy gereksinimleri olan kullanıcılar lütfen `single.js` kullanın.