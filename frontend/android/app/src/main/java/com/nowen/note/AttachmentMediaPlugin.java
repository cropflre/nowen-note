package com.nowen.note;

import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/** Downloads signed HTTP video attachments into app cache for WebView-local playback. */
@CapacitorPlugin(name = "AttachmentMedia")
public final class AttachmentMediaPlugin extends Plugin {
  private static final Pattern ATTACHMENT_ID = Pattern.compile("^[0-9a-fA-F-]{36}$");
  private static final long MAX_CACHE_FILE_BYTES = 150L * 1024L * 1024L;
  private static final long STALE_CACHE_MS = 7L * 24L * 60L * 60L * 1000L;
  private static final ExecutorService DOWNLOAD_EXECUTOR = Executors.newFixedThreadPool(2);
  private static final ConcurrentHashMap<String, Object> DOWNLOAD_LOCKS = new ConcurrentHashMap<>();

  @PluginMethod
  public void prepare(PluginCall call) {
    String rawUrl = call.getString("url", "");
    String attachmentId = call.getString("attachmentId", "");
    if (!ATTACHMENT_ID.matcher(attachmentId).matches() || !isAllowedSignedAttachment(rawUrl, attachmentId)) {
      call.reject("Invalid signed attachment URL");
      return;
    }

    DOWNLOAD_EXECUTOR.execute(() -> {
      Object lock = DOWNLOAD_LOCKS.computeIfAbsent(attachmentId, ignored -> new Object());
      try {
        File target;
        synchronized (lock) {
          target = prepareCachedFile(rawUrl, attachmentId);
        }
        JSObject result = new JSObject();
        result.put("uri", Uri.fromFile(target).toString());
        result.put("size", target.length());
        getActivity().runOnUiThread(() -> call.resolve(result));
      } catch (Exception error) {
        getActivity().runOnUiThread(() -> call.reject(
          "Failed to prepare attachment video: " + safeMessage(error),
          error
        ));
      } finally {
        DOWNLOAD_LOCKS.remove(attachmentId, lock);
      }
    });
  }

  private File prepareCachedFile(String rawUrl, String attachmentId) throws IOException {
    File cacheDir = new File(getContext().getCacheDir(), "attachment-video");
    if (!cacheDir.exists() && !cacheDir.mkdirs()) throw new IOException("Unable to create video cache");
    cleanupStaleFiles(cacheDir);

    File target = new File(cacheDir, attachmentId + ".mp4");
    if (target.isFile() && target.length() > 0) {
      target.setLastModified(System.currentTimeMillis());
      return target;
    }

    File temporary = new File(cacheDir, attachmentId + ".download");
    if (temporary.exists() && !temporary.delete()) throw new IOException("Unable to reset video download");

    HttpURLConnection connection = (HttpURLConnection) new URL(rawUrl).openConnection();
    connection.setConnectTimeout(15_000);
    connection.setReadTimeout(120_000);
    connection.setInstanceFollowRedirects(true);
    connection.setRequestProperty("Accept-Encoding", "identity");
    try {
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) throw new IOException("Attachment response status " + status);
      long declaredLength = connection.getContentLengthLong();
      if (declaredLength > MAX_CACHE_FILE_BYTES) throw new IOException("Attachment video exceeds cache limit");

      long total = 0;
      try (
        InputStream input = new BufferedInputStream(connection.getInputStream());
        BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(temporary))
      ) {
        byte[] buffer = new byte[64 * 1024];
        int count;
        while ((count = input.read(buffer)) >= 0) {
          total += count;
          if (total > MAX_CACHE_FILE_BYTES) throw new IOException("Attachment video exceeds cache limit");
          output.write(buffer, 0, count);
        }
      }
      if (total <= 0) throw new IOException("Attachment video is empty");
      if (declaredLength >= 0 && total != declaredLength) throw new IOException("Attachment video is incomplete");
      if (!temporary.renameTo(target)) throw new IOException("Unable to publish cached video");
      return target;
    } finally {
      connection.disconnect();
      if (temporary.exists() && !target.exists()) temporary.delete();
    }
  }

  private static boolean isAllowedSignedAttachment(String rawUrl, String attachmentId) {
    try {
      Uri target = Uri.parse(rawUrl);
      String scheme = target.getScheme();
      return target.getHost() != null
        && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
        && ("/api/attachments/" + attachmentId).equals(target.getPath())
        && target.getQueryParameter("exp") != null
        && target.getQueryParameter("sig") != null
        && target.getQueryParameter("scope") != null;
    } catch (Exception ignored) {
      return false;
    }
  }

  private static void cleanupStaleFiles(File cacheDir) {
    File[] files = cacheDir.listFiles();
    if (files == null) return;
    long cutoff = System.currentTimeMillis() - STALE_CACHE_MS;
    for (File file : files) {
      if (file.isFile() && file.lastModified() < cutoff) file.delete();
    }
  }

  private static String safeMessage(Exception error) {
    String value = error.getMessage();
    return value == null || value.trim().isEmpty() ? error.getClass().getSimpleName() : value;
  }
}
