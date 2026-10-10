package com.nowen.note;

import static org.junit.Assert.assertNotNull;

import org.junit.Test;

public class FilesystemKotlinRuntimeTest {
    @Test
    public void filesystemCoroutineRuntimeIsPresent() throws ClassNotFoundException {
        // Filesystem's Kotlin 2.2 coroutine references this class when resuming a file operation.
        // Downgrading the APK runtime to Kotlin 1.8 caused a fatal NoClassDefFoundError on Android.
        assertNotNull(Class.forName("kotlin.coroutines.jvm.internal.SpillingKt"));
    }
}
