package com.nowen.note;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(MediaStoreSavePlugin.class);
    registerPlugin(ShareImportPlugin.class);
    registerPlugin(NativePrintPlugin.class);
    super.onCreate(savedInstanceState);
    ShareImportPlugin.captureIntent(this, getIntent());
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    ShareImportPlugin.captureIntent(this, intent);
  }
}
