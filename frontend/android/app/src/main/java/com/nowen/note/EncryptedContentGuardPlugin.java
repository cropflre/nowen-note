package com.nowen.note;

import android.view.Window;
import android.app.Activity;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;

/** Ref-counted per-session protection. No body, password or key crosses this bridge. */
@CapacitorPlugin(name = "EncryptedContentGuard")
public class EncryptedContentGuardPlugin extends Plugin {
    private final Set<String> leases = new HashSet<>();
    private boolean addedSecureFlag = false;

    @PluginMethod
    public void acquire(PluginCall call) { update(call, true); }

    @PluginMethod
    public void release(PluginCall call) { update(call, false); }

    private void update(PluginCall call, boolean acquire) {
        String token = call.getString("token");
        Activity activity = getActivity();
        if (token == null || !token.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") || activity == null) {
            call.reject("ENCRYPTED_WINDOW_UNAVAILABLE"); return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (window == null || activity.isDestroyed()) { call.reject("ENCRYPTED_WINDOW_UNAVAILABLE"); return; }
            if (acquire) {
                if (leases.isEmpty()) addedSecureFlag = (window.getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) == 0;
                leases.add(token); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                leases.remove(token);
                if (leases.isEmpty() && addedSecureFlag) { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); addedSecureFlag = false; }
            }
            call.resolve();
        });
    }
}
