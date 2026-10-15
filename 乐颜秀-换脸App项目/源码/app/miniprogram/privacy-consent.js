const invoke = (method, args = {}) => new Promise((resolve, reject) => {
  if (typeof wx[method] !== 'function') { reject(new Error('请升级微信后启用账号服务，您仍可浏览模板。')); return; }
  wx[method]({ ...args, success: resolve, fail: reject });
});
// This confirms WeChat's privacy notice only. It grants no face-processing,
// photo-upload, purchase or generation consent.
const privacyMethods = {
  async nativePrivacy() {
    const revision = this.revision;
    const setting = await invoke('getPrivacySetting');
    if (!this.visible || revision !== this.revision) throw new Error('页面已离开，本次操作取消。');
    if (!setting.needAuthorization) return invoke('requirePrivacyAuthorize');
    if (this.privacyTask) throw new Error('请先完成隐私指引确认。');
    return new Promise((resolve, reject) => {
      this.privacyTask = { resolve, reject, revision };
      this.setData({ privacyVisible: true, privacyName: setting.privacyContractName || '用户隐私保护指引' });
    });
  },
  async agreeNativePrivacy() {
    const task = this.privacyTask;
    if (!task || task.agreeing) return;
    task.agreeing = true;
    try {
      await invoke('requirePrivacyAuthorize');
      if (!this.visible || task.revision !== this.revision || this.privacyTask !== task) throw new Error('页面已离开，本次操作取消。');
      task.resolve();
    } catch { task.reject(new Error('尚未同意隐私指引，本次操作已取消。')); }
    finally { if (this.privacyTask === task) { this.privacyTask = null; this.setData({ privacyVisible: false }); } }
  },
  declineNativePrivacy() { this.cancelNativePrivacy(); },
  cancelNativePrivacy() {
    this.privacyTask?.reject(new Error('本次操作已取消。'));
    this.privacyTask = null;
    this.setData({ privacyVisible: false });
  },
  readNativePrivacy() {
    if (typeof wx.openPrivacyContract !== 'function') return wx.showToast({ title: '请升级微信后阅读隐私指引', icon: 'none' });
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引暂时无法打开', icon: 'none' }) });
  },
};
module.exports = { privacyMethods };
