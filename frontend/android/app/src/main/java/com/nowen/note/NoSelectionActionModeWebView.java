package com.nowen.note;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor WebView compatibility wrapper.
 *
 * This class historically suppressed Android's text-selection ActionMode. That left selection
 * handles visible while removing the system Copy / Select all / Share actions, which is especially
 * noticeable in read-only Markdown preview. Keep the wrapper for layout compatibility, but delegate
 * ActionMode creation unchanged so Android WebView can provide its native selection toolbar.
 */
public class NoSelectionActionModeWebView extends CapacitorWebView {
    public NoSelectionActionModeWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        return super.startActionMode(callback);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        return super.startActionMode(callback, type);
    }
}
