const { PHOTO_EFFECT_CATEGORIES, PHOTO_EFFECTS } = require('../../catalog/effects');
const { createCreationClient } = require('../../creation');
const { photoCards, photoSelection, resolvePhotoEffectId } = require('../../business-adapters');
const { privacyMethods } = require('../../privacy-consent');
const categories = PHOTO_EFFECT_CATEGORIES.map(item => ({ ...item, cover: '/assets' + item.cover }));
const effects = PHOTO_EFFECTS.map(item => ({ ...item, preview: '/assets' + item.preview, available: false }));
Page({
  ...privacyMethods,
  data: { categories, categoryId: 'time', category: categories[0], effects: effects.filter(item => item.categoryId === 'time'), checking: false, notice: '', connected: false, privacyVisible: false, privacyName: '用户隐私保护指引' },
  onLoad() {
    this.visible = true; this.revision = 0; this.ready = new Map(); this.snapshot = null; this.opening = false;
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: Math.max(info.statusBarHeight + 32, capsule && capsule.bottom + 12 || 0) });
  },
  onShow() { this.visible = true; this.renderCategory(); },
  onHide() { this.visible = false; this.revision++; this.opening = false; this.cancelNativePrivacy(); this.ready.clear(); this.snapshot = null; this.client?.setActive(false); this.setData({ connected: false, checking: false }); this.renderCategory(); },
  onUnload() { this.visible = false; this.revision++; this.cancelNativePrivacy(); this.client?.setActive(false); },
  selectCategory(event) {
    const id = event.currentTarget.dataset.id;
    if (!categories.some(item => item.id === id)) return;
    this.setData({ categoryId: id }); this.renderCategory();
  },
  renderCategory() {
    this.setData({ category: categories.find(item => item.id === this.data.categoryId) || categories[0],
      effects: photoCards(effects.filter(item => item.categoryId === this.data.categoryId), this.snapshot).map(item => ({ ...item,
        availabilityLabel: item.canCreate ? '选择照片' : (!this.snapshot && resolvePhotoEffectId(item.id) ? '选择效果' : '暂未开放'),
      })) });
  },
  async checkAvailability() {
    if (this.data.checking) return;
    const revision = this.revision;
    this.ready.clear(); this.snapshot = null; this.renderCategory(); this.setData({ checking: true, notice: '' });
    try {
      await this.nativePrivacy();
      if (!this.visible || revision !== this.revision) return;
      const config = getApp().globalData;
      this.client = createCreationClient(wx, config.apiTransport || config.apiBase, { enabled: config.creationEnabled === true });
      this.client.setActive(false);
      const snapshot = await this.client.refresh();
      if (!this.visible || revision !== this.revision) return;
      this.snapshot = snapshot;
      this.ready = new Map(photoCards(effects, snapshot).map(item => [item.id, item.canCreate]));
      this.setData({ connected: true, notice: this.ready.size && [...this.ready.values()].some(Boolean) ? '已核验当前可制作效果；选择与预览不会扣除次数。' : '当前效果暂未开放制作，您可以继续浏览。' });
      this.renderCategory();
    } catch (error) {
      if (this.visible && revision === this.revision) { this.ready.clear(); this.snapshot = null; this.renderCategory(); this.setData({ connected: false, notice: error?.message || '暂时无法核验服务，未开始制作，请稍后重试。' }); }
    } finally { if (this.visible && revision === this.revision) this.setData({ checking: false }); }
  },
  async openEffect(event) {
    const id = event.currentTarget.dataset.id;
    if (!effects.some(item => item.id === id) || !resolvePhotoEffectId(id)) {
      wx.showToast({ title: '这个效果暂未开放制作', icon: 'none' }); return;
    }
    if (!this.visible || this.opening || this.data.checking) return;
    const revision = this.revision;
    this.opening = true;
    try {
      // A card is the product entry. Resolve privacy and service availability
      // here, without requiring a separate diagnostic button first.
      if (!this.snapshot) await this.checkAvailability();
      if (!this.visible || revision !== this.revision) return;
      const selection = photoSelection(id, this.snapshot);
      if (!selection.canCreate) {
        wx.showToast({ title: this.snapshot ? '这个效果暂未开放制作' : '尚未连接，请重试', icon: 'none' }); return;
      }
      wx.navigateTo({ url: '/pages/create/index?effectId=' + encodeURIComponent(selection.serviceEffectId),
        fail: () => { if (this.visible && revision === this.revision) this.opening = false; },
      });
    } finally {
      if (this.visible && revision === this.revision && !photoSelection(id, this.snapshot).canCreate) this.opening = false;
    }
  },
  caption() { wx.showToast({ title: '分享文案暂未开放', icon: 'none' }); },
});
