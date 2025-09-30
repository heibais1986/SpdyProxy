<?php
// Eşlik eden üçüncü taraf proxy PHP betiği (proxy.php)

// 1. Hedef URL'yi al
$targetUrl = isset($_GET['target']) ? $_GET['target'] : null;

if (!$targetUrl || !filter_var($targetUrl, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    die('Hata: "target" URL parametresi eksik veya geçersiz.');
}

// 2. cURL'yi başlat
$ch = curl_init();

// 3. İstek başlıklarını al ve ayarla, Cloudflare ile ilgili başlıkları kaldır
$requestHeaders = [];
$stripPrefixes = ['cf-', 'x-forwarded-', 'x-real-ip'];

foreach (getallheaders() as $key => $value) {
    $lowerKey = strtolower($key);
    $shouldStrip = false;

    // Host başlığını ve içerik uzunluğu başlığını filtrele, cURL işleyecek
    if ($lowerKey === 'host' || $lowerKey === 'content-length') {
        continue;
    }

    // Cloudflare ile ilgili başlıkları filtrele
    foreach ($stripPrefixes as $prefix) {
        if (strpos($lowerKey, $prefix) === 0) {
            $shouldStrip = true;
            break;
        }
    }

    if (!$shouldStrip) {
        $requestHeaders[] = "$key: $value";
    }
}

// 4. İstek gövdesini al (POST, PUT gibi yöntemler için)
$requestBody = file_get_contents('php://input');

// 5. cURL seçeneklerini ayarla
curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']); // İstek yöntemini ayarla
curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);             // İstek başlıklarını ayarla
curl_setopt($ch, CURLOPT_POSTFIELDS, $requestBody);                 // İstek gövdesini ayarla
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);                     // Yanıtı bir dize olarak döndür
curl_setopt($ch, CURLOPT_HEADER, true);                              // Yanıt başlıklarını dahil et
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);                     // Yeniden yönlendirmeleri otomatik olarak işleme
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);                     // Test ortamında SSL sertifika doğrulamasını devre dışı bırak
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);

// 6. cURL isteğini yürüt
$response = curl_exec($ch);
$curlError = curl_error($ch);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if ($curlError) {
    http_response_code(500);
    die("cURL Hatası: " . $curlError);
}

// 7. cURL'yi kapat
curl_close($ch);

// 8. Yanıt başlıklarını ve yanıt gövdesini ayır
$responseHeaders = substr($response, 0, $headerSize);
$responseBody = substr($response, $headerSize);

// 9. Yanıt başlıklarını gönder
// HTTP yanıt kodunu ayarla
http_response_code($httpCode);

$headers = explode("\r\n", $responseHeaders);
foreach ($headers as $header) {
    // Boş veya geçersiz başlıkları ve aktarım kodlama başlıklarını filtrele (PHP tarafından işlenir)
    if ($header && strpos(strtolower($header), 'transfer-encoding') === false) {
         header($header, false);
    }
}

// 10. Yanıt gövdesini gönder
echo $responseBody;

?>