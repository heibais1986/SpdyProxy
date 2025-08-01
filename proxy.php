<?php
// 配套的第三方代理PHP脚本 (proxy.php)

// 1. 获取目标URL
$targetUrl = isset($_GET['target']) ? $_GET['target'] : null;

if (!$targetUrl || !filter_var($targetUrl, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    die('Error: Missing or invalid "target" URL parameter.');
}

// 2. 初始化 cURL
$ch = curl_init();

// 3. 获取并设置请求头，同时剥离Cloudflare相关的头
$requestHeaders = [];
$stripPrefixes = ['cf-', 'x-forwarded-', 'x-real-ip'];

foreach (getallheaders() as $key => $value) {
    $lowerKey = strtolower($key);
    $shouldStrip = false;

    // 过滤掉主机头和内容长度头，cURL会处理
    if ($lowerKey === 'host' || $lowerKey === 'content-length') {
        continue;
    }

    // 过滤掉Cloudflare相关的头
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

// 4. 获取请求体 (适用于 POST, PUT 等方法)
$requestBody = file_get_contents('php://input');

// 5. 设置 cURL 选项
curl_setopt($ch, CURLOPT_URL, $targetUrl);
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $_SERVER['REQUEST_METHOD']); // 设置请求方法
curl_setopt($ch, CURLOPT_HTTPHEADER, $requestHeaders);             // 设置请求头
curl_setopt($ch, CURLOPT_POSTFIELDS, $requestBody);                 // 设置请求体
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);                     // 将响应作为字符串返回
curl_setopt($ch, CURLOPT_HEADER, true);                              // 包含响应头
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);                     // 不自动处理重定向
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);                     // 在测试环境中禁用SSL证书验证
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, false);

// 6. 执行 cURL 请求
$response = curl_exec($ch);
$curlError = curl_error($ch);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

if ($curlError) {
    http_response_code(500);
    die("cURL Error: " . $curlError);
}

// 7. 关闭 cURL
curl_close($ch);

// 8. 分离响应头和响应体
$responseHeaders = substr($response, 0, $headerSize);
$responseBody = substr($response, $headerSize);

// 9. 发送响应头
// 设置HTTP响应码
http_response_code($httpCode);

$headers = explode("\r\n", $responseHeaders);
foreach ($headers as $header) {
    // 过滤掉空的或无效的头，以及传输编码头（由PHP处理）
    if ($header && strpos(strtolower($header), 'transfer-encoding') === false) {
         header($header, false);
    }
}

// 10. 发送响应体
echo $responseBody;

?>