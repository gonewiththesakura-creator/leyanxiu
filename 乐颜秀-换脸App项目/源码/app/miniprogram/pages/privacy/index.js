const support = require('../../public-support');
Page({
  data: { email: support.email, notice: '' },
  openService() { wx.navigateTo({ url: '/pages/service/index' }); },
  openCreation() { wx.navigateTo({ url: '/pages/create/index?view=privacy' }); },
  openNativePrivacy() {
    if (typeof wx.openPrivacyContract !== 'function') { this.setData({ notice: '当前微信暂不支持打开隐私指引，请升级微信或联系客服。' }); return; }
    wx.openPrivacyContract({ fail: () => this.setData({ notice: '暂时无法打开隐私指引，请稍后重试或联系客服。' }) });
  },
  copySupport() { wx.setClipboardData({ data: support.email }); },
});
