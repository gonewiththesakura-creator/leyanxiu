package com.yibohuaxia.leyanxiu.wxapi;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.content.SharedPreferences;
import com.yibohuaxia.leyanxiu.MainActivity;
import com.yibohuaxia.leyanxiu.R;
import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public class WXEntryActivity extends Activity implements IWXAPIEventHandler {
    private IWXAPI api;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String appId=getString(R.string.wechat_app_id);
        if(appId.isEmpty()) {finish();return;}
        api=WXAPIFactory.createWXAPI(this,appId,true);handle(getIntent());
    }
    private void handle(Intent intent) {
        try {if(api==null || !api.handleIntent(intent,this)) finish();}
        catch(RuntimeException exception) {finish();}
    }
    @Override protected void onNewIntent(Intent intent) {super.onNewIntent(intent);setIntent(intent);handle(intent);}
    @Override public void onReq(BaseReq req) {finish();}
    @Override public void onResp(BaseResp resp) {
        if(!(resp instanceof SendAuth.Resp)) {finish();return;}
        SendAuth.Resp auth=(SendAuth.Resp)resp;
        SharedPreferences prefs=getSharedPreferences("wechat_login",0);
        String expected=prefs.getString("state","");
        if(expected.isEmpty() || !expected.equals(auth.state) || prefs.getLong("expires",0)<System.currentTimeMillis() || prefs.contains("error")) {finish();return;}
        prefs.edit().putInt("error",resp.errCode).putString("code",resp.errCode==0 ? auth.code : "").commit();
        // A callback is only an authorization code. The server must verify it before issuing a session.
        Intent intent=new Intent(this,MainActivity.class);intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);finish();
    }
    @Override protected void onDestroy() {if(api!=null) api.detach();super.onDestroy();}
}
