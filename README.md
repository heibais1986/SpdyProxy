# SpectreProxy

![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)![Language](https://img.shields.io/badge/language-JavaScript-orange.svg)![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-red)

Cloudflare Workers ve yerel TCP Soketi tabanlı gelişmiş bir akıllı proxy ağ geçidi. İstek akışını tamamen kontrol ederek yerel `fetch` API'deki gizlilik sızıntısı sorununu çözer ve yüksek kararlılık, gizlilik koruması ve karmaşık ağ erişimi gerektiren senaryolar için tasarlanmış esnek geri dönüş stratejileri, akıllı yönlendirme ve çoklu protokol desteği sunar.

## İçindekiler
- [Feragatname](#feragatname)
- [Proje Geçmişi](#proje-geçmişi)
- [Temel Prensipler ve Özellikler](#temel-prensipler-ve-özellikler)
  - [Temel Prensipler](#temel-prensipler)
  - [Ana Özellikler](#ana-özellikler-1)
- [Kurulum Rehberi](#kurulum-rehberi)
  - [Sürüm Seçimi](#sürüm-seçimi)
  - [Kurulum Adımları](#kurulum-adımları)
  - [Ortam Değişkenlerini Yapılandırma](#ortam-değişkenlerini-yapılandırma)
- [Ortam Değişkeni Yapılandırması](#ortam-değişkeni-yapılandırması-1)
  - [Genel Yapılandırma (single.js & AIGateway)](#genel-yapılandırma-singlejs--aigateway)
  - [AIGateway Özel Yapılandırması](#aigateway-özel-yapılandırması)
  - [single.js Özel Yapılandırması](#singlejs-özel-yapılandırması)
- [Kullanım Yöntemi](#kullanım-yöntemi)
  - [AIGateway (AI Proxy Optimize Edilmiş Sürüm)](#aigateway-ai-proxy-optimize-edilmiş-sürüm)
  - [single.js (Genel Sürüm)](#singlejs-genel-sürüm)
- [Uyumluluk Testi](#uyumluluk-testi)
- [Geliştirme Rehberi](#geliştirme-rehberi)
  - [Proje Yapısı](#proje-yapısı)
  - [Üçüncü Taraf HTTP Proxy](#üçüncü-taraf-http-proxy)
  - [Diğer Bulut Platformu Uyumlu Proxy'ler](#diğer-bulut-platformu-uyumlu-proxy'ler)
- [Değişiklik Kaydı (Changelog)](#değişiklik-kaydı-changelog)
- [Lisans](#lisans)

## Feragatname

Bu proje, Cloudflare Worker mekanizmasını öğrenmek ve anlamak için bir örnek olup, yalnızca kişisel öğrenim ve ağ teknolojileri araştırması için tasarlanmıştır, **herhangi bir yasa dışı amaç için kullanılması kesinlikle yasaktır**.

Bu projeyi kullanan herkes, bulunduğu ülke veya bölgenin yasa ve yönetmeliklerine uymalıdır. Bu projenin kullanımı veya kötüye kullanımı sonucunda ortaya çıkan doğrudan veya dolaylı yasal sorumluluk ve riskler **kullanıcının kendisi tarafından üstlenilir**. Yazar ve katkıda bulunanlar, bu projenin üçüncü taraflarca yapılan herhangi bir yasa dışı faaliyetinden veya neden olduğu herhangi bir zarardan sorumlu değildir.

Bu projeyi kullanmaya başladığınızda, yukarıdaki şartları tamamen anladığınızı ve kabul ettiğinizi beyan etmiş olursunuz.

## Proje Geçmişi

Cloudflare Workers'ın `fetch` API'si, ters proxy'leri kolayca uygulamak için güçlü bir araçtır. Ancak, isteklere otomatik olarak belirli `CF-*` istek başlıkları ekler, örneğin:

- `cf-connecting-ip`: Başlangıçtaki kullanıcının gerçek IP adresini ortaya çıkarır.
- `cf-ipcountry`: Kullanıcının bulunduğu ülkeyi/bölgeyi ortaya çıkarır.
- `cf-worker`: İsteğin Cloudflare Workers üzerinden geçtiğini açıkça belirtir.

Bu istek başlıkları normal yollarla kaldırılamaz ve aşağıdaki sorunlara yol açar:

1. **Gizlilik Sızıntısı**: Kullanıcının gerçek IP'si hedef sunucuya ifşa edilir.
2. **Erişim Kısıtlamaları**: Bazı ülke/bölge kısıtlamaları olan hizmetler (örn. OpenAI, Claude) `cf-country` nedeniyle erişimi reddeder.
3. **Proxy İfşası**: Hedef web sitesi, isteğin Cloudflare Workers'tan geldiğini kolayca tespit edebilir ve hatta bu nedenle alan adını yasaklayabilir.

![fetch api ile karşılaştırma](https://github.com/XyzenSun/SpectreProxy/raw/main/img/img_contrast.jpg)

## Temel Prensipler ve Özellikler

Yukarıdaki sorunları çözmek için SpectreProxy daha düşük seviyeli bir çözüm benimser.

### Temel Prensipler

Proje, Cloudflare Workers'ın **yerel TCP Soket API'sini** (`connect()`) kullanarak doğrudan HTTP/1.1, WebSocket ve DNS istekleri oluşturur. Bu yöntem, isteğin her baytını tamamen kontrol etmeyi sağlar ve `fetch` API'nin otomatik olarak eklediği ve gizliliği ihlal edebilecek istek başlıklarını kökünden önler.

### Ana Özellikler

- **Gizlilik Koruması**: Yerel Soket aracılığıyla gerçek IP ve proxy izlerini gizleyerek kullanıcı gizliliğini korur.
- **Akıllı Yönlendirme ve Geri Dönüş**:
    - **`AIGateway`**: Hedef alan adına göre otomatik olarak **SOCKS5 proxy** veya **doğrudan bağlantı** seçebilir ve doğrudan bağlantı başarısız olursa otomatik olarak SOCKS5'e geri dönebilir.
    - **`single.js`**: `socket`, `fetch`, `socks5` gibi çeşitli stratejileri destekler ve ana strateji başarısız olduğunda yedek stratejiye geçebilir.
- **Çoklu Protokol Desteği (`single.js`)**: Yerel olarak HTTP/S, WebSocket (WSS) ve DNS-over-HTTPS (DoH) / DNS-over-TLS (DoT) sorgularını destekler.
- **Gelişmiş İstek Kamuflajı (`AIGateway`)**: `User-Agent` ve `Accept-Language`'ı rastgeleleştirmeyi destekler ve orijinal isteğin UA türüne (mobil/masaüstü) göre akıllıca eşleştirebilir.
- **Yüksek Kullanılabilirlik (`AIGateway`)**:
    - Birden fazla API adresinden dinamik olarak SOCKS5 proxy'leri almayı ve rastgele kullanmayı destekler.
    - `5xx` hatalarıyla karşılaşıldığında idempotent istekler için otomatik olarak üstel geri çekilme denemeleri yapar.
- **Kolay Kurulum**: Karmaşık harici bağımlılıklar olmadan tek dosya Worker betiği sağlar.

## Kurulum Rehberi

### Sürüm Seçimi

Proje iki sürüm sunar, lütfen ihtiyaçlarınıza göre seçin:

- **`aigateway.js`**: **AI API'lerini proxy yapmak için önerilir**. Derinlemesine optimize edilmiş, yerleşik akıllı yönlendirme, SOCKS5 proxy, otomatik yeniden deneme ve başlık kamuflajı ile daha iyi performans ve kararlılık sunar.
- **`single.js`**: **Genel sürüm**. HTTP, WebSocket, DoH/DoT gibi çeşitli protokolleri destekler, esnek yapılandırmaya sahiptir ve daha geniş proxy senaryoları için uygundur.

### Kurulum Adımları

1. **Cloudflare Ortamını Hazırlayın**: Bir Cloudflare hesabınız olduğundan ve Workers hizmetini etkinleştirdiğinizden emin olun.
2. **Worker Oluşturun**: Cloudflare kontrol panelinde, `Compute (Workers)`->`Workers & Pages` > `Create`->`Start with Hello World!`->`Deploy` -> `Continue to Project` -> `Edit Code` adımlarını izleyin.
3. **Kodu Kopyalayın**: Seçtiğiniz sürümün (`aigateway.js` veya `single.js`) tüm içeriğini kopyalayın, `worker.js` içine yapıştırın ve **Deploy**'a tıklayın.
4. **Ortam Değişkenlerini Yapılandırın**: Worker'ın `Settings` > `Variables` sayfasında, yapılandırmayı tamamlamak için aşağıdaki açıklamalara göre ortam değişkenlerini ekleyin.

## Ortam Değişkeni Yapılandırması

### Genel Yapılandırma (single.js & AIGateway)

| Ortam Değişkeni | Açıklama                                                                |
| --------------- | ----------------------------------------------------------------------- |
| `AUTH_TOKEN`    | **Proxy erişimi için gerekli kimlik doğrulama anahtarı, kendi güçlü şifrenizle değiştirdiğinizden emin olun**. Varsayılan değerler `"your-auth-token"` veya `"defaulttoken"`'dır. |
| `DEFAULT_DST_URL` | Hedef belirtilmediğinde varsayılan olarak erişilecek URL.               |
| `DEBUG_MODE`    | Hata ayıklama modunun etkinleştirilip etkinleştirilmeyeceği. Etkinleştirilirse ayrıntılı günlükler konsola yazdırılır. Üretim ortamında `false` olarak ayarlanması önerilir. |

### AIGateway Özel Yapılandırması

| Ortam Değişkeni                      | Varsayılan Değer | Açıklama                                     |
| ------------------------------------ | -------------- | -------------------------------------------- |
| `ENABLE_UA_RANDOMIZATION`            | `true`         | Rastgele User-Agent özelliğini etkinleştirir. |
| `ENABLE_ACCEPT_LANGUAGE_RANDOMIZATION` | `false`        | Rastgele `Accept-Language` özelliğini etkinleştirir. |
| `ENABLE_SOCKS5_FALLBACK`             | `true`         | Doğrudan bağlantı başarısız olduğunda otomatik olarak SOCKS5 kullanmayı dener. |

**İpucu**: `AIGateway`'in gelişmiş yönlendirme ve SOCKS5 kaynakları kod içinde yapılandırılır.

`SOCKS5_API_URLS`: Get isteğiyle SOCKS5 API yolunu temsil eder. Kimlik doğrulama gerekiyorsa, `parseSocks5Proxy()` içindeki `const response = await fetch(randomApiUrl, { method: 'GET' });` kısmını değiştirin.

`HOST_REQUEST_CONFIG`: HOST'a göre trafiği bölmek için kullanılır. `nativeFetch` soket ile manuel olarak uygulanan HTTP isteğini belirtir, başarısız olursa otomatik olarak socks5'e geri döner. `socks5` doğrudan socks5'i kullanarak proxy isteği yapar, cloudflare kullanan web siteleri için uygun olup yeniden denemeleri önler ve performansı artırır.

`URL_PRESETS`: URL yolu eşlemeleri, örneğin `"gemini", "https://generativelanguage.googleapis.com"` eşittir `https://your-worker.workers.dev/your-token/gemini`'yi `https://generativelanguage.googleapis.com` ile eşlemeye; `https://your-worker.workers.dev/your-token/gemini` isteği, `https://your-worker.workers.dev/your-token/https://generativelanguage.googleapis.com` isteğiyle aynıdır.

### single.js Özel Yapılandırması

| Ortam Değişkeni             | Varsayılan Değer | Açıklama                                                     |
| ------------------------- | -------------- | ------------------------------------------------------------ |
| `PROXY_STRATEGY`          | `"socket"`     | **Ana proxy stratejisi**. Olası değerler: `socket`, `fetch`, `socks5` vb. |
| `FALLBACK_PROXY_STRATEGY` | `"fetch"`      | **Geri dönüş proxy stratejisi**. Ana strateji başarısız olduğunda etkinleştirilir. |
| `SOCKS5_ADDRESS`          | `""`           | SOCKS5 proxy adresi, formatı `host:port` veya `user:password@host:port`. |
| `THIRD_PARTY_PROXY_URL`   | `""`           | Üçüncü taraf HTTP proxy'sinin URL'si.                         |
| `CLOUD_PROVIDER_URL`      | `""`           | Diğer bulut hizmeti sağlayıcılarında dağıtılan uyumlu proxy URL'si. |
| `DOH_SERVER_HOSTNAME`     | `"dns.google"` | DoH sunucusunun ana bilgisayar adı.                            |
| ...                       | ...            | (Daha fazla DNS ile ilgili yapılandırma için `single.js` koduna bakın) |

## Kullanım Yöntemi

### AIGateway (AI Proxy Optimize Edilmiş Sürüm)

#### 1. URL Ön Ayarlarını Kullanma (Önerilir)
Kodda sık kullanılan AI hizmetleri için takma adlar yerleşiktir, bu en basit ve kullanışlı yöntemdir.
**URL Formatı:** `https://<Worker adresiniz>/<kimlik doğrulama belirteciniz>/<ön ayarlı takma ad>/<API yolu>`

**Örnekler:**
- **OpenAI:** `https://your-worker.workers.dev/your-token/openai`
- **Gemini:** `https://your-worker.workers.dev/your-token/gemini`

#### 2. Tam URL Kullanma
**URL Formatı:** `https://<Worker adresiniz>/<kimlik doğrulama belirteciniz>/<tam hedef URL>`

### single.js (Genel Sürüm)

Proxy işlevini belirli URL yolları oluşturarak kullanın.
**Temel URL Formatı:** `https://<Worker adresiniz>/<kimlik doğrulama belirteciniz>/<tam hedef URL>`

#### 1. HTTP/HTTPS Proxy
**URL Formatı:** `https://<YOUR_WORKER_URL>/<AUTH_TOKEN>/proxy edilecek URL (https:// veya http:// protokol başlığı dahil)`

#### 2. WebSocket (WSS) Proxy
**URL Formatı:** `wss://<YOUR_WORKER_URL>/<AUTH_TOKEN>/ws/<TARGET_WS_SERVER>`

#### 3. DoH/DOT
**URL Formatı:** `https://<YOUR_WORKER_URL>/<AUTH_TOKEN>/dns/doh veya dot` (Ayrıntılar için koda bakın)

## Uyumluluk Testi
- **Google Gemini**: ✅
- **OpenAI**: ✅
- **Anthropic Claude**: ✅
- **NewAPI / One API gibi toplama platformları**: ✅
- **GPT-LOAD**: ✅
- **Gemini-balance**: ✅

## Geliştirme Rehberi

### Proje Yapısı
(Bu yapı eksiksiz geliştirme sürümü içindir, tek dosya sürümleri tüm kodu birleştirmiştir)
```
├── README.md               # Proje açıklama belgesi
├── aigateway%.js            # AI proxy optimize edilmiş sürüm, tek dosya dağıtımı
├── single.js               # Genel sürüm, tek dosya dağıtımı
└── src/                    # Kaynak kodu dizini
    ...
```

### Üçüncü Taraf HTTP Proxy
(`single.js`'nin `thirdparty` stratejisi için geçerlidir)

Üçüncü taraf proxy'de şunları uygulamanız gerekir: Cloudflare Worker'dan özel HTTP istekleri almak, URL'deki `target` parametresini ayrıştırmak, ardından hedef sunucuya yeni bir istek göndermek ve yanıtı olduğu gibi döndürmek.

**Ana Noktalar:**
1. **`target` parametresini al**: `[Proxy URL'niz]?target=[Orijinal hedef URL]`
2. **İstek başlıklarını kaldır**: Yönlendirme sırasında `Host`, `cf-*`, `x-forwarded-*` vb. başlıkları kaldırın.
3. **Yanıtı döndür**: Hedef sunucunun yanıtını (durum kodu, başlıklar, gövde) tamamen geri gönderin, `Transfer-Encoding` başlığını kaldırın.

### Diğer Bulut Platformu Uyumlu Proxy'ler
(`single.js`'nin `cloudprovider` stratejisi için geçerlidir)

**Temel çalışma prensibi** üçüncü taraf HTTP proxy ile aynıdır, ancak genellikle Vercel, Zeabur gibi Serverless platformlarında dağıtılır. Geliştirme için `single.js` içindeki örnek koda bakabilirsiniz.

Herkese açık bir URL (örneğin `api/proxy.js`) gösterecek bir Serverless İşlevi oluşturmanız gerekir.

Cloudflare Worker bunu çağırdığında, URL'ye anahtar bir parametre **`target`** ekler, formatı: `[İşlev URL'niz]?target=[Orijinal hedef URL]`

İşlev kodunuzun `target` URL'sini, istek yöntemini, başlıkları ve gövdeyi alması gerekir. En önemli kısım, isteği `target`'a iletmek için `fetch` API'sini kullanmaktır. **Anahtar, istek başlıklarını işlemektir**:

- **`Host` başlığı kaldırılmalıdır**, çünkü `fetch` doğru `Host`'u otomatik olarak oluşturur.
- Proxy zincirini gizlemek için `cf-*` ve `x-forwarded-*` serisi başlıkların kaldırılması önerilir.

Son olarak, hedef sunucudan alınan `Response` nesnesini **doğrudan döndürmeniz** yeterlidir, Serverless platformu akışlı yanıtları otomatik ve verimli bir şekilde işleyecektir.

Örnek kod, doğrudan kullanmayın, karıştırmanız önerilir:

```
export default async function handler(request) {
  // 1. target URL'sini al
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('target');

  if (!targetUrl) {
    return new Response('Hata: "target" URL parametresi eksik.', { status: 400 });
  }

  // Güvenlik kontrolü, hedef URL'nin geçerli bir http/https URL olduğundan emin ol
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Geçersiz protokol.');
    }
  } catch (err) {
    return new Response('Hata: Geçersiz "target" URL parametresi.', { status: 400 });
  }

  // 2. Yönlendirme isteği başlığını oluştur
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host'); // fetch otomatik olarak ayarlar

  for (const [key, value] of request.headers.entries()) {
      if (key.toLowerCase().startsWith('cf-') || key.toLowerCase().startsWith('x-forwarded-')) {
          forwardHeaders.delete(key);
      }
  }

  try {
    // 3. fetch ile isteği yönlendir
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.body,
      redirect: 'manual', // fetch'in otomatik yönlendirmeyi işlemesini engellemek için ayarlanmalı
    });

    // 4. Hedef sunucudan alınan yanıtı doğrudan döndür
    return response;

  } catch (error) {
    return new Response(`Hedefe bağlanırken hata oluştu: ${error.message}`, { status: 502 });
  }
}

// Vercel Edge Runtime için ek yapılandırma gerekli
export const config = {
  runtime: 'edge',
};
```

## Değişiklik Kaydı (Changelog)

**Lütfen ziyaret edin** https://github.com/XyzenSun/SpectreProxy/blob/main/ChangeLogs.md

## Lisans

Bu proje MIT Lisansı altında lisanslanmıştır.