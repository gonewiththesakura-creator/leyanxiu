package com.yibohuaxia.leyanxiu;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.tencent.mm.opensdk.modelpay.PayReq;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

/** Client launches the cashier only. Entitlements are granted exclusively by verified server events. */
@CapacitorPlugin(name = "WechatPay")
public class WechatPayPlugin extends Plugin {
    @PluginMethod
    public void status(PluginCall call) {
        String appId = getContext().getString(R.string.wechat_app_id);
        JSObject result = new JSObject();
        result.put("configured", !appId.isEmpty());
        // SDK is instantiated only after privacy acceptance when opening the purchase page.
        IWXAPI api = WXAPIFactory.createWXAPI(getContext(), appId, true);
        result.put("installed", api.isWXAppInstalled());
        android.content.SharedPreferences returns = getContext().getSharedPreferences("wechat_payment_return", 0);
        if (returns.contains("code")) {
            result.put("returnCode", returns.getInt("code", -1));
            returns.edit().remove("code").apply();
        }
        api.detach();
        call.resolve(result);
    }

    @PluginMethod
    public void pay(PluginCall call) {
        String appId = getContext().getString(R.string.wechat_app_id);
        if (appId.isEmpty() || !appId.equals(call.getString("appid"))) {
            call.reject("当前安装包尚未配置正确的微信支付应用信息"); return;
        }
        for (String field : new String[] {"partnerid", "prepayid", "package", "noncestr", "timestamp", "sign"}) {
            if (call.getString(field, "").isEmpty()) { call.reject("支付参数不完整，请重新查询订单"); return; }
        }
        if (!"Sign=WXPay".equals(call.getString("package"))) { call.reject("支付参数格式错误"); return; }
        IWXAPI api = WXAPIFactory.createWXAPI(getContext(), appId, true);
        if (!api.isWXAppInstalled()) { api.detach(); call.reject("请先安装微信后再付款"); return; }
        api.registerApp(appId);
        PayReq req = new PayReq();
        req.appId = appId;
        req.partnerId = call.getString("partnerid");
        req.prepayId = call.getString("prepayid");
        req.packageValue = call.getString("package");
        req.nonceStr = call.getString("noncestr");
        req.timeStamp = call.getString("timestamp");
        req.sign = call.getString("sign");
        boolean launched = api.sendReq(req);
        api.detach();
        if (!launched) { call.reject("微信收银台未能打开，请查询订单状态后重试"); return; }
        JSObject result = new JSObject(); result.put("launched", true); call.resolve(result);
    }
}
