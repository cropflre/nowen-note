package com.nowen.note;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(MediaStoreSavePlugin.class);
    registerPlugin(ShareImportPlugin.class);
    registerPlugin(NativePrintPlugin.class);
    registerPlugin(EditorPerformancePlugin.class);
    super.onCreate(savedInstanceState);

    // Keep Android WebView's native long-press selection / ActionMode path enabled.
    // Some devices or input methods otherwise leave only a caret handle and never
    // expose Cut / Copy / Select all, even though the page content is editable.
    if (getBridge() != null) {
      WebView webView = getBridge().getWebView();
      if (webView != null) {
        webView.setLongClickable(true);
        webView.setHapticFeedbackEnabled(true);
      }
    }

    ShareImportPlugin.captureIntent(this, getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    ShareImportPlugin.captureIntent(this, intent);
  }
}
