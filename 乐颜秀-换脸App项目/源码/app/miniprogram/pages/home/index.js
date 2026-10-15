const { VIDEO_TEMPLATES } = require('../../catalog/templates');
const { videoCards } = require('../../business-adapters');
const templates = videoCards(VIDEO_TEMPLATES).map(item => ({ ...item, cover: '/assets' + item.cover }));
Page({
  data: { categories: ['编辑推荐', '经典精选', '最近上新'], category: '编辑推荐', templates, top: 48 },
  onLoad() {
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const capsule = typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: Math.max(info.statusBarHeight + 44, capsule && capsule.bottom + 12 || 0) });
  },
  selectCategory(event) {
    const category = event.currentTarget.dataset.category;
    if (!this.data.categories.includes(category)) return;
    this.setData({ category, templates: category === '经典精选' ? templates.filter(item => /经典/.test(item.name + item.description)) : templates });
  },
  preview(event) {
    const id = event.currentTarget.dataset.id;
    if (!templates.some(item => item.id === id)) return;
    getApp().globalData.previewTemplateId = id;
    wx.switchTab({ url: '/pages/featured/index' });
  },
});
