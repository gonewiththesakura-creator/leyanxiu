const { createRefundOperationsClient } = require('../../refund-operations');
const confirm = options => new Promise(resolve => wx.showModal({ ...options, success: result => resolve(result.confirm === true), fail: () => resolve(false) }));
Page({
  data: { operator: false, records: [], pending: null, selected: null, busy: false, notice: '请重新登录微信，验证退款审核权限。' },
  onLoad() {
    this.visible = true; this.closed = false; this.revision = 0;
    try { const config = getApp().globalData; this.client = createRefundOperationsClient(wx, config.apiTransport || config.apiBase); }
    catch { this.setData({ notice: '服务尚未配置完成，退款审核暂不可用。' }); }
  },
  onShow() { this.visible = true; this.client?.setActive(true); },
  onHide() { this.visible = false; this.revision++; this.client?.setActive(false); this.setData({ selected: null, records: [] }); },
  onUnload() { this.closed = true; this.client?.setActive(false); this.client = null; },
  apply(value, revision) { if (!this.closed && this.visible && revision === this.revision) this.setData(value); },
  async run(action) {
    if (!this.client || this.data.busy) return;
    const revision = this.revision; this.setData({ busy: true });
    try { await action(revision); }
    catch (error) { this.apply({ ...this.client?.snapshot(), notice: error?.message || '结果尚未确认，请刷新原退款记录。',
      ...(['XPAY_ACCOUNT_CHANGED', 'XPAY_REFUND_OPERATOR_FORBIDDEN'].includes(error?.code) ? { operator: false, records: [], selected: null } : {}) }, revision); }
    finally { if (!this.closed) this.setData({ busy: false }); }
  },
  login() { return this.run(async revision => this.apply({ ...await this.client.login(), selected: null, notice: '仅审核已申请的退款；通过审核不表示款项已到账。' }, revision)); },
  refresh() { return this.run(async revision => this.apply({ ...await this.client.refresh(), selected: null, notice: '已读取原退款状态。未确认的审核只查询，不重复提交。' }, revision)); },
  select(event) { return this.run(async revision => this.apply({ selected: await this.client.detail(event.currentTarget.dataset.id), notice: '' }, revision)); },
  async review(event) {
    return this.run(async revision => {
      const selected = this.data.selected; if (!selected || !selected.reviewable || this.data.pending) return;
      const decision = event.currentTarget.dataset.decision;
      if (!['approve', 'reject'].includes(decision)) return;
      const approve = decision === 'approve';
      const accepted = await confirm({ title: approve ? '确认通过退款审核' : '确认拒绝退款申请',
        content: `订单 ${selected.orderId}\n退款 ¥${selected.amount}\n${approve ? '通过后进入退款队列，到账以渠道确认结果为准。' : '拒绝后恢复该订单冻结权益，不会退款。'}`,
        confirmText: approve ? '确认通过' : '确认拒绝', cancelText: '暂不操作' });
      if (!accepted || this.closed || !this.visible || revision !== this.revision) return;
      const result = await this.client.review(selected, approve, true);
      this.apply({ ...this.client.snapshot(), selected: result, notice: result.statusLabel }, revision);
    });
  },
});
