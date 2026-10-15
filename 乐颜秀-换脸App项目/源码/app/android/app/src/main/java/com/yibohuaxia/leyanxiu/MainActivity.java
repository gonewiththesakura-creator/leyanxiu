package com.yibohuaxia.leyanxiu;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(GalleryMediaStorePlugin.class);
        registerPlugin(DeviceIdentityPlugin.class);
        registerPlugin(WechatPayPlugin.class);
        registerPlugin(WechatLoginPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;

        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);

        boolean isDebuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(isDebuggable);
        settings.setMixedContentMode(
            isDebuggable ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW
        );
    }
}
