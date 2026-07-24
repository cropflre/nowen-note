package com.nowen.note;

import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 真实 Android 设备上的编辑器性能签收指标。 */
@CapacitorPlugin(name = "EditorPerformance")
public class EditorPerformancePlugin extends Plugin {

    @PluginMethod
    public void getMemoryMetrics(PluginCall call) {
        if (getBridge() == null || getBridge().getWebView() == null) {
            call.reject("Android WebView is unavailable");
            return;
        }
        WebView webView = getBridge().getWebView();
        getActivity().runOnUiThread(() -> webView.evaluateJavascript(
                "(function(){var m=performance&&performance.memory;"
                        + "var v=m&&m.usedJSHeapSize;"
                        + "return Number.isFinite(v)&&v>=0?String(v):null;})()",
                value -> {
                    try {
                        if (value == null || "null".equals(value)) {
                            call.reject("Android WebView JS heap is unavailable");
                            return;
                        }
                        String normalized = value;
                        if (normalized.length() >= 2 && normalized.startsWith("\"") && normalized.endsWith("\"")) {
                            normalized = normalized.substring(1, normalized.length() - 1);
                        }
                        double parsed = Double.parseDouble(normalized);
                        if (!Double.isFinite(parsed) || parsed < 0) {
                            call.reject("Android WebView JS heap is invalid");
                            return;
                        }
                        JSObject result = new JSObject();
                        result.put("heapBytes", (long) parsed);
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("Unable to read Android WebView JS heap", error);
                    }
                }
        ));
    }
}
