package com.nowen.note;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure validation helpers for Android share/import.
 *
 * The source application controls DISPLAY_NAME and MIME, so neither value is trusted.
 * This class keeps the security-sensitive normalization independent from Android APIs,
 * which also makes it straightforward to cover with local JVM tests.
 */
public final class ShareImportSecurity {
    private static final int MAX_DISPLAY_NAME = 180;

    private static final Set<String> BLOCKED_EXTENSIONS = new HashSet<>(Arrays.asList(
        "apk", "apks", "xapk", "exe", "msi", "msp", "com", "scr", "pif",
        "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
        "jar", "dex", "so", "dll", "sys", "lnk", "reg"
    ));

    private static final Set<String> BLOCKED_MIMES = new HashSet<>(Arrays.asList(
        "application/vnd.android.package-archive",
        "application/x-msdownload",
        "application/x-ms-installer",
        "application/x-ms-shortcut",
        "application/x-bat",
        "application/x-sh",
        "application/hta",
        "application/java-archive"
    ));

    private static final Map<String, String> MIME_EXTENSIONS = new HashMap<>();
    static {
        MIME_EXTENSIONS.put("application/pdf", "pdf");
        MIME_EXTENSIONS.put("image/png", "png");
        MIME_EXTENSIONS.put("image/jpeg", "jpg");
        MIME_EXTENSIONS.put("image/gif", "gif");
        MIME_EXTENSIONS.put("image/webp", "webp");
        MIME_EXTENSIONS.put("image/bmp", "bmp");
        MIME_EXTENSIONS.put("image/heic", "heic");
        MIME_EXTENSIONS.put("image/heif", "heif");
        MIME_EXTENSIONS.put("text/plain", "txt");
        MIME_EXTENSIONS.put("text/markdown", "md");
        MIME_EXTENSIONS.put("text/html", "html");
        MIME_EXTENSIONS.put("application/json", "json");
        MIME_EXTENSIONS.put("application/zip", "zip");
        MIME_EXTENSIONS.put("application/x-7z-compressed", "7z");
        MIME_EXTENSIONS.put("application/x-rar-compressed", "rar");
        MIME_EXTENSIONS.put("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
        MIME_EXTENSIONS.put("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");
        MIME_EXTENSIONS.put("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx");
    }

    private ShareImportSecurity() {}

    public static String sanitizeDisplayName(String raw, String fallback) {
        String source = raw == null ? "" : raw.trim();
        if (source.isEmpty()) source = fallback == null ? "shared-file" : fallback.trim();
        if (source.isEmpty()) source = "shared-file";

        StringBuilder out = new StringBuilder();
        for (int i = 0; i < source.length() && out.length() < MAX_DISPLAY_NAME; i++) {
            char ch = source.charAt(i);
            if (ch == '/' || ch == '\\' || ch == '\u0000' || Character.isISOControl(ch)) {
                out.append('_');
            } else {
                out.append(ch);
            }
        }

        String normalized = out.toString().trim();
        while (normalized.startsWith(".")) normalized = normalized.substring(1);
        normalized = normalized.replaceAll("\\s+", " ");
        return normalized.isEmpty() ? "shared-file" : normalized;
    }

    public static String extensionOf(String filename) {
        if (filename == null) return "";
        int dot = filename.lastIndexOf('.');
        if (dot <= 0 || dot >= filename.length() - 1) return "";
        return filename.substring(dot + 1).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    public static boolean isBlockedExtension(String filename) {
        return BLOCKED_EXTENSIONS.contains(extensionOf(filename));
    }

    public static boolean isBlockedMime(String mime) {
        return mime != null && BLOCKED_MIMES.contains(mime.toLowerCase(Locale.ROOT).trim());
    }

    public static boolean hasExecutableMagic(byte[] prefix, int length) {
        if (prefix == null || length <= 0) return false;
        if (length >= 2 && prefix[0] == 'M' && prefix[1] == 'Z') return true;
        if (length >= 4 && (prefix[0] & 0xff) == 0x7f && prefix[1] == 'E' && prefix[2] == 'L' && prefix[3] == 'F') return true;
        if (length >= 4 && (prefix[0] & 0xff) == 0xca && (prefix[1] & 0xff) == 0xfe && (prefix[2] & 0xff) == 0xba && (prefix[3] & 0xff) == 0xbe) return true;
        if (length >= 2 && prefix[0] == '#' && prefix[1] == '!') return true;
        return false;
    }

    public static String sniffMime(byte[] prefix, int length, String declaredMime, String filename) {
        if (prefix == null) prefix = new byte[0];
        int n = Math.max(0, Math.min(length, prefix.length));

        if (startsWith(prefix, n, "%PDF-".getBytes(StandardCharsets.US_ASCII))) return "application/pdf";
        if (n >= 8 && (prefix[0] & 0xff) == 0x89 && prefix[1] == 'P' && prefix[2] == 'N' && prefix[3] == 'G'
            && prefix[4] == '\r' && prefix[5] == '\n' && (prefix[6] & 0xff) == 0x1a && prefix[7] == '\n') return "image/png";
        if (n >= 3 && (prefix[0] & 0xff) == 0xff && (prefix[1] & 0xff) == 0xd8 && (prefix[2] & 0xff) == 0xff) return "image/jpeg";
        if (startsWith(prefix, n, "GIF87a".getBytes(StandardCharsets.US_ASCII)) || startsWith(prefix, n, "GIF89a".getBytes(StandardCharsets.US_ASCII))) return "image/gif";
        if (n >= 12 && startsWith(prefix, n, "RIFF".getBytes(StandardCharsets.US_ASCII))
            && prefix[8] == 'W' && prefix[9] == 'E' && prefix[10] == 'B' && prefix[11] == 'P') return "image/webp";
        if (n >= 2 && prefix[0] == 'B' && prefix[1] == 'M') return "image/bmp";
        if (n >= 4 && prefix[0] == 'P' && prefix[1] == 'K'
            && ((prefix[2] == 3 && prefix[3] == 4) || (prefix[2] == 5 && prefix[3] == 6) || (prefix[2] == 7 && prefix[3] == 8))) {
            String ext = extensionOf(filename);
            if ("docx".equals(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if ("xlsx".equals(ext)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if ("pptx".equals(ext)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            return "application/zip";
        }
        if (n >= 7 && (prefix[0] & 0xff) == 0x52 && (prefix[1] & 0xff) == 0x61 && (prefix[2] & 0xff) == 0x72
            && (prefix[3] & 0xff) == 0x21 && (prefix[4] & 0xff) == 0x1a && (prefix[5] & 0xff) == 0x07) return "application/x-rar-compressed";
        if (n >= 6 && (prefix[0] & 0xff) == 0x37 && (prefix[1] & 0xff) == 0x7a && (prefix[2] & 0xff) == 0xbc
            && (prefix[3] & 0xff) == 0xaf && (prefix[4] & 0xff) == 0x27 && (prefix[5] & 0xff) == 0x1c) return "application/x-7z-compressed";

        String declared = declaredMime == null ? "" : declaredMime.toLowerCase(Locale.ROOT).trim();
        if (!declared.isEmpty() && !"application/octet-stream".equals(declared) && !"*/*".equals(declared)) {
            return declared;
        }

        String ext = extensionOf(filename);
        if ("md".equals(ext) || "markdown".equals(ext)) return "text/markdown";
        if ("txt".equals(ext) || "log".equals(ext) || "csv".equals(ext)) return "text/plain";
        if ("html".equals(ext) || "htm".equals(ext)) return "text/html";
        if ("json".equals(ext)) return "application/json";
        if ("pdf".equals(ext)) return "application/pdf";
        if ("png".equals(ext)) return "image/png";
        if ("jpg".equals(ext) || "jpeg".equals(ext)) return "image/jpeg";
        if ("gif".equals(ext)) return "image/gif";
        if ("webp".equals(ext)) return "image/webp";
        if ("docx".equals(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if ("xlsx".equals(ext)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if ("pptx".equals(ext)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if ("zip".equals(ext)) return "application/zip";
        if ("rar".equals(ext)) return "application/x-rar-compressed";
        if ("7z".equals(ext)) return "application/x-7z-compressed";
        return "application/octet-stream";
    }

    public static String storageExtension(String filename, String mime) {
        String ext = extensionOf(filename);
        if (!ext.isEmpty() && ext.length() <= 10 && !BLOCKED_EXTENSIONS.contains(ext)) return ext;
        String mapped = MIME_EXTENSIONS.get(mime == null ? "" : mime.toLowerCase(Locale.ROOT));
        return mapped == null ? "bin" : mapped;
    }

    private static boolean startsWith(byte[] value, int length, byte[] signature) {
        if (signature.length > length) return false;
        for (int i = 0; i < signature.length; i++) {
            if (value[i] != signature[i]) return false;
        }
        return true;
    }
}
