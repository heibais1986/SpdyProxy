import { connect } from'cloudflare:sockets';

constCONFIG = {
    upstream_url_base: "https://generativelanguage.googleapis.com",
    max_consecutive_retries: 3,
    debug_mode: true,
    retry_delay_ms: 750,
    log_truncation_limit: 8000,
    use_socket_proxy: true
  };

constNON_RETRYABLE_STATUSES = newSet([400, 401, 403, 404, 429]);

classBaseProxy {
    constructor(config = {}) {
      this.config = config;
      this.encoder = newTextEncoder();
      this.decoder = newTextDecoder();
      
      this.log = config.debug_mode
        ? (message, data = "") =>console.log(`[PROXY DEBUG] ${message}`, data)
        : () => {};
    }

    asyncconnect(req, dstUrl) {
      thrownewError("connect method must be implemented by subclass");
    }

    asyncconnectHttp(req, dstUrl) {
      thrownewError("connectHttp method must be implemented by subclass");
    }

    handleError(error, context, status = 500) {
      this.log(`${context} failed`, error.message);
      returnnewResponse(`Error ${context.toLowerCase()}: ${error.message}`, { status });
    }

    isCloudflareNetworkError(error) {
      returnfalse;
    }

    filterHeaders(headers) {
      constHEADER_FILTER_RE = /^(host|accept-encoding|cf-|cdn-|referer|referrer)/i;
      const cleanedHeaders = newHeaders();
      
      for (const [k, v] of headers) {
        if (!HEADER_FILTER_RE.test(k)) {
          cleanedHeaders.set(k, v);
        }
      }
      
      return cleanedHeaders;
    }

    concatUint8Arrays(...arrays) {
      const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
      const result = newUint8Array(total);
      let offset = 0;
      for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
      }
      return result;
    }

    parseHttpHeaders(buff) {
      const text = this.decoder.decode(buff);
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd === -1) returnnull;
      const headerSection = text.slice(0, headerEnd).split("\r\n");
      const statusLine = headerSection[0];
      const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+) (.*)/);
      if (!statusMatch) thrownewError(`Invalid status line: ${statusLine}`);
      const headers = newHeaders();
      for (let i = 1; i < headerSection.length; i++) {
        const line = headerSection[i];
        const idx = line.indexOf(": ");
        if (idx !== -1) {
          headers.append(line.slice(0, idx), line.slice(idx + 2));
        }
      }
      return { status: Number(statusMatch[1]), statusText: statusMatch[2], headers, headerEnd };
    }

    asyncreadUntilDoubleCRLF(reader) {
      let respText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          respText += this.decoder.decode(value, { stream: true });
          if (respText.includes("\r\n\r\n")) break;
        }
        if (done) break;
      }
      return respText;
    }

    asyncparseResponse(reader) {
      let buff = newUint8Array();
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          buff = this.concatUint8Arrays(buff, value);
          const parsed = this.parseHttpHeaders(buff);
          if (parsed) {
            const { status, statusText, headers, headerEnd } = parsed;
            const isChunked = headers.get("transfer-encoding")?.includes("chunked");
            const contentLength = parseInt(headers.get("content-length") || "0", 10);
            const data = buff.slice(headerEnd + 4);
            const self = this;
            returnnewResponse(
              newReadableStream({
                start: async (ctrl) => {
                  try {
                    if (isChunked) {
                      console.log("Using chunked transfer mode");
                      forawait (const chunk of self.readChunks(reader, data)) {
                        ctrl.enqueue(chunk);
                      }
                    } else {
                      console.log("Using fixed-length transfer mode, contentLength: " + contentLength);
                      let received = data.length;
                      if (data.length) ctrl.enqueue(data);
                      while (received < contentLength) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        received += value.length;
                        ctrl.enqueue(value);
                      }
                    }
                    ctrl.close();
                  } catch (err) {
                    console.log("Error parsing response", err);
                    ctrl.error(err);
                  }
                },
              }),
              { status, statusText, headers }
            );
          }
        }
        if (done) break;
      }
      thrownewError("Unable to parse response headers");
    }

    async *readChunks(reader, buff = new Uint8Array()) {
      while (true) {
        let pos = -1;
        for (let i = 0; i < buff.length - 1; i++) {
          if (buff[i] === 13 && buff[i + 1] === 10) {
            pos = i;
            break;
          }
        }
        if (pos === -1) {
          const { value, done } = await reader.read();
          if (done) break;
          buff = this.concatUint8Arrays(buff, value);
          continue;
        }
        const sizeStr = this.decoder.decode(buff.slice(0, pos));
        const size = parseInt(sizeStr, 16);
        this.log("Read chunk size", size);
        if (!size) break;
        buff = buff.slice(pos + 2);
        while (buff.length < size + 2) {
          const { value, done } = await reader.read();
          if (done) thrownewError("Unexpected EOF in chunked encoding");
          buff = this.concatUint8Arrays(buff, value);
        }
        yield buff.slice(0, size);
        buff = buff.slice(size + 2);
      }
    }
  }

classSocketProxyextendsBaseProxy {
    constructor(config) {
      super(config);
    }

    asyncconnect(req, dstUrl) {
      const upgradeHeader = req.headers.get("Upgrade")?.toLowerCase();
      const isWebSocket = upgradeHeader === "websocket";
      
      if (isWebSocket) {
        returnnewResponse("WebSocket not supported via socket proxy", { status: 400 });
      } else {
        returnawaitthis.connectHttp(req, dstUrl);
      }
    }

    asyncconnectHttp(req, dstUrl) {
      const targetUrl = newURL(dstUrl);
      
      const cleanedHeaders = this.filterHeaders(req.headers);
      
      cleanedHeaders.set("Host", targetUrl.hostname);
      cleanedHeaders.set("accept-encoding", "identity");
      
      // 计算请求体长度并设置 Content-Length
      let bodyBytes = null;
      let contentLength = 0;
      if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
        const bodyReader = req.body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await bodyReader.read();
          if (done) break;
          chunks.push(value);
          contentLength += value.length;
        }
        bodyBytes = newUint8Array(contentLength);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
        cleanedHeaders.set("Content-Length", contentLength.toString());
      } elseif (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        // 对于 POST/PUT/PATCH 请求，即使没有 body 也设置 Content-Length: 0
        cleanedHeaders.set("Content-Length", "0");
      }
    
      try {
        const port = targetUrl.protocol === "https:" ? 443 : 80;
        const socket = awaitconnect(
          { hostname: targetUrl.hostname, port: Number(port) },
          { secureTransport: targetUrl.protocol === "https:" ? "on" : "off", allowHalfOpen: false }
        );
        const writer = socket.writable.getWriter();
        
        const requestLine =
          `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n` +
          Array.from(cleanedHeaders.entries())
            .map(([k, v]) =>`${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n";
        
        this.log("Sending request", requestLine);
        await writer.write(this.encoder.encode(requestLine));
      
        if (bodyBytes && bodyBytes.length > 0) {
          this.log(`Forwarding request body (${bodyBytes.length} bytes)`);
          await writer.write(bodyBytes);
        }
        
        returnawaitthis.parseResponse(socket.readable.getReader());
      } catch (error) {
        if (this.isCloudflareNetworkError(error)) {
          this.log("Cloudflare network restriction detected, falling back to fetch");
          this.log("Original error:", error.message);
          
          const cleanedHeaders = this.filterHeaders(req.headers);
          cleanedHeaders.set("Host", targetUrl.hostname);
          
          const fallbackRequest = newRequest(dstUrl, {
            method: req.method,
            headers: cleanedHeaders,
            body: bodyBytes,
          });
          
          this.log("Using fetch fallback to connect to", dstUrl);
          returnawaitfetch(fallbackRequest);
        }
        
        returnthis.handleError(error, "Socket connection");
      }
    }

    isCloudflareNetworkError(error) {
      return error.message && (
        error.message.includes("A network issue was detected") ||
        error.message.includes("Network connection failure") ||
        error.message.includes("connection failed") ||
        error.message.includes("timed out") ||
        error.message.includes("Stream was cancelled") ||
        error.message.includes("proxy request failed") ||
        error.message.includes("cannot connect to the specified address") ||
        error.message.includes("TCP Loop detected") ||
        error.message.includes("Connections to port 25 are prohibited")
      );
    }
  }

const socketProxy = newSocketProxy(CONFIG);

asyncfunctionmakeUpstreamRequest(url, options) {
    if (CONFIG.use_socket_proxy) {
      logDebug("Using SocketProxy for upstream request");
      try {
        const request = newRequest(url, options);
        returnawait socketProxy.connect(request, url);
      } catch (error) {
        logError("SocketProxy failed, falling back to fetch:", error.message);
        returnawaitfetch(url, options);
      }
    } else {
      logDebug("Using direct fetch for upstream request");
      returnawaitfetch(url, options);
    }
  }

constlogDebug = (...args) => { if (CONFIG.debug_mode) console.log(`[DEBUG ${new Date().toISOString()}]`, ...args); };
constlogInfo  = (...args) => console.log(`[INFO ${new Date().toISOString()}]`, ...args);
constlogError = (...args) => console.error(`[ERROR ${new Date().toISOString()}]`, ...args);

consttruncate = (s, n = CONFIG.log_truncation_limit) => {
    if (typeof s !== "string") return s;
    return s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s;
  };

consthandleOPTIONS = () => newResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Goog-Api-Key",
    },
  });

constjsonError = (status, message, details = null) => {
    returnnewResponse(JSON.stringify({ error: { code: status, message, status: statusToGoogleStatus(status), details } }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  };

functionstatusToGoogleStatus(code) {
    if (code === 400) return"INVALID_ARGUMENT";
    if (code === 401) return"UNAUTHENTICATED";
    if (code === 403) return"PERMISSION_DENIED";
    if (code === 404) return"NOT_FOUND";
    if (code === 429) return"RESOURCE_EXHAUSTED";
    if (code === 500) return"INTERNAL";
    if (code === 503) return"UNAVAILABLE";
    if (code === 504) return"DEADLINE_EXCEEDED";
    return"UNKNOWN";
  }

functionbuildUpstreamHeaders(reqHeaders) {
    const h = newHeaders();
    constcopy = (k) => { const v = reqHeaders.get(k); if (v) h.set(k, v); };
    copy("authorization");
    copy("x-goog-api-key");
    copy("content-type");
    copy("accept");
    return h;
  }

asyncfunctionstandardizeInitialError(initialResponse, requestInfo = {}) {
    let upstreamText = "";
    let reader = null;
    try {
      reader = initialResponse.body?.getReader();
      if (reader) {
        const chunks = [];
        const decoder = newTextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
        upstreamText = chunks.join('');
        logError(`Upstream error body: ${truncate(upstreamText)}`);
      }
    } catch (e) {
      logError(`Failed to read upstream error text: ${e.message}`);
    } finally {
      if (reader) {
        try {
          reader.releaseLock();
        } catch (e) {
          logDebug(`Reader release failed: ${e.message}`);
        }
      }
    }

    let standardized = null;
    if (upstreamText) {
      try {
        const parsed = JSON.parse(upstreamText);
        if (parsed && parsed.error && typeof parsed.error === "object" && typeof parsed.error.code === "number") {
          if (!parsed.error.status) parsed.error.status = statusToGoogleStatus(parsed.error.code);
          standardized = parsed;
        }
      } catch (_) {}
    }

    if (!standardized) {
      const code = initialResponse.status;
      const message = code === 429 ? "Resource has been exhausted (e.g. check quota)." : (initialResponse.statusText || "Request failed");
      const status = statusToGoogleStatus(code);
      standardized = {
        error: {
          code,
          message,
          status,
          details: upstreamText ? [{ 
            "@type": "proxy.upstream", 
            upstream_error: truncate(upstreamText),
            request_url: requestInfo.url,
            request_method: requestInfo.method,
            request_body: requestInfo.body ? truncate(requestInfo.body, 2000) : undefined
          }] : undefined
        }
      };
    }

    const safeHeaders = newHeaders();
    safeHeaders.set("Content-Type", "application/json; charset=utf-8");
    safeHeaders.set("Access-Control-Allow-Origin", "*");
    safeHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Goog-Api-Key");
    const retryAfter = initialResponse.headers.get("Retry-After");
    if (retryAfter) safeHeaders.set("Retry-After", retryAfter);

    returnnewResponse(JSON.stringify(standardized), {
      status: initialResponse.status,
      statusText: initialResponse.statusText,
      headers: safeHeaders
    });
  }

constSSE_ENCODER = newTextEncoder();
asyncfunctionwriteSSEErrorFromUpstream(writer, upstreamResp, requestInfo = {}) {
    const std = awaitstandardizeInitialError(upstreamResp, requestInfo);
    let text = await std.text();
    const ra = upstreamResp.headers.get("Retry-After");
    if (ra) {
      try {
        const obj = JSON.parse(text);
        obj.error.details = (obj.error.details || []).concat([{ "@type": "proxy.retry", retry_after: ra }]);
        text = JSON.stringify(obj);
      } catch (_) {}
    }
    await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${text}\n\n`));
  }

asyncfunction* sseLineIterator(reader) {
    const decoder = newTextDecoder("utf-8");
    let buffer = "";
    logDebug("Starting SSE line iteration.");
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logDebug(`SSE stream ended. Remaining buffer: "${buffer.trim()}"`);
        if (buffer.trim()) yield buffer;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          yield line;
        }
      }
    }
  }

functionbuildRetryRequestBody(originalBody, accumulatedText) {
    logDebug(`Building retry request. Accumulated text length: ${accumulatedText.length}`);
    logDebug(`Accumulated text preview (includes thoughts): ${truncate(accumulatedText, 500)}`);
    
    const retryBody = JSON.parse(JSON.stringify(originalBody));
    if (!retryBody.contents) retryBody.contents = [];

    const lastUserIndex = retryBody.contents.map(c => c.role).lastIndexOf("user");

    const history = [
      { role: "model", parts: [{ text: accumulatedText }] },
      { role: "user", parts: [{ text: "Continue exactly where you left off, providing the final answer without repeating the previous thinking steps." }] }
    ];

    if (lastUserIndex !== -1) {
      retryBody.contents.splice(lastUserIndex + 1, 0, ...history);
    } else {
      retryBody.contents.push(...history);
    }
    
    logDebug(`Constructed retry request body: ${truncate(JSON.stringify(retryBody))}`);
    return retryBody;
  }

// [REFACTORED] Core logic updated to handle premature STOP after 'thoughts'.
asyncfunctionprocessStreamAndRetryInternally({ initialReader, writer, originalRequestBody, upstreamUrl, originalHeaders }) {
    let accumulatedText = "";
    let consecutiveRetryCount = 0;
    let currentReader = initialReader;
    const sessionStartTime = Date.now();

    logInfo(`Starting stream processing session. Max retries: ${CONFIG.max_consecutive_retries}`);

    constcleanup = (reader) => { 
      if (reader) { 
        logDebug("Cancelling and releasing reader");
        try {
          reader.cancel().catch(() => {});
          reader.releaseLock();
        } catch (e) {
          logDebug(`Reader cleanup failed: ${e.message}`);
        }
      } 
    };

    while (true) {
      let interruptionReason = null; // e.g. "DROP", "STOP_WITHOUT_ANSWER", "FETCH_ERROR"
      const streamStartTime = Date.now();
      let linesInThisStream = 0;
      let textInThisStream = "";
      let reasoningStepDetected = false;
      
      // [MODIFIED] This new flag is critical for detecting premature STOP.
      let hasReceivedFinalAnswerContent = false;

      logInfo(`=== Starting stream attempt ${consecutiveRetryCount + 1}/${CONFIG.max_consecutive_retries + 1} ===`);

      try {
        let finishReasonArrived = false;

        forawait (const line ofsseLineIterator(currentReader)) {
          linesInThisStream++;
          await writer.write(newTextEncoder().encode(line + "\n\n"));
          logDebug(`SSE Line ${linesInThisStream}: ${truncate(line, 500)}`);

          if (!line.startsWith("data: ")) continue;

          let payload;
          try {
            payload = JSON.parse(line.slice(6));
          } catch (e) {
            logDebug("Ignoring non-JSON data line.");
            continue;
          }

          const candidate = payload?.candidates?.[0];
          if (!candidate) continue;

          // 1. Process content parts (text, thoughts, tool calls).
          const parts = candidate.content?.parts;
          if (parts && Array.isArray(parts)) {
            for (const part of parts) {
              // We accumulate ALL text (including thoughts) for the retry context.
              if (typeof part.text === 'string') {
                accumulatedText += part.text;
                textInThisStream += part.text;

                // [MODIFIED] But we only set the success flag if it's NOT a thought.
                if (part.thought !== true) {
                  hasReceivedFinalAnswerContent = true;
                  logDebug("Received final answer content (non-thought part).");
                } else {
                  logDebug("Received 'thought' content part.");
                }
              } elseif (part.functionCall || part.toolCode) {
                reasoningStepDetected = true;
                logInfo(`Reasoning step detected (tool/function call): ${truncate(JSON.stringify(part))}`);
              }
            }
          }

          // 2. Process the finish reason with the new logic.
          const finishReason = candidate.finishReason;
          if (finishReason) {
              finishReasonArrived = true;
              logInfo(`Finish reason received: ${finishReason}`);

              if (finishReason === "STOP") {
                  // [MODIFIED] CRITICAL CHECK: Did we get the actual answer, or just thoughts?
                  if (hasReceivedFinalAnswerContent) {
                      const sessionDuration = Date.now() - sessionStartTime;
                      logInfo(`=== STREAM COMPLETED SUCCESSFULLY (Reason: STOP after receiving final answer) ===`);
                      logInfo(`  - Total session duration: ${sessionDuration}ms, Retries: ${consecutiveRetryCount}`);
                      return writer.close();
                  } else {
                      logError(`Stream finished with STOP but no final answer content was received. This is a failure.`);
                      interruptionReason = "STOP_WITHOUT_ANSWER";
                      break; // Exit loop to trigger retry.
                  }
              } elseif (finishReason === "MAX_TOKENS" || finishReason === "TOOL_CODE" || finishReason === "SAFETY" || finishReason === "RECITATION") {
                   // Other terminal reasons are handled as final. MAX_TOKENS is a valid, though incomplete, end.
                   logInfo(`Stream terminated with reason: ${finishReason}. Closing stream.`);
                   return writer.close();
              } else {
                   logError(`Abnormal/unknown finish reason: ${finishReason}`);
                   interruptionReason = "FINISH_ABNORMAL";
                   break;
              }
          }
        }

        if (!finishReasonArrived && !interruptionReason) {
          logError(`Stream ended prematurely without a finish reason (DROP).`);
          interruptionReason = reasoningStepDetected ? "DROP_DURING_REASONING" : "DROP";
        }

      } catch (e) {
        logError(`Exception during stream processing:`, e.message, e.stack);
        interruptionReason = "FETCH_ERROR";
      } finally {
        cleanup(currentReader);
        logInfo(`Stream attempt ${consecutiveRetryCount + 1} summary: Duration: ${Date.now() - streamStartTime}ms, ` + 
                `Lines: ${linesInThisStream}, Chars: ${textInThisStream.length}, Total Chars: ${accumulatedText.length}`);
      }

      if (!interruptionReason) {
        logInfo("Stream finished without interruption. Closing.");
        return writer.close();
      }

      logError(`=== STREAM INTERRUPTED (Reason: ${interruptionReason}) ===`);
      
      if (consecutiveRetryCount >= CONFIG.max_consecutive_retries) {
        logError("Retry limit exceeded. Sending final error to client.");
        const payload = {
          error: { code: 504, status: "DEADLINE_EXCEEDED", message: `Proxy retry limit (${CONFIG.max_consecutive_retries}) exceeded. Last interruption: ${interruptionReason}.`}
        };
        await writer.write(SSE_ENCODER.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
        return writer.close();
      }

      consecutiveRetryCount++;
      logInfo(`Proceeding to retry attempt ${consecutiveRetryCount}...`);

      try {
        if (CONFIG.retry_delay_ms > 0) {
          logDebug(`Waiting ${CONFIG.retry_delay_ms}ms before retrying...`);
          awaitnewPromise(res =>setTimeout(res, CONFIG.retry_delay_ms));
        }
        
        const retryBody = buildRetryRequestBody(originalRequestBody, accumulatedText);
        const retryHeaders = buildUpstreamHeaders(originalHeaders);

        logDebug(`Making retry request to: ${upstreamUrl}`);
        const retryResponse = awaitmakeUpstreamRequest(upstreamUrl, { method: "POST", headers: retryHeaders, body: JSON.stringify(retryBody) });
        logInfo(`Retry request completed. Status: ${retryResponse.status} ${retryResponse.statusText}`);

        if (NON_RETRYABLE_STATUSES.has(retryResponse.status)) {
          logError(`FATAL: Received non-retryable status ${retryResponse.status} during retry.`);
          awaitwriteSSEErrorFromUpstream(writer, retryResponse, { 
            url: upstreamUrl, 
            method: "POST", 
            body: JSON.stringify(retryBody) 
          });
          return writer.close();
        }

        if (!retryResponse.ok || !retryResponse.body) {
          thrownewError(`Upstream server error on retry: ${retryResponse.status}`);
        }
        
        logInfo(`✓ Retry successful. Got new stream.`);
        currentReader = retryResponse.body.getReader();
      } catch (e) {
        logError(`Exception during retry setup:`, e.message);
      }
    }
  }

asyncfunctionhandleStreamingPost(request) {
      const urlObj = newURL(request.url);
      const upstreamUrl = `${CONFIG.upstream_url_base}${urlObj.pathname}${urlObj.search}`;
    
      logInfo(`=== NEW STREAMING REQUEST: ${request.method} ${request.url} ===`);
    
      let originalRequestBody;
      let requestBody = null;
      try {
        requestBody = request.body ? await request.text() : '{}';
        logInfo(`Request body (raw, ${requestBody.length} bytes): ${truncate(requestBody)}`);
        originalRequestBody = JSON.parse(requestBody);
    
        if (Array.isArray(originalRequestBody.contents)) {
          logInfo(`Request contains ${originalRequestBody.contents.length} messages:`);
          originalRequestBody.contents.forEach((m, i) => {
            const role = m?.role || "unknown";
            const partsText = (m?.parts || []).map(p => p.text || "[non-text part]").join("\n");
            logInfo(`  [${i}] role=${role}, text: ${truncate(partsText, 1000)}`);
          });
        }
    
      } catch (e) {
        logError("Failed to parse request body:", e.message);
        returnjsonError(400, "Invalid JSON in request body", e.message);
      }
    
      logInfo("=== MAKING INITIAL REQUEST TO UPSTREAM ===");
      const t0 = Date.now();
      const initialResponse = awaitmakeUpstreamRequest(upstreamUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(request.headers),
        body: requestBody,
        duplex: "half"
      });
      logInfo(`Initial upstream response received in ${Date.now() - t0}ms. Status: ${initialResponse.status}`);
    
      if (!initialResponse.ok) {
        logError(`Initial request failed with status ${initialResponse.status}.`);
        returnawaitstandardizeInitialError(initialResponse, { 
          url: upstreamUrl, 
          method: request.method, 
          body: requestBody 
        });
      }
    
      const initialReader = initialResponse.body?.getReader();
      if (!initialReader) {
        returnjsonError(502, "Bad Gateway", "Upstream returned a success code but the response body is missing.");
      }
    
      logInfo("✓ Initial request successful. Starting stream processing.");
      const { readable, writable } = newTransformStream();
      
      processStreamAndRetryInternally({
        initialReader,
        writer: writable.getWriter(),
        originalRequestBody,
        upstreamUrl,
        originalHeaders: request.headers
      }).catch(e => {
        logError("!!! UNHANDLED CRITICAL EXCEPTION IN STREAM PROCESSOR !!!", e.message, e.stack);
        try { writable.getWriter().close(); } catch (_) {}
      });
    
      returnnewResponse(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    
    asyncfunctionhandleNonStreaming(request) {
      const url = newURL(request.url);
      const upstreamUrl = `${CONFIG.upstream_url_base}${url.pathname}${url.search}`;
      logInfo(`=== NEW NON-STREAMING REQUEST: ${request.method} ${request.url} ===`);
    
      let requestBody = null;
      if (request.body) {
        try {
          requestBody = await request.text();
        } catch (e) {
          logError("Failed to read request body:", e.message);
        }
      }
    
      const resp = awaitmakeUpstreamRequest(upstreamUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(request.headers),
        body: requestBody,
        duplex: 'half',
      });
      if (!resp.ok) returnawaitstandardizeInitialError(resp, { 
        url: upstreamUrl, 
        method: request.method, 
        body: requestBody 
      });
    
      const headers = newHeaders(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      returnnewResponse(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }
    
    exportdefault {
      asyncfetch(request, env) {
        try {
          Object.assign(CONFIG, env);
          if (request.method === "OPTIONS") returnhandleOPTIONS();
          const url = newURL(request.url);
          // [MODIFIED] Simplified stream detection
          const isStream = url.searchParams.get("alt") === "sse";
          if (request.method === "POST" && isStream) {
            returnawaithandleStreamingPost(request);
          }
          returnawaithandleNonStreaming(request);
        } catch (e) {
          logError("!!! TOP-LEVEL WORKER EXCEPTION !!!", e.message, e.stack);
          returnjsonError(500, "Internal Server Error", "The proxy worker encountered a critical error.");
        }
      },
    };
