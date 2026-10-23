package com.nowen.note;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ServerTlsDiagnostics")
public class ServerTlsDiagnosticsPlugin extends Plugin {
    @PluginMethod
    public void inspect(PluginCall call) {
        // Endpoint identification and extended trust manager APIs require Android 7+.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) { call.resolve(new JSObject()); return; }
        getBridge().execute(() -> {
            JSObject response = new JSObject();
            try {
                ServerTlsDiagnostics.Result result = ServerTlsDiagnostics.inspect(call.getString("url", ""));
                if (result.kind != null) {
                    response.put("kind", result.kind);
                    if (result.certificate != null) {
                        response.put("expiresAt", result.certificate.getNotAfter().getTime());
                        response.put("validFrom", result.certificate.getNotBefore().getTime());
                    }
                }
            } catch (Exception ignored) {
                // Preserve the original connection error if inspection is unavailable.
            }
            call.resolve(response);
        });
    }
}
