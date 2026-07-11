package com.nowen.note;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Android share target bridge.
 *
 * Responsibilities:
 * - capture ACTION_SEND / ACTION_SEND_MULTIPLE / ACTION_VIEW;
 * - immediately copy content:// bytes into app-private storage;
 * - persist the pending queue across login, process recreation and app restart;
 * - stream uploads to the existing Nowen attachment endpoints with progress events;
 * - clean private temporary files only after the renderer confirms completion/discard.
 */
@CapacitorPlugin(name = "ShareImport")
public class ShareImportPlugin extends Plugin {
    private static final String PREFS_NAME = "nowen_share_import_v1";
    private static final String PREFS_QUEUE = "pending_payloads";
    private static final String HANDLED_EXTRA = "com.nowen.note.SHARE_INTENT_HANDLED";
    private static final String PENDING_DIR = "pending-share-imports";
    private static final int MAX_PAYLOADS = 20;
    private static final int MAX_ITEMS_PER_PAYLOAD = 100;
    private static final long MAX_FILE_BYTES = 1024L * 1024L * 1024L;
    private static final long MAX_PENDING_BYTES = 2L * 1024L * 1024L * 1024L;
    private static final long MAX_AGE_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int COPY_BUFFER = 64 * 1024;
    private static final int SNIFF_BYTES = 512;
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;
    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s<>{}\\[\\]\\\"]+", Pattern.CASE_INSENSITIVE);
    private static final Object QUEUE_LOCK = new Object();
    private static final ExecutorService CAPTURE_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ExecutorService UPLOAD_EXECUTOR = Executors.newCachedThreadPool();
    private static final ConcurrentHashMap<String, HttpURLConnection> ACTIVE_UPLOADS = new ConcurrentHashMap<>();
    private static volatile WeakReference<ShareImportPlugin> activePlugin = new WeakReference<>(null);

    @Override
    public void load() {
        activePlugin = new WeakReference<>(this);
    }

    /** Called by MainActivity for both cold-start and singleTask onNewIntent deliveries. */
    public static void captureIntent(Activity activity, Intent intent) {
        if (activity == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action)
            && !Intent.ACTION_SEND_MULTIPLE.equals(action)
            && !Intent.ACTION_VIEW.equals(action)) return;
        if (intent.getBooleanExtra(HANDLED_EXTRA, false)) return;
        intent.putExtra(HANDLED_EXTRA, true);

        Intent snapshot = new Intent(intent);
        CAPTURE_EXECUTOR.execute(() -> {
            try {
                JSONObject payload = buildPayload(activity, snapshot);
                if (payload == null) return;
                appendPayload(activity, payload);
                notifyShareReceived(payload.optString("id"));
            } catch (Exception error) {
                JSONObject payload = new JSONObject();
                try {
                    payload.put("id", UUID.randomUUID().toString());
                    payload.put("action", action == null ? "unknown" : action);
                    payload.put("createdAt", System.currentTimeMillis());
                    payload.put("sourcePackage", "");
                    payload.put("sourceLabel", "其他应用");
                    payload.put("subject", "");
                    payload.put("text", "");
                    payload.put("url", "");
                    payload.put("captureError", safeMessage(error, "读取系统分享内容失败"));
                    payload.put("items", new JSONArray());
                    appendPayload(activity, payload);
                    notifyShareReceived(payload.optString("id"));
                } catch (Exception ignored) {
                    // The share receiver must never crash the Activity.
                }
            }
        });
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        try {
            JSONArray queue;
            synchronized (QUEUE_LOCK) {
                queue = cleanupExpiredLocked(getContext(), readQueueLocked(getContext()));
                writeQueueLocked(getContext(), queue);
            }
            JSObject result = new JSObject();
            result.put("payloads", publicQueue(queue));
            result.put("maxFileBytes", MAX_FILE_BYTES);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(safeMessage(error, "读取待导入内容失败"), error);
        }
    }

    @PluginMethod
    public void discardPayload(PluginCall call) {
        String payloadId = call.getString("payloadId", "");
        if (payloadId.isEmpty()) {
            call.reject("payloadId is required");
            return;
        }
        synchronized (QUEUE_LOCK) {
            JSONArray queue = readQueueLocked(getContext());
            JSONArray next = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject payload = queue.optJSONObject(i);
                if (payload == null) continue;
                if (payloadId.equals(payload.optString("id"))) {
                    deletePayloadFiles(getContext(), payload);
                } else {
                    next.put(payload);
                }
            }
            writeQueueLocked(getContext(), next);
        }
        call.resolve(okResult());
    }

    /**
     * Remove successful/ignored items while retaining failed items for retry.
     * consumeText clears subject/text/url after those values have been inserted once.
     */
    @PluginMethod
    public void completeItems(PluginCall call) {
        String payloadId = call.getString("payloadId", "");
        JSArray idsArray = call.getArray("itemIds");
        boolean consumeText = call.getBoolean("consumeText", false);
        if (payloadId.isEmpty()) {
            call.reject("payloadId is required");
            return;
        }
        Set<String> ids = new LinkedHashSet<>();
        if (idsArray != null) {
            for (int i = 0; i < idsArray.length(); i++) {
                String value = idsArray.optString(i, "");
                if (!value.isEmpty()) ids.add(value);
            }
        }

        synchronized (QUEUE_LOCK) {
            JSONArray queue = readQueueLocked(getContext());
            JSONArray nextQueue = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject payload = queue.optJSONObject(i);
                if (payload == null) continue;
                if (!payloadId.equals(payload.optString("id"))) {
                    nextQueue.put(payload);
                    continue;
                }

                JSONArray items = payload.optJSONArray("items");
                JSONArray nextItems = new JSONArray();
                if (items != null) {
                    for (int j = 0; j < items.length(); j++) {
                        JSONObject item = items.optJSONObject(j);
                        if (item == null) continue;
                        if (ids.contains(item.optString("id"))) {
                            deleteItemFile(getContext(), payload, item);
                        } else {
                            nextItems.put(item);
                        }
                    }
                }
                try {
                    payload.put("items", nextItems);
                    if (consumeText) {
                        payload.put("subject", "");
                        payload.put("text", "");
                        payload.put("url", "");
                    }
                } catch (JSONException ignored) {}

                boolean hasText = !payload.optString("subject").isEmpty()
                    || !payload.optString("text").isEmpty()
                    || !payload.optString("url").isEmpty();
                if (nextItems.length() == 0 && !hasText) {
                    deletePayloadFiles(getContext(), payload);
                } else {
                    nextQueue.put(payload);
                }
            }
            writeQueueLocked(getContext(), nextQueue);
        }
        call.resolve(okResult());
    }

    @PluginMethod
    public void cancelUpload(PluginCall call) {
        String itemId = call.getString("itemId", "");
        HttpURLConnection connection = ACTIVE_UPLOADS.remove(itemId);
        if (connection != null) connection.disconnect();
        JSObject result = okResult();
        result.put("cancelled", connection != null);
        call.resolve(result);
    }

    @PluginMethod
    public void uploadItem(PluginCall call) {
        String payloadId = call.getString("payloadId", "");
        String itemId = call.getString("itemId", "");
        String apiBaseUrl = call.getString("apiBaseUrl", "");
        String token = call.getString("token", "");
        String destination = call.getString("destination", "");
        String noteId = call.getString("noteId", "");
        String folderId = call.getString("folderId", "");
        String workspaceId = call.getString("workspaceId", "");

        if (payloadId.isEmpty() || itemId.isEmpty()) {
            call.reject("payloadId and itemId are required");
            return;
        }
        if (token.isEmpty()) {
            call.reject("Authentication token is required", "UNAUTHENTICATED");
            return;
        }
        if (!"files".equals(destination) && !"attachment".equals(destination)) {
            call.reject("Unsupported destination", "INVALID_DESTINATION");
            return;
        }
        if ("attachment".equals(destination) && noteId.isEmpty()) {
            call.reject("noteId is required for attachment destination", "MISSING_NOTE_ID");
            return;
        }

        URL endpoint;
        try {
            endpoint = buildEndpoint(apiBaseUrl, destination, workspaceId);
        } catch (Exception error) {
            call.reject("Invalid server URL", "INVALID_SERVER_URL", error);
            return;
        }

        ItemLookup lookup;
        synchronized (QUEUE_LOCK) {
            lookup = findItemLocked(getContext(), payloadId, itemId);
        }
        if (lookup == null || lookup.item == null) {
            call.reject("Pending file not found", "ITEM_NOT_FOUND");
            return;
        }
        if (!"ready".equals(lookup.item.optString("status"))) {
            call.reject(lookup.item.optString("error", "File is not importable"), "ITEM_NOT_READY");
            return;
        }
        File file = resolveStoredFile(getContext(), lookup.payload, lookup.item);
        if (!file.isFile()) {
            call.reject("Temporary file is missing", "TEMP_FILE_MISSING");
            return;
        }

        UPLOAD_EXECUTOR.execute(() -> {
            try {
                JSONObject response = streamMultipartUpload(
                    endpoint,
                    token,
                    destination,
                    noteId,
                    folderId,
                    itemId,
                    file,
                    lookup.item.optString("name", "shared-file"),
                    lookup.item.optString("mimeType", "application/octet-stream")
                );
                JSObject result = new JSObject();
                result.put("success", true);
                result.put("response", response);
                resolveOnMain(call, result);
            } catch (UploadException error) {
                rejectOnMain(call, error.getMessage(), error.code, error);
            } catch (Exception error) {
                rejectOnMain(call, safeMessage(error, "上传失败"), "UPLOAD_FAILED", error);
            }
        });
    }

    private static JSONObject buildPayload(Activity activity, Intent intent) throws Exception {
        String payloadId = UUID.randomUUID().toString();
        JSONObject payload = new JSONObject();
        payload.put("id", payloadId);
        payload.put("action", intent.getAction() == null ? "unknown" : intent.getAction());
        payload.put("createdAt", System.currentTimeMillis());

        String sourcePackage = resolveSourcePackage(activity, intent);
        payload.put("sourcePackage", sourcePackage);
        payload.put("sourceLabel", resolveSourceLabel(activity, sourcePackage));

        String subject = cleanText(intent.getStringExtra(Intent.EXTRA_SUBJECT), 500);
        CharSequence rawText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = cleanText(rawText == null ? "" : rawText.toString(), 200_000);
        String url = extractUrl(text);
        payload.put("subject", subject);
        payload.put("text", text);
        payload.put("url", url);

        JSONArray items = new JSONArray();
        List<Uri> uris = collectUris(intent);
        int limit = Math.min(uris.size(), MAX_ITEMS_PER_PAYLOAD);
        for (int i = 0; i < limit; i++) {
            items.put(copyUriToPrivateStorage(activity, payloadId, uris.get(i), i));
        }
        if (uris.size() > MAX_ITEMS_PER_PAYLOAD) {
            JSONObject overflow = new JSONObject();
            overflow.put("id", UUID.randomUUID().toString());
            overflow.put("name", "其余文件");
            overflow.put("mimeType", "application/octet-stream");
            overflow.put("declaredMimeType", "");
            overflow.put("size", 0);
            overflow.put("status", "error");
            overflow.put("error", "一次最多接收 " + MAX_ITEMS_PER_PAYLOAD + " 个文件");
            items.put(overflow);
        }
        payload.put("items", items);

        if (items.length() == 0 && subject.isEmpty() && text.isEmpty() && url.isEmpty()) return null;
        return payload;
    }

    private static JSONObject copyUriToPrivateStorage(Context context, String payloadId, Uri uri, int index) {
        JSONObject item = new JSONObject();
        String itemId = UUID.randomUUID().toString();
        try {
            item.put("id", itemId);
            ContentResolver resolver = context.getContentResolver();
            Meta meta = queryMeta(resolver, uri, index);
            String safeName = ShareImportSecurity.sanitizeDisplayName(meta.name, "shared-file-" + (index + 1));
            String declaredMime = meta.mime == null ? "" : meta.mime;
            item.put("name", safeName);
            item.put("declaredMimeType", declaredMime);
            item.put("sourceSize", Math.max(0, meta.size));

            if (ShareImportSecurity.isBlockedExtension(safeName) || ShareImportSecurity.isBlockedMime(declaredMime)) {
                item.put("mimeType", declaredMime.isEmpty() ? "application/octet-stream" : declaredMime);
                item.put("size", Math.max(0, meta.size));
                item.put("status", "blocked");
                item.put("error", "出于安全考虑，不支持可执行文件或脚本");
                return item;
            }
            if (meta.size > MAX_FILE_BYTES) {
                item.put("mimeType", declaredMime.isEmpty() ? "application/octet-stream" : declaredMime);
                item.put("size", meta.size);
                item.put("status", "error");
                item.put("error", "文件超过 1GB 上传限制");
                return item;
            }

            File payloadDir = new File(new File(context.getFilesDir(), PENDING_DIR), payloadId);
            if (!payloadDir.exists() && !payloadDir.mkdirs()) throw new IOException("无法创建临时目录");

            try (InputStream raw = resolver.openInputStream(uri)) {
                if (raw == null) throw new IOException("来源应用未提供可读取的数据流");
                BufferedInputStream input = new BufferedInputStream(raw, COPY_BUFFER);
                byte[] prefix = new byte[SNIFF_BYTES];
                int prefixLength = readPrefix(input, prefix);
                if (ShareImportSecurity.hasExecutableMagic(prefix, prefixLength)) {
                    item.put("mimeType", "application/octet-stream");
                    item.put("size", Math.max(0, meta.size));
                    item.put("status", "blocked");
                    item.put("error", "检测到可执行文件内容，已阻止导入");
                    return item;
                }

                String verifiedMime = ShareImportSecurity.sniffMime(prefix, prefixLength, declaredMime, safeName);
                if (ShareImportSecurity.isBlockedMime(verifiedMime)) {
                    item.put("mimeType", verifiedMime);
                    item.put("size", Math.max(0, meta.size));
                    item.put("status", "blocked");
                    item.put("error", "检测到危险文件类型，已阻止导入");
                    return item;
                }
                String ext = ShareImportSecurity.storageExtension(safeName, verifiedMime);
                String storedName = itemId + "." + ext;
                File target = new File(payloadDir, storedName);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long total = 0;
                try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target), COPY_BUFFER)) {
                    if (prefixLength > 0) {
                        output.write(prefix, 0, prefixLength);
                        digest.update(prefix, 0, prefixLength);
                        total += prefixLength;
                    }
                    byte[] buffer = new byte[COPY_BUFFER];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        total += read;
                        if (total > MAX_FILE_BYTES) throw new FileTooLargeException();
                        output.write(buffer, 0, read);
                        digest.update(buffer, 0, read);
                    }
                    output.flush();
                } catch (Exception error) {
                    if (target.exists()) target.delete();
                    throw error;
                }

                item.put("storedName", storedName);
                item.put("mimeType", verifiedMime);
                item.put("size", total);
                item.put("sha256", hex(digest.digest()));
                item.put("status", "ready");
                if (!declaredMime.isEmpty() && !declaredMime.equalsIgnoreCase(verifiedMime)) {
                    item.put("mimeMismatch", true);
                }
            }
        } catch (FileTooLargeException error) {
            putQuietly(item, "status", "error");
            putQuietly(item, "error", "文件超过 1GB 上传限制");
        } catch (SecurityException error) {
            putQuietly(item, "status", "error");
            putQuietly(item, "error", "来源应用没有授予文件读取权限");
        } catch (Exception error) {
            putQuietly(item, "status", "error");
            putQuietly(item, "error", safeMessage(error, "读取文件失败"));
        }
        return item;
    }

    private static JSONObject streamMultipartUpload(
        URL endpoint,
        String token,
        String destination,
        String noteId,
        String folderId,
        String itemId,
        File file,
        String displayName,
        String mimeType
    ) throws Exception {
        String boundary = "----NowenShare" + UUID.randomUUID().toString().replace("-", "");
        ByteArrayOutputStream preamble = new ByteArrayOutputStream();
        if ("attachment".equals(destination)) writeField(preamble, boundary, "noteId", noteId);
        if ("files".equals(destination) && !folderId.isEmpty()) writeField(preamble, boundary, "folderId", folderId);
        writeUtf8(preamble, "--" + boundary + "\r\n");
        String asciiName = displayName.replaceAll("[^\\x20-\\x7E]", "_").replace("\\", "_").replace("\"", "_");
        String encodedName = URLEncoder.encode(displayName, "UTF-8").replace("+", "%20");
        writeUtf8(preamble, "Content-Disposition: form-data; name=\"file\"; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodedName + "\r\n");
        writeUtf8(preamble, "Content-Type: " + (mimeType.isEmpty() ? "application/octet-stream" : mimeType) + "\r\n\r\n");
        byte[] preambleBytes = preamble.toByteArray();
        byte[] trailerBytes = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        long contentLength = preambleBytes.length + file.length() + trailerBytes.length;

        HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
        ACTIVE_UPLOADS.put(itemId, connection);
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            connection.setRequestProperty("Connection", "close");
            connection.setFixedLengthStreamingMode(contentLength);

            long sent = 0;
            long lastNotifyAt = 0;
            int lastPercent = -1;
            try (OutputStream raw = connection.getOutputStream();
                 BufferedOutputStream output = new BufferedOutputStream(raw, COPY_BUFFER);
                 InputStream input = new BufferedInputStream(new FileInputStream(file), COPY_BUFFER)) {
                output.write(preambleBytes);
                sent += preambleBytes.length;
                byte[] buffer = new byte[COPY_BUFFER];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (!ACTIVE_UPLOADS.containsKey(itemId)) throw new UploadException("UPLOAD_CANCELLED", "上传已取消");
                    output.write(buffer, 0, read);
                    sent += read;
                    long now = System.currentTimeMillis();
                    int percent = contentLength <= 0 ? 0 : (int) Math.min(99, sent * 100L / contentLength);
                    if (percent != lastPercent && (now - lastNotifyAt >= 100 || percent >= 99)) {
                        notifyUploadProgress(itemId, sent, contentLength, percent);
                        lastPercent = percent;
                        lastNotifyAt = now;
                    }
                }
                output.write(trailerBytes);
                output.flush();
            }

            int status = connection.getResponseCode();
            String responseText = readResponse(
                status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream()
            );
            JSONObject response;
            try {
                response = responseText.isEmpty() ? new JSONObject() : new JSONObject(responseText);
            } catch (JSONException parseError) {
                throw new UploadException("INVALID_RESPONSE", "服务器返回了无法解析的响应（HTTP " + status + "）");
            }
            if (status < 200 || status >= 300) {
                String message = response.optString("error", "上传失败（HTTP " + status + "）");
                String code = response.optString("code", status == 401 ? "UNAUTHENTICATED" : "HTTP_" + status);
                throw new UploadException(code, message);
            }
            notifyUploadProgress(itemId, contentLength, contentLength, 100);
            return response;
        } finally {
            ACTIVE_UPLOADS.remove(itemId);
            connection.disconnect();
        }
    }

    private static URL buildEndpoint(String apiBaseUrl, String destination, String workspaceId) throws Exception {
        String base = apiBaseUrl == null ? "" : apiBaseUrl.trim().replaceAll("/+$", "");
        URL parsed = new URL(base);
        String protocol = parsed.getProtocol().toLowerCase(Locale.ROOT);
        if (!"http".equals(protocol) && !"https".equals(protocol)) throw new IllegalArgumentException("Unsupported protocol");
        if (parsed.getHost() == null || parsed.getHost().isEmpty()) throw new IllegalArgumentException("Missing host");
        String endpoint = base + ("files".equals(destination) ? "/files/upload" : "/attachments");
        if ("files".equals(destination) && workspaceId != null && !workspaceId.isEmpty() && !"personal".equals(workspaceId)) {
            endpoint += "?workspaceId=" + URLEncoder.encode(workspaceId, "UTF-8");
        }
        return new URL(endpoint);
    }

    private static void appendPayload(Context context, JSONObject payload) {
        synchronized (QUEUE_LOCK) {
            JSONArray queue = cleanupExpiredLocked(context, readQueueLocked(context));
            while (queue.length() >= MAX_PAYLOADS) {
                JSONObject oldest = queue.optJSONObject(0);
                if (oldest != null) deletePayloadFiles(context, oldest);
                queue = removeAt(queue, 0);
            }
            long pendingBytes = totalPendingBytes(queue) + payloadBytes(payload);
            while (queue.length() > 0 && pendingBytes > MAX_PENDING_BYTES) {
                JSONObject oldest = queue.optJSONObject(0);
                if (oldest != null) {
                    pendingBytes -= payloadBytes(oldest);
                    deletePayloadFiles(context, oldest);
                }
                queue = removeAt(queue, 0);
            }
            queue.put(payload);
            writeQueueLocked(context, queue);
        }
    }

    private static JSONArray readQueueLocked(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(PREFS_QUEUE, "[]");
        try {
            return new JSONArray(raw == null ? "[]" : raw);
        } catch (JSONException error) {
            return new JSONArray();
        }
    }

    private static void writeQueueLocked(Context context, JSONArray queue) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREFS_QUEUE, queue.toString())
            .apply();
    }

    private static JSONArray cleanupExpiredLocked(Context context, JSONArray queue) {
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        JSONArray next = new JSONArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject payload = queue.optJSONObject(i);
            if (payload == null) continue;
            if (payload.optLong("createdAt", 0) < cutoff) {
                deletePayloadFiles(context, payload);
            } else {
                next.put(payload);
            }
        }
        return next;
    }

    private static JSONArray publicQueue(JSONArray queue) {
        JSONArray out = new JSONArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject payload = queue.optJSONObject(i);
            if (payload == null) continue;
            try {
                JSONObject copy = new JSONObject(payload.toString());
                JSONArray items = copy.optJSONArray("items");
                if (items != null) {
                    for (int j = 0; j < items.length(); j++) {
                        JSONObject item = items.optJSONObject(j);
                        if (item != null) item.remove("storedName");
                    }
                }
                out.put(copy);
            } catch (JSONException ignored) {}
        }
        return out;
    }

    private static ItemLookup findItemLocked(Context context, String payloadId, String itemId) {
        JSONArray queue = readQueueLocked(context);
        for (int i = 0; i < queue.length(); i++) {
            JSONObject payload = queue.optJSONObject(i);
            if (payload == null || !payloadId.equals(payload.optString("id"))) continue;
            JSONArray items = payload.optJSONArray("items");
            if (items == null) return null;
            for (int j = 0; j < items.length(); j++) {
                JSONObject item = items.optJSONObject(j);
                if (item != null && itemId.equals(item.optString("id"))) return new ItemLookup(payload, item);
            }
        }
        return null;
    }

    private static File resolveStoredFile(Context context, JSONObject payload, JSONObject item) {
        String payloadId = payload.optString("id");
        String storedName = item.optString("storedName");
        File root = new File(new File(context.getFilesDir(), PENDING_DIR), payloadId);
        File candidate = new File(root, storedName);
        try {
            String rootPath = root.getCanonicalPath();
            String filePath = candidate.getCanonicalPath();
            if (!filePath.startsWith(rootPath + File.separator)) return new File(root, "__invalid__");
        } catch (IOException error) {
            return new File(root, "__invalid__");
        }
        return candidate;
    }

    private static void deleteItemFile(Context context, JSONObject payload, JSONObject item) {
        File file = resolveStoredFile(context, payload, item);
        if (file.isFile()) file.delete();
    }

    private static void deletePayloadFiles(Context context, JSONObject payload) {
        File directory = new File(new File(context.getFilesDir(), PENDING_DIR), payload.optString("id"));
        deleteRecursively(directory);
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }

    private static long totalPendingBytes(JSONArray queue) {
        long total = 0;
        for (int i = 0; i < queue.length(); i++) total += payloadBytes(queue.optJSONObject(i));
        return total;
    }

    private static long payloadBytes(JSONObject payload) {
        if (payload == null) return 0;
        JSONArray items = payload.optJSONArray("items");
        long total = 0;
        if (items != null) for (int i = 0; i < items.length(); i++) total += Math.max(0, items.optJSONObject(i) == null ? 0 : items.optJSONObject(i).optLong("size", 0));
        return total;
    }

    private static JSONArray removeAt(JSONArray source, int index) {
        JSONArray next = new JSONArray();
        for (int i = 0; i < source.length(); i++) if (i != index) next.put(source.opt(i));
        return next;
    }

    private static List<Uri> collectUris(Intent intent) {
        Set<String> seen = new LinkedHashSet<>();
        List<Uri> result = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) addUri(result, seen, intent.getData());

        try {
            Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            addUri(result, seen, single);
        } catch (Exception ignored) {}
        try {
            ArrayList<Uri> multiple = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (multiple != null) for (Uri uri : multiple) addUri(result, seen, uri);
        } catch (Exception ignored) {}
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) addUri(result, seen, clip.getItemAt(i).getUri());
        }
        return result;
    }

    private static void addUri(List<Uri> result, Set<String> seen, Uri uri) {
        if (uri == null) return;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"content".equals(scheme) && !"file".equals(scheme)) return;
        String key = uri.toString();
        if (seen.add(key)) result.add(uri);
    }

    private static Meta queryMeta(ContentResolver resolver, Uri uri, int index) {
        String name = null;
        long size = -1;
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        } catch (Exception ignored) {}
        if ((name == null || name.trim().isEmpty()) && uri.getLastPathSegment() != null) name = uri.getLastPathSegment();
        String mime = null;
        try { mime = resolver.getType(uri); } catch (Exception ignored) {}
        return new Meta(name == null ? "shared-file-" + (index + 1) : name, size, mime);
    }

    private static String resolveSourcePackage(Activity activity, Intent intent) {
        try {
            Uri referrer = activity.getReferrer();
            if (referrer != null && "android-app".equals(referrer.getScheme()) && referrer.getHost() != null) return referrer.getHost();
        } catch (Exception ignored) {}
        String raw = intent.getStringExtra(Intent.EXTRA_REFERRER_NAME);
        if (raw != null && !raw.isEmpty()) {
            try {
                URI uri = URI.create(raw);
                if ("android-app".equals(uri.getScheme()) && uri.getHost() != null) return uri.getHost();
            } catch (Exception ignored) {}
        }
        String calling = activity.getCallingPackage();
        return calling == null ? "" : calling;
    }

    private static String resolveSourceLabel(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty()) return "其他应用";
        try {
            CharSequence label = context.getPackageManager().getApplicationLabel(context.getPackageManager().getApplicationInfo(packageName, 0));
            return label == null ? packageName : label.toString();
        } catch (Exception ignored) {
            return packageName;
        }
    }

    private static String extractUrl(String text) {
        if (text == null || text.isEmpty()) return "";
        Matcher matcher = URL_PATTERN.matcher(text);
        if (!matcher.find()) return "";
        return matcher.group().replaceAll("[),.;!?]+$", "");
    }

    private static String cleanText(String value, int maxLength) {
        if (value == null) return "";
        String cleaned = value.replace("\u0000", "").trim();
        return cleaned.length() <= maxLength ? cleaned : cleaned.substring(0, maxLength);
    }

    private static int readPrefix(InputStream input, byte[] prefix) throws IOException {
        int total = 0;
        while (total < prefix.length) {
            int read = input.read(prefix, total, prefix.length - total);
            if (read == -1) break;
            total += read;
        }
        return total;
    }

    private static String readResponse(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = stream.read(buffer)) != -1) {
                total += read;
                if (total > MAX_RESPONSE_BYTES) throw new IOException("Server response exceeded 1MB");
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void writeField(OutputStream output, String boundary, String name, String value) throws IOException {
        writeUtf8(output, "--" + boundary + "\r\n");
        writeUtf8(output, "Content-Disposition: form-data; name=\"" + name.replace("\"", "") + "\"\r\n\r\n");
        writeUtf8(output, value == null ? "" : value);
        writeUtf8(output, "\r\n");
    }

    private static void writeUtf8(OutputStream output, String value) throws IOException {
        output.write(value.getBytes(StandardCharsets.UTF_8));
    }

    private static void notifyShareReceived(String payloadId) {
        ShareImportPlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("payloadId", payloadId);
        plugin.notifyListeners("shareReceived", data, true);
    }

    private static void notifyUploadProgress(String itemId, long bytesSent, long totalBytes, int percent) {
        ShareImportPlugin plugin = activePlugin.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("itemId", itemId);
        data.put("bytesSent", bytesSent);
        data.put("totalBytes", totalBytes);
        data.put("percent", percent);
        plugin.notifyListeners("uploadProgress", data);
    }

    private void resolveOnMain(PluginCall call, JSObject result) {
        Activity activity = getActivity();
        if (activity == null) call.resolve(result);
        else activity.runOnUiThread(() -> call.resolve(result));
    }

    private void rejectOnMain(PluginCall call, String message, String code, Exception error) {
        Activity activity = getActivity();
        Runnable reject = () -> call.reject(message, code, error);
        if (activity == null) reject.run();
        else activity.runOnUiThread(reject);
    }

    private static JSObject okResult() {
        JSObject result = new JSObject();
        result.put("ok", true);
        return result;
    }

    private static String safeMessage(Throwable error, String fallback) {
        String message = error == null ? "" : error.getMessage();
        return message == null || message.trim().isEmpty() ? fallback : message.trim();
    }

    private static void putQuietly(JSONObject object, String key, Object value) {
        try { object.put(key, value); } catch (JSONException ignored) {}
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value));
        return out.toString();
    }

    private static final class Meta {
        final String name;
        final long size;
        final String mime;
        Meta(String name, long size, String mime) {
            this.name = name;
            this.size = size;
            this.mime = mime;
        }
    }

    private static final class ItemLookup {
        final JSONObject payload;
        final JSONObject item;
        ItemLookup(JSONObject payload, JSONObject item) {
            this.payload = payload;
            this.item = item;
        }
    }

    private static final class FileTooLargeException extends IOException {
        FileTooLargeException() { super("File exceeds 1GB"); }
    }

    private static final class UploadException extends IOException {
        final String code;
        UploadException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
