package com.nowen.note;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Keeps attachment media same-origin from WebView's perspective while streaming bytes from a
 * signed self-hosted URL. Android WebView can block http media requested by Capacitor's
 * https://localhost page before the request reaches the server, even though JSON requests work
 * through CapacitorHttp. The proxy preserves Range/206 semantics without buffering the video.
 */
public final class NowenBridgeWebViewClient extends BridgeWebViewClient {
  private static final String MEDIA_PROXY_PATH = "/_nowen_attachment_media";

  public NowenBridgeWebViewClient(Bridge bridge) {
    super(bridge);
  }

  @Override
  public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    Uri requestUri = request.getUrl();
    if (!MEDIA_PROXY_PATH.equals(requestUri.getPath())) {
      return super.shouldInterceptRequest(view, request);
    }

    String targetValue = requestUri.getQueryParameter("url");
    Uri target = targetValue == null ? null : Uri.parse(targetValue);
    if (!isAllowedSignedAttachment(target)) {
      return errorResponse(400, "Bad Request");
    }

    try {
      HttpURLConnection connection = (HttpURLConnection) new URL(target.toString()).openConnection();
      connection.setConnectTimeout(10_000);
      connection.setReadTimeout(30_000);
      connection.setInstanceFollowRedirects(true);
      connection.setRequestMethod("GET");
      connection.setRequestProperty("Accept-Encoding", "identity");
      forwardHeader(request, connection, "Range");
      forwardHeader(request, connection, "If-None-Match");
      forwardHeader(request, connection, "If-Modified-Since");
      forwardHeader(request, connection, "User-Agent");

      int statusCode = connection.getResponseCode();
      InputStream responseStream = statusCode >= 400
        ? connection.getErrorStream()
        : connection.getInputStream();
      if (responseStream == null) responseStream = new ByteArrayInputStream(new byte[0]);

      String contentType = connection.getContentType();
      String mimeType = contentType == null ? "application/octet-stream" : contentType.split(";", 2)[0].trim();
      Map<String, String> responseHeaders = flattenHeaders(connection.getHeaderFields());
      InputStream disconnectingStream = new DisconnectingInputStream(responseStream, connection);
      return new WebResourceResponse(
        mimeType,
        null,
        statusCode,
        reasonPhrase(statusCode, connection.getResponseMessage()),
        responseHeaders,
        disconnectingStream
      );
    } catch (Exception error) {
      return errorResponse(502, "Bad Gateway");
    }
  }

  private static boolean isAllowedSignedAttachment(Uri target) {
    if (target == null || target.getHost() == null) return false;
    String scheme = target.getScheme();
    if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
    String path = target.getPath();
    return path != null
      && path.matches("^/api/attachments/[0-9a-fA-F-]{36}$")
      && target.getQueryParameter("exp") != null
      && target.getQueryParameter("sig") != null
      && target.getQueryParameter("scope") != null;
  }

  private static void forwardHeader(
    WebResourceRequest request,
    HttpURLConnection connection,
    String name
  ) {
    String value = request.getRequestHeaders().get(name);
    if (value == null) value = request.getRequestHeaders().get(name.toLowerCase());
    if (value != null && !value.isEmpty()) connection.setRequestProperty(name, value);
  }

  private static Map<String, String> flattenHeaders(Map<String, List<String>> source) {
    Map<String, String> result = new LinkedHashMap<>();
    for (Map.Entry<String, List<String>> entry : source.entrySet()) {
      if (entry.getKey() == null || entry.getValue() == null) continue;
      result.put(entry.getKey(), String.join(", ", entry.getValue()));
    }
    return result;
  }

  private static String reasonPhrase(int statusCode, String value) {
    if (value != null && !value.trim().isEmpty()) return value;
    if (statusCode == 200) return "OK";
    if (statusCode == 206) return "Partial Content";
    if (statusCode == 304) return "Not Modified";
    if (statusCode == 400) return "Bad Request";
    if (statusCode == 401) return "Unauthorized";
    if (statusCode == 403) return "Forbidden";
    if (statusCode == 404) return "Not Found";
    return statusCode >= 500 ? "Bad Gateway" : "Response";
  }

  private static WebResourceResponse errorResponse(int statusCode, String reason) {
    byte[] body = reason.getBytes(StandardCharsets.UTF_8);
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Cache-Control", "no-store");
    headers.put("Content-Length", String.valueOf(body.length));
    return new WebResourceResponse(
      "text/plain",
      "UTF-8",
      statusCode,
      reason,
      headers,
      new ByteArrayInputStream(body)
    );
  }

  private static final class DisconnectingInputStream extends FilterInputStream {
    private final HttpURLConnection connection;

    private DisconnectingInputStream(InputStream input, HttpURLConnection connection) {
      super(input);
      this.connection = connection;
    }

    @Override
    public void close() throws IOException {
      try {
        super.close();
      } finally {
        connection.disconnect();
      }
    }
  }
}
