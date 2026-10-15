package com.yibohuaxia.leyanxiu;

import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

@CapacitorPlugin(name="WechatLogin")
public class WechatLoginPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) {
        String appId=getContext().getString(R.string.wechat_app_id);
        String state=call.getString("state", "");
        if(appId.isEmpty() || !appId.equals(call.getString("appId")) || !state.matches("[a-f0-9]{48}")) {
            call.reject("微信登录配置不匹配，请使用手机号登录"); return;
        }
        IWXAPI api=WXAPIFactory.createWXAPI(getContext(),appId,true);
        try {
            if(!api.isWXAppInstalled()) {call.reject("尚未安装微信，请使用手机号登录");return;}
            api.registerApp(appId);
            SharedPreferences prefs=getContext().getSharedPreferences("wechat_login",0);
            prefs.edit().clear().putString("state",state).putLong("expires",System.currentTimeMillis()+300000).commit();
            SendAuth.Req req=new SendAuth.Req();req.scope="snsapi_userinfo";req.state=state;
            if(!api.sendReq(req)) {prefs.edit().clear().apply();call.reject("无法打开微信，请使用手机号登录");return;}
            JSObject result=new JSObject();result.put("launched",true);call.resolve(result);
        } catch(RuntimeException exception) {
            getContext().getSharedPreferences("wechat_login",0).edit().clear().apply();
            call.reject("无法打开微信，请使用手机号登录");
        } finally {api.detach();}
    }
    @PluginMethod public void result(PluginCall call) {
        SharedPreferences prefs=getContext().getSharedPreferences("wechat_login",0);
        JSObject result=new JSObject();
        if(prefs.getLong("expires",0)<System.currentTimeMillis()) prefs.edit().clear().apply();
        if(prefs.contains("error")) {
            result.put("error",prefs.getInt("error",-1));result.put("code",prefs.getString("code",""));result.put("state",prefs.getString("state",""));
            prefs.edit().clear().commit();
        }
        call.resolve(result);
    }
}
