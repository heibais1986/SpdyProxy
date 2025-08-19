# 项目变更记录

## 2025-08-19

### ✨ 新增功能 (feat)

1.  **实现 AI API 专用代理 (`AIGateway`)**
    *   **核心能力**: 实现了专为 AI API 设计的高级代理，完美支持流式传输。
    *   **智能路由**: 可根据目标域名（如 `api.openai.com`）自动选择 `SOCKS5` 代理或直连，提升性能和成功率。
    *   **故障回退与重试**:
        *   支持 SOCKS5 作为直连失败后的备用方案 (`Fallback`)。
        *   对幂等请求（如 GET）在遇到 5xx 错误时自动进行指数退避重试。
    *   **灵活配置**:
        *   支持从多个来源动态获取 SOCKS5 代理并随机选用。
        *   支持 URL 预设 (`/openai`, `/gemini`)，简化请求路径。
    *   **请求伪装**:
        *   支持随机化 `User-Agent` 和 `Accept-Language` 请求头。
        *   能够根据原始请求的 UA 类型（移动/桌面）智能匹配兼容的 UA。

2.  **探索 SNI 代理模式 (部分实现)**
    *   在 `AIGatewayWithProxyIP半成品.js` 文件中，尝试了通过反代 Cloudflare IP 实现 SNI 代理的方案。
    *   **开发思路**:
        *   通过内置的 DoH 解析获取目标域名的真实 IP。
        *   维护一个指向可用反代 IP 的域名。(设置较短的TTL，实现简陋的负载均衡)
        *   借鉴 `edgetunnel` 的思路，在请求失败时克隆 `socket`，将其转发至反代 IP 并保持原始 `Host` 头。
    *   **当前障碍**: 在 TLS 握手后出现 `Stream was cancelled` 错误，且暂无稳定获取可用反代 IP 的自动化方案。

3.  **明确 `single.js` 的未来开发方向**
    *   `single.js` 将主要面向注重隐私保护的普通用户。
    *   将优先考虑支持更多协议，而非极致的性能优化。
    *   在对隐私要求不高的场景，将优先使用原生 `fetch` API，以降低 `socket` 编程带来的复杂性。

### 🐛 问题修复 (bugfix)

1.  修复了在特定场景下流式传输可能中断或不完整的问题。

### 🗑️ 废弃与移除 (drop)

1.  `single.js`**废弃 `proxyip` (SNI 代理) 模式**
    *   **原因**: 维护一个稳定、可用的反代 IP 池非常困难且耗时。此模式已从 `single.js` 中移除。
    *   **参考实现**: 对此技术感兴趣的开发者，可以参考 `AIGatewayWithProxyIP半成品.js` 中的探索性代码。

2.  **放弃实现连接池**
    *   **原因**: 遇到了 Cloudflare Workers 的核心安全限制——`"Cannot perform I/O on behalf of a different request"` 错误。
    *   **技术细节**: 一个请求创建的 `socket` 无法被另一个独立的请求复用。可以通过 `Durable Objects` 等方式绕过，但这会引入新的复杂性，并且泄露请求头等敏感信息，违背了隐私保护的初衷。

3.  **在 `AIGateway` 中移除 WebSocket 支持**
    *   **原因**:
        *   **应用场景窄**: 在主流 AI API (OpenAI, Gemini) 中，WebSocket 主要用于实时语音等少数场景，用户基数较小。
        *   **要求严苛**: 实时应用对延迟和稳定性要求高。
        *   **兼容性未知**: 无法保证所用的 SOCKS5 服务端或反代 IP 会稳定支持 WebSocket 协议。
    *   **替代方案**: 有 WebSocket 代理需求的用户请使用 `single.js`。



