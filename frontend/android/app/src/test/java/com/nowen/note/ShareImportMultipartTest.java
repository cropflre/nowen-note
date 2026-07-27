package com.nowen.note;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ShareImportMultipartTest {
    @Test
    public void usesNodeCompatibleFileDisposition() {
        String headers = ShareImportPlugin.buildMultipartFileHeaders("截图.jpg", "image/jpeg");

        assertTrue(headers.contains("name=\"file\"; filename=\"__.jpg\""));
        assertTrue(headers.contains("Content-Type: image/jpeg"));
        assertFalse(headers.contains("filename*="));
    }
}
