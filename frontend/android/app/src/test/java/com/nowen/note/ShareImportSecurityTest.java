package com.nowen.note;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

public class ShareImportSecurityTest {
    @Test
    public void sanitizesUntrustedDisplayNames() {
        assertEquals("_.._secret.pdf", ShareImportSecurity.sanitizeDisplayName("../../secret.pdf", "fallback"));
        assertEquals("evil_name.txt", ShareImportSecurity.sanitizeDisplayName("evil\nname.txt", "fallback"));
        assertEquals("safe_name.jpg", ShareImportSecurity.sanitizeDisplayName("safe\u202Ename.jpg", "fallback"));
        assertEquals("shared-file", ShareImportSecurity.sanitizeDisplayName("...", "shared-file"));
    }

    @Test
    public void blocksExecutableNamesMimeAndMagic() {
        assertTrue(ShareImportSecurity.isBlockedExtension("payload.APK"));
        assertTrue(ShareImportSecurity.isBlockedExtension("bootstrap.sh"));
        assertTrue(ShareImportSecurity.isBlockedMime("application/x-msdownload"));
        assertTrue(ShareImportSecurity.hasExecutableMagic(new byte[]{'M', 'Z', 0, 0}, 4));
        assertTrue(ShareImportSecurity.hasExecutableMagic(new byte[]{0x7f, 'E', 'L', 'F'}, 4));
        assertTrue(ShareImportSecurity.hasExecutableMagic(new byte[]{'d', 'e', 'x', '\n', '0', '3', '5', 0}, 8));
        assertTrue(ShareImportSecurity.hasExecutableMagic("#!/bin/sh".getBytes(StandardCharsets.US_ASCII), 9));
        byte[] disguisedApk = "PK\u0003\u0004....AndroidManifest.xml....classes.dex".getBytes(StandardCharsets.ISO_8859_1);
        assertTrue(ShareImportSecurity.hasExecutableMagic(disguisedApk, disguisedApk.length));
        assertFalse(ShareImportSecurity.hasExecutableMagic("plain text".getBytes(StandardCharsets.US_ASCII), 10));
    }

    @Test
    public void sniffsCommonFileSignaturesInsteadOfTrustingDeclaredMime() {
        byte[] pdf = "%PDF-1.7".getBytes(StandardCharsets.US_ASCII);
        assertEquals("application/pdf", ShareImportSecurity.sniffMime(pdf, pdf.length, "text/plain", "report.txt"));

        byte[] png = new byte[]{(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
        assertEquals("image/png", ShareImportSecurity.sniffMime(png, png.length, "application/octet-stream", "image.bin"));

        byte[] zip = new byte[]{'P', 'K', 3, 4, 0, 0};
        assertEquals(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ShareImportSecurity.sniffMime(zip, zip.length, "application/octet-stream", "document.docx")
        );
    }
}
