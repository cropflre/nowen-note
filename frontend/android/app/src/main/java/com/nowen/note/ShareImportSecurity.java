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
        "jar", "dex", "so", "dll", "sys", "lnk", "reg", "sh", "bash", "zsh",
        "fish", "command", "py", "pyw", "rb", "pl", "php", "cgi", "lua", "tcl",
        "appimage", "run", "deb", "rpm"
    ));

    private static final Set<String> BLOCKED_MIMES = new HashSet<>(Arrays.asList(
        "application/vnd.android.package-archive",
        "application/x-msdownload",
        "application/x-ms-installer",
        "application/x-ms-shortcut",
        "application/x-bat",
        "application/x-sh",
        "application/x-executable",
        "application/x-pie-executable",
        "application/x-elf",
        "application/x-httpd-php",
        "application/hta",
        "application/java-archive",
        "text/x-shellscript",
        "text/x-python"
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
            int category = Character.getType(ch);
            if (ch == '/' || ch == '\\' || ch == '\u0000' || Character.isISOControl(ch) || category == Character.FORMAT) {
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

    public static String normalizeMime(String mime) {
        if (mime == null) return "";
        String normalized = mime.toLowerCase(Locale.ROOT).trim();
        // ContentResolver#getType is expected to return only type/subtype. Reject parameters,
        // whitespace, CR/LF and other delimiter characters before using the value in multipart.
        if (!normalized.matches("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$")) {
            return "";
        }
        return normalized;
    }

    public static boolean isBlockedExtension(String filename) {
        return BLOCKED_EXTENSIONS.contains(extensionOf(filename));
    }

    public static boolean isBlockedMime(String mime) {
        String normalized = normalizeMime(mime);
        return !normalized.isEmpty() && BLOCKED_MIMES.contains(normalized);
    }

    public static boolean hasExecutableMagic(byte[] prefix, int length) {
        if (prefix == null || length <= 0) return false;
        int n = Math.max(0, Math.min(length, prefix.length));
        if (n >= 2 && prefix[0] == 'M' && prefix[1] == 'Z') return true;
        if (n >= 4 && (prefix[0] & 0xff) == 0x7f && prefix[1] == 'E' && prefix[2] == 'L' && prefix[3] == 'F') return true;
        if (n >= 4 && prefix[0] == 'd' && prefix[1] == 'e' && prefix[2] == 'x' && prefix[3] == '\n') return true;
        if (n >= 4 && isMachOMagic(prefix)) return true;
        if (n >= 2 && prefix[0] == '#' && prefix[1] == '!') return true;
        // APK is a ZIP container. Many APK writers place one of these entries in the first
        // local header; catch the disguised .zip case without decompressing untrusted input.
        if (n >= 4 && prefix[0] == 'P' && prefix[1] == 'K'
            && (containsAscii(prefix, n, "AndroidManifest.xml") || containsAscii(prefix, n, "classes.dex"))) return true;
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

        String declared = normalizeMime(declaredMime);
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
        String mapped = MIME_EXTENSIONS.get(normalizeMime(mime));
        return mapped == null ? "bin" : mapped;
    }

    private static boolean isMachOMagic(byte[] value) {
        int a = value[0] & 0xff;
        int b = value[1] & 0xff;
        int c = value[2] & 0xff;
        int d = value[3] & 0xff;
        return (a == 0xfe && b == 0xed && c == 0xfa && (d == 0xce || d == 0xcf))
            || ((a == 0xce || a == 0xcf) && b == 0xfa && c == 0xed && d == 0xfe)
            || (a == 0xca && b == 0xfe && c == 0xba && d == 0xbe);
    }

    private static boolean containsAscii(byte[] value, int length, String needle) {
        byte[] target = needle.getBytes(StandardCharsets.US_ASCII);
        if (target.length == 0 || target.length > length) return false;
        outer:
        for (int i = 0; i <= length - target.length; i++) {
            for (int j = 0; j < target.length; j++) {
                if (value[i + j] != target[j]) continue outer;
            }
            return true;
        }
        return false;
    }

    private static boolean startsWith(byte[] value, int length, byte[] signature) {
        if (signature.length > length) return false;
        for (int i = 0; i < signature.length; i++) {
            if (value[i] != signature[i]) return false;
        }
        return true;
    }
}
