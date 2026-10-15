package com.yibohuaxia.leyanxiu.wxapi;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import com.yibohuaxia.leyanxiu.MainActivity;
import com.yibohuaxia.leyanxiu.R;
import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public class WXPayEntryActivity extends Activity implements IWXAPIEventHandler {
    private IWXAPI api;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String appId = getString(R.string.wechat_app_id);
        if (appId.isEmpty()) { finish(); return; }
        api = WXAPIFactory.createWXAPI(this, appId, true);
        try { if (!api.handleIntent(getIntent(), this)) finish(); }
        catch (RuntimeException exception) { finish(); }
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        try { if (api == null || !api.handleIntent(intent, this)) finish(); }
        catch (RuntimeException exception) { finish(); }
    }
    @Override public void onReq(BaseReq req) { finish(); }
    @Override public void onResp(BaseResp resp) {
        getSharedPreferences("wechat_payment_return", 0).edit().putInt("code", resp.errCode).apply();
        // Never trust the SDK callback as proof of payment, including errCode == 0.
        // Returning to the foreground resumes authenticated server-side order polling.
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent); finish();
    }
    @Override protected void onDestroy() { if (api != null) api.detach(); super.onDestroy(); }
}
