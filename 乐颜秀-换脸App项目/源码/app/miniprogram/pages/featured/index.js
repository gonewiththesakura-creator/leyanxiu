const { FEATURED_TEMPLATES } = require('../../catalog/templates');
const { videoCards } = require('../../business-adapters');
const templates = videoCards(FEATURED_TEMPLATES).map(item => ({ ...item, cover: '/assets' + item.cover, previewSrc: '/preview-media' + item.previewVideo }));
Page({
  data: { templates, current: 0, visible: false, mediaReady: false, muted: true, previewFailed: false, top: 48 },
  onLoad() {
    this.revision = 0;
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: Math.max(info.statusBarHeight + 12, capsule && capsule.bottom + 12 || 0) });
  },
  onShow() {
    this.revision++;
    const selected = getApp().globalData.previewTemplateId;
    delete getApp().globalData.previewTemplateId;
    const index = templates.findIndex(item => item.id === selected);
    this.setData({ visible: true, previewFailed: false, mediaReady: false, ...(index >= 0 ? { current: index } : {}) });
  },
  onHide() { this.revision++; this.pauseVideo(); this.setData({ visible: false }); },
  onUnload() { this.revision++; this.pauseVideo(); },
  previewPlayed() { if (this.data.visible) this.setData({ mediaReady: true, previewFailed: false }); },
  previewSettled() { if (this.data.visible) this.selectComponent('#featured-preview-' + this.data.current)?.resume(); },
  pauseVideo() {
    try { this.selectAllComponents('.preview').forEach(player => player.pause()); } catch (_) { /* Page may already have left. */ }
  },
  changed(event) {
    const next = event.detail.current;
    if (!Number.isInteger(next) || next < 0 || next >= templates.length || next === this.data.current) return;
    this.pauseVideo(); this.setData({ current: next, mediaReady: false, previewFailed: false });
  },
  toggleSound() { this.setData({ muted: !this.data.muted }); },
  previewError(event) { this.setData({ previewFailed: true, previewDiagnostic: String(event?.detail?.errMsg || 'VIDEO_PREVIEW_UNAVAILABLE').slice(0, 240) }); },
  creationUnavailable() { wx.showToast({ title: '视频创作暂未开放，不会扣款', icon: 'none' }); },
});
