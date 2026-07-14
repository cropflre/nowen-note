package com.nowen.note;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 使用 Android PrintManager 打印前端生成的独立笔记文档。 */
@CapacitorPlugin(name = "NativePrint")
public class NativePrintPlugin extends Plugin {

    private WebView printWebView;

    @PluginMethod
    public void printNote(PluginCall call) {
        String html = call.getString("html");
        String jobName = call.getString("jobName", "Nowen Note");
        if (html == null || html.trim().isEmpty()) {
            call.reject("html is required");
            return;
        }

        getActivity().runOnUiThread(() -> {
            try {
                WebView webView = new WebView(getContext());
                printWebView = webView;
                webView.getSettings().setDefaultTextEncodingName("UTF-8");
                webView.setWebViewClient(new WebViewClient() {
                    private boolean printStarted;

                    @Override
                    public void onPageFinished(WebView view, String url) {
                        if (printStarted) return;
                        printStarted = true;

                        try {
                            PrintManager printManager = (PrintManager) getContext()
                                    .getSystemService(Context.PRINT_SERVICE);
                            if (printManager == null) {
                                call.reject("Android print service is unavailable");
                                return;
                            }

                            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
                            PrintAttributes attributes = new PrintAttributes.Builder()
                                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                    .build();
                            printManager.print(jobName, adapter, attributes);

                            JSObject result = new JSObject();
                            result.put("success", true);
                            call.resolve(result);
                        } catch (Exception error) {
                            call.reject("Unable to start Android print", error);
                        }
                    }
                });
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            } catch (Exception error) {
                call.reject("Unable to start Android print", error);
            }
        });
    }
}
