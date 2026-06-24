package com.nowen.note;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;

/**
 * Capacitor 自定义插件：将 base64 图片写入 Android 系统相册。
 * 使用 MediaStore API，兼容 Android 10+ Scoped Storage，无需
 * WRITE_EXTERNAL_STORAGE 权限。
 */
@CapacitorPlugin(name = "MediaStoreSave")
public class MediaStoreSavePlugin extends Plugin {

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String fileName = call.getString("fileName", "image.png");
        String mimeType = call.getString("mimeType", "image/png");
        String relativePath = call.getString("relativePath", Environment.DIRECTORY_PICTURES + "/Nowen Note");

        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("base64Data is required");
            return;
        }

        try {
            byte[] data = Base64.decode(base64Data, Base64.DEFAULT);

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH, relativePath);
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            }

            Uri uri = getContext().getContentResolver().insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
            );

            if (uri == null) {
                call.reject("Failed to create MediaStore entry");
                return;
            }

            try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                if (os == null) {
                    call.reject("Failed to open output stream");
                    return;
                }
                os.write(data);
                os.flush();
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, values, null, null);
            }

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("uri", uri.toString());
            call.resolve(result);

        } catch (IOException e) {
            call.reject("Failed to save image: " + e.getMessage(), e);
        } catch (IllegalArgumentException e) {
            call.reject("Invalid data: " + e.getMessage(), e);
        }
    }
}