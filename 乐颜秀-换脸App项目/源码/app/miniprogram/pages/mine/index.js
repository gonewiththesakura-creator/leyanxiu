const { createCreationClient } = require('../../creation');
const support = require('../../public-support');
const { privacyMethods } = require('../../privacy-consent');
Page({
  ...privacyMethods,
  data: { connected: false, busy: false, photo: null, works: [], notice: '', email: support.email, privacyVisible: false, privacyName: '用户隐私保护指引' },
  onLoad() {
    this.visible = true; this.revision = 0;
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: Math.max(info.statusBarHeight + 44, capsule && capsule.bottom + 12 || 0) });
  },
  onShow() { this.visible = true; },
  onHide() { this.visible = false; this.revision++; this.cancelNativePrivacy(); this.client?.setActive(false); this.setData({ connected: false, busy: false, photo: null, works: [], notice: '' }); },
  onUnload() { this.visible = false; this.revision++; this.cancelNativePrivacy(); this.client?.setActive(false); this.client = null; },
  async connect() {
    if (this.data.busy) return;
    const revision = this.revision;
    this.setData({ busy: true, notice: '', connected: false, photo: null, works: [] });
    try {
      await this.nativePrivacy();
      if (!this.visible || revision !== this.revision) return;
      const config = getApp().globalData;
      this.client = createCreationClient(wx, config.apiTransport || config.apiBase, { enabled: config.creationEnabled === true });
      this.client.setActive(false);
      const snapshot = await this.client.refresh();
      if (!this.visible || revision !== this.revision) return;
      this.setData({ connected: true, photo: snapshot.photo, works: snapshot.works.map(item => ({ assetId: item.assetId, title: item.templateName || item.effectName || '图片作品', time: new Date(item.createdAt).toLocaleString() })), notice: snapshot.pending ? '原制作任务仍待确认，请进入创作页查看，勿重复制作。' : '' });
    } catch (error) {
      if (this.visible && revision === this.revision) this.setData({ connected: false, photo: null, works: [], notice: error?.message || '暂时无法读取账号信息，未开始制作或购买。' });
    } finally { if (this.visible && revision === this.revision) this.setData({ busy: false }); }
  },
  openPayments() { if (!this.data.busy) wx.navigateTo({ url: '/pages/payments/index' }); },
  openService() { wx.navigateTo({ url: '/pages/service/index' }); },
  openPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }); },
  make() { wx.switchTab({ url: '/pages/photos/index' }); },
  async previewWork(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.client || this.data.busy || !this.data.works.some(item => item.assetId === id)) return;
    const revision = this.revision;
    this.setData({ busy: true });
    try {
      const result = await this.client.assetUrl(id);
      if (this.visible && revision === this.revision) wx.previewImage({ urls: [result.url], current: result.url });
    } catch (error) {
      if (this.visible && revision === this.revision) this.setData({ notice: error?.message || '作品暂时无法查看', ...(error?.code === 'XPAY_ACCOUNT_CHANGED' ? { works: [], photo: null, connected: false } : {}) });
    } finally { if (this.visible && revision === this.revision) this.setData({ busy: false }); }
  },
  manageWorks() { if (!this.data.busy && this.data.connected) wx.navigateTo({ url: '/pages/create/index?view=works' }); },
  copySupport() { wx.setClipboardData({ data: support.email }); },
});
