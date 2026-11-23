package com.nowen.note;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 热更新的信任锚点。
 *
 * 壳指纹（runtimeVersion）和签名公钥在 cap sync 时写进 APK 自带的 capacitor.config.json，
 * 热更新包只替换网页目录，改不到这里；前端只认这里返回的值，不信任网页包里自带的副本。
 */
@CapacitorPlugin(name = "NowenHotUpdateRuntime")
public class HotUpdateRuntimePlugin extends Plugin {
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("runtimeVersion", getConfig().getString("runtimeVersion", ""));
        result.put("publicKey", getConfig().getString("publicKey", ""));
        result.put("keyId", getConfig().getString("keyId", ""));
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
            result.put("versionName", info.versionName);
            result.put("versionCode", String.valueOf(code));
        } catch (PackageManager.NameNotFoundException ignored) {
            // 读不到包信息时只返回配置，前端按未知安装包版本处理。
        }
        call.resolve(result);
    }
}
