const { VIDEO_TEMPLATES } = require('../../catalog/templates');
const { videoCards } = require('../../business-adapters');
const templates = videoCards(VIDEO_TEMPLATES).map(item => ({ ...item, cover: '/assets' + item.cover, isNew: Date.parse(item.publishedAt || '') >= Date.parse('2026-08-23T00:00:00+08:00'), action: item.group === 'dancing' ? '跳起来' : item.group === 'quote' ? '说这句' : '唱这首' }));
const banners = [
  { id: 'classic', image: '/assets/banners/classic-song-r13.webp', kicker: '欢唱经典', title: '熟悉的旋律，唱出你的故事', action: '唱这首', templateId: 'jinqu' },
  { id: 'dance', image: '/assets/banners/photo-dance-r13.webp', kicker: '照片跳舞', title: '一张照片，轻松跳起来', action: '跳起来', templateId: 'dance' },
  { id: 'quote', image: '/assets/banners/warm-quote-r13.webp', kicker: '经典台词', title: '把心里那句话，说给懂的人', action: '说这句', templateId: 'quote' },
];
Page({
  data: { top: 48, categories: ['热门', '欢唱经典', '男生', '女生', '经典台词', '照片跳舞'], category: '热门', banners, templates, bannerIndex: 0 },
  onLoad() {
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: Math.max(info.statusBarHeight + 44, capsule && capsule.bottom + 12 || 0) });
  },
  selectCategory(event) {
    const category = event.currentTarget.dataset.category;
    if (!this.data.categories.includes(category)) return;
    const filters = { '欢唱经典': item => item.group === 'singing', '经典台词': item => item.group === 'quote', '照片跳舞': item => item.group === 'dancing', '男生': item => item.audience === 'male' || item.audience === 'all', '女生': item => item.audience === 'female' || item.audience === 'all' };
    this.setData({ category, templates: filters[category] ? templates.filter(filters[category]) : templates });
  },
  bannerChanged(event) { this.setData({ bannerIndex: event.detail.current }); },
  preview(event) {
    const id = event.currentTarget.dataset.id;
    if (!templates.some(item => item.id === id)) return;
    getApp().globalData.previewTemplateId = id;
    wx.switchTab({ url: '/pages/featured/index' });
  },
  openMine() { wx.switchTab({ url: '/pages/mine/index' }); },
  openPayments() { wx.navigateTo({ url: '/pages/payments/index' }); },
});
