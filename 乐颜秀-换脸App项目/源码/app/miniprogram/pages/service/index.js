const { createServiceClient, categories, serviceInformation } = require('../../service');
const confirm = options => new Promise(resolve => wx.showModal({ ...options, success: answer => resolve(answer.confirm === true), fail: () => resolve(false) }));
Page({
  data: { ...serviceInformation(null), loading: false, busy: false, categories,
    categoryIndex: 0, description: '', contact: '', receipt: null, reportNotice: '', refundOperator: false },
  async onLoad() {
    this.closed = false; this.visible = true; this.revision = 0;
    try {
      const config = getApp().globalData;
      this.client = createServiceClient(wx, config.apiTransport || config.apiBase);
      await this.refresh();
    } catch { this.setData({ ...serviceInformation(null), notice: '服务信息暂时无法读取，仍可通过公开客服联系。' }); }
  },
  async onShow() { this.visible = true; if (this.client && !this.data.loading && !this.data.busy) await this.refresh(); },
  onHide() { this.visible = false; this.revision++; this.setData({ description: '', contact: '', receipt: null, reportNotice: '', refundOperator: false }); },
  onUnload() { this.closed = true; this.client = null; },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  showError(error, revision = this.revision) {
    if (this.closed || !this.visible || revision !== this.revision) return;
    const changed = error?.code === 'XPAY_ACCOUNT_CHANGED';
    this.setData({ reportNotice: changed ? '微信账号已变化，请重新打开服务与帮助页。' : error?.message || '操作结果尚未确认，请稍后核实。',
      ...(changed ? { description: '', contact: '', receipt: null, available: false, refundOperator: false } : {}) });
  },
  async refresh() {
    if (!this.client || this.data.loading || this.data.busy) return;
    const revision = this.revision;
    this.setData({ loading: true, receipt: null, reportNotice: '', refundOperator: false });
    try { const value = await this.client.refresh(); if (!this.closed && this.visible && revision === this.revision) this.setData(value); }
    catch (error) { this.showError(error, revision); if (!this.closed && this.visible && revision === this.revision) this.setData({ ...(this.client.unavailableInformation?.() || serviceInformation(null)),
      notice: '服务信息暂时无法更新，完整说明仍待确认；公开客服仍可联系。' }); }
    finally { if (!this.closed) this.setData({ loading: false }); }
  },
  categoryChanged(event) { if (!this.data.busy) this.setData({ categoryIndex: Number(event.detail.value) }); },
  descriptionChanged(event) { if (!this.data.busy) this.setData({ description: event.detail.value }); },
  contactChanged(event) { if (!this.data.busy) this.setData({ contact: event.detail.value }); },
  async copyDocument(event) { try { await this.client.copyDocument(event.currentTarget.dataset.id); } catch (error) { this.showError(error); } },
  async copySupport() { try { await this.client.copySupport(); } catch (error) { this.showError(error); } },
  openRefundOperations() { if (this.data.refundOperator === true && !this.data.busy && !this.data.loading) wx.navigateTo({ url: '/pages/refund-ops/index' }); },
  async openPrivacy() { try { await this.client.openPrivacyContract(); } catch (error) { this.showError(error); } },
  async submitReport() {
    if (!this.client || this.data.busy || this.data.loading) return;
    const input = { category: this.data.categories[this.data.categoryIndex]?.id, description: this.data.description, contact: this.data.contact };
    const revision = this.revision;
    this.setData({ busy: true, reportNotice: '' });
    try {
      const receipt = await this.client.submitReport(input);
      if (!this.closed && this.visible && revision === this.revision) this.setData({ receipt, description: '', contact: '', reportNotice: '投诉举报已收到，待处理；回执不表示问题已解决。' });
    } catch (error) { this.showError(error, revision); }
    finally { if (!this.closed) this.setData({ busy: false }); }
  },
  async requestDeletion() {
    if (!this.client || this.data.busy || this.data.loading) return;
    const revision = this.revision;
    this.setData({ busy: true, reportNotice: '' });
    try {
      if (!await confirm({ title: '了解注销申请', content: '注销前需核对订单、退款、剩余权益和制作任务。申请不会自动清空余额或放弃权益；依法需要留存的交易及安全记录按规则保留。当前入口提交人工处理工单，不会立即注销账号。', confirmText: '已了解', cancelText: '取消' })) return;
      if (this.closed || !this.visible || revision !== this.revision) return;
      if (!await confirm({ title: '确认提交注销申请', content: '是否为当前登录的微信服务账号提交注销申请？收到工单回执仅表示申请已收到，账号及数据是否处理完成仍须客服确认。', confirmText: '提交申请', cancelText: '暂不申请' })) return;
      if (this.closed || !this.visible || revision !== this.revision) return;
      const receipt = await this.client.requestAccountDeletion({ informationConfirmed: true, applicationConfirmed: true });
      if (!this.closed && this.visible && revision === this.revision) this.setData({ receipt, description: '', contact: '', reportNotice: '注销申请已收到，待人工处理；账号尚未确认注销，剩余权益和订单以服务端记录为准。' });
    } catch (error) { this.showError(error, revision); }
    finally { if (!this.closed) this.setData({ busy: false }); }
  },
});
