const { createPaymentClient } = require('../../payments');
const { privacyMethods } = require('../../privacy-consent');
// This is the reviewed mini-program contract, not the full browsable App catalog.
const contractedEffects = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
const contractedTitles = ['自然 AI 头像', '现代漫画像', '温润水彩像'];
function verifiedEffects(catalog) {
  const policy = catalog?.miniProgramCreation, entries = catalog?.photoEffects;
  const ids = policy?.photoEffectIds;
  if (policy?.available !== true || catalog?.settings?.generationEnabled !== true
    || policy.jobProtocol !== 'photo-jobs-v1' || policy.uploadProtocol !== 'photo-uploads-v1'
    || !Array.isArray(ids) || ids.length !== 3 || !Array.isArray(entries) || entries.length !== 3
    || !contractedEffects.every(id => ids.filter(value => value === id).length === 1
      && entries.filter(value => value?.id === id && value.enabled === true
        && value.available !== false && value.included !== false).length === 1)) return [];
  return contractedEffects.map((id, index) => ({ id, title: contractedTitles[index] }));
}
function reviewedPhotoProduct(product, rulesVersion) {
  const part = product?.components?.[0];
  return rulesVersion === 'mini-pay-v1-20260927' && product?.id === 'photo10' && product.type === 'pack'
    && product.amountFen === 990 && product.days === 365 && product.components?.length === 1
    && part.kind === 'photo' && part.quantity === 10 && part.valueFen === 990;
}
const states = { pending: '正在确认', paid: '已支付', refund_pending: '退款审核中', refunded: '已退款', closed: '已关闭' };
const emptyAccount = () => ({ connected: false, available: false, purchaseSupported: false, ledgerOnlySandbox: false,
  products: [], orders: [], refunds: [], buckets: [], includedEffects: [], scopeVerified: false, merchantTest: false, photo: 0, video: 0, agreement: false, rulesVersion: null });
Page({
  ...privacyMethods,
  data: { ...emptyAccount(), activeTab: 'plans', returnLabel: '返回百变图片', loading: false, connecting: false, refreshing: false, notice: '确认隐私指引后，可读取套餐、次数、订单及退款记录。',
    privacyVisible: false, privacyName: '用户隐私保护指引',
    privacyDescription: '同意后将连接当前微信账号，读取可用套餐、制作次数、订单及退款记录；本次不会上传照片、制作或购买。每次购买及退款仍需单独确认。' },
  currentView(revision = this.revision) { return this.visible === true && !this.unloaded && revision === this.revision; },
  ready(revision = this.revision, client = this.client) { return this.currentView(revision) && this.data.connected === true && !!client && client === this.client; },
  showError(error) {
    this.setData({ ...emptyAccount(), notice: error?.message || '服务暂不可用，请重新连接查询' });
  },
  async onLoad(options = {}) {
    this.visible = true; this.unloaded = false; this.revision = 0;
    this.returnEffectId = options.returnTo === 'creation' && contractedEffects.includes(options.effectId)
      ? options.effectId : null;
    this.setData({ returnLabel: this.returnEffectId ? '返回所选效果' : '返回百变图片' });
    return this.connect();
  },
  onShow() { if (!this.unloaded) this.visible = true; },
  onHide() {
    this.visible = false; this.revision = (this.revision || 0) + 1;
    this.cancelNativePrivacy(); this.client?.setActive(false); this.client = null; this.connectTask = null; this.refreshTask = null;
    this.setData({ ...emptyAccount(), loading: false, connecting: false, refreshing: false, notice: '请重新连接，查询当前账号的套餐及订单。' });
  },
  onUnload() { this.onHide(); this.unloaded = true; },
  async connect() {
    if (!this.currentView() || this.connectTask || this.data.loading) return false;
    const task = { revision: this.revision }; this.connectTask = task;
    this.setData({ ...emptyAccount(), connecting: true, notice: '确认隐私指引后读取套餐、次数、订单及退款记录；不会自动购买。' });
    try {
      await this.nativePrivacy();
      if (!this.currentView(task.revision) || this.connectTask !== task) return false;
      const config = getApp().globalData;
      const client = createPaymentClient(wx, config.apiTransport || config.apiBase); this.client = client;
      await client.login();
      if (!this.currentView(task.revision) || this.client !== client || this.connectTask !== task) return false;
      this.setData({ connected: true });
      return await this.refresh();
    } catch (error) { if (this.currentView(task.revision) && this.connectTask === task) this.showError(error); return false; }
    finally {
      if (this.connectTask === task) { this.connectTask = null; if (this.currentView(task.revision)) this.setData({ connecting: false }); }
    }
  },
  async onPullDownRefresh() { try { if (!this.data.loading) await (this.ready() ? this.refresh() : this.connect()); } finally { wx.stopPullDownRefresh(); } },
  agreementChanged(event) { if (this.ready()) this.setData({ agreement: event.detail.value.includes('accepted') }); },
  selectTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (['plans', 'orders'].includes(tab)) this.setData({ activeTab: tab });
  },
  showOrders() { this.setData({ activeTab: 'orders' }); },
  openCreation() {
    if (!this.returnEffectId) { wx.switchTab({ url: '/pages/photos/index' }); return; }
    const url = '/pages/create/index?effectId=' + encodeURIComponent(this.returnEffectId);
    const pages = getCurrentPages(), previous = pages[pages.length - 2];
    if (previous?.route === 'pages/create/index' && previous.data?.effectId === this.returnEffectId) {
      wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url }) });
    } else wx.redirectTo({ url });
  },
  openService() { wx.navigateTo({ url: '/pages/service/index' }); },
  async refresh() {
    if (!this.ready() || this.refreshTask) return false;
    const task = { revision: this.revision, client: this.client }; this.refreshTask = task;
    this.setData({ refreshing: true });
    try {
      const [catalog, entitlements, orders] = await Promise.all([task.client.products(), task.client.entitlements(), task.client.orders()]);
      if (!this.ready(task.revision, task.client) || this.refreshTask !== task) return false;
      const ledgerOnlySandbox = catalog.ledgerOnlySandbox === true;
      const purchase = task.client.purchaseAvailability(catalog);
      let includedEffects = [];
      // Read with the same account/session. No creation client is instantiated:
      // a purchase-page refresh must never resume an old photo upload/job.
      if (!ledgerOnlySandbox && purchase.supported) {
        try { includedEffects = verifiedEffects(await task.client.request('/api/catalog')); } catch {}
      }
      if (!this.ready(task.revision, task.client) || this.refreshTask !== task) return false;
      const scopeVerified = includedEffects.length === 3;
      const products = (purchase.supported ? catalog.products : []).filter(product => ledgerOnlySandbox
        || scopeVerified && reviewedPhotoProduct(product, catalog.rulesVersion));
      const productConfirmed = ledgerOnlySandbox || products.length === 1 && catalog.products.length === 1;
      const refunds = await task.client.refunds();
      if (!this.ready(task.revision, task.client) || this.refreshTask !== task) return false;
      this.setData({ available: purchase.available && productConfirmed && (ledgerOnlySandbox || scopeVerified), purchaseSupported: purchase.supported, ledgerOnlySandbox,
        includedEffects, scopeVerified, merchantTest: !ledgerOnlySandbox && catalog.mode === 'merchant_test',
        rulesVersion: catalog.rulesVersion, photo: entitlements.available.photo, video: entitlements.available.video,
        refunds: refunds.map(refund => ({ id: refund.id, orderId: refund.orderId, price: (refund.amountFen / 100).toFixed(2),
          canConfirm: ledgerOnlySandbox && refund.status === 'requested', statusText: ({ requested: ledgerOnlySandbox ? '待确认沙箱退款' : '待人工审核',
            processing: '渠道确认中，尚未确认到账', succeeded: '渠道已确认退款完成', rejected: '已拒绝，冻结权益已恢复', abnormal: '退款异常，权益保持冻结，需联系客服核实', review_required: '需要核对' })[refund.status] || '待核实' })),
        buckets: entitlements.buckets.map(b => ({ ...b, name: b.kind === 'photo' ? '图片' : '标准视频', starts: new Date(b.starts_at).toLocaleDateString(), expires: new Date(b.expires_at).toLocaleDateString(), state: b.starts_at > Date.now() ? '待生效' : b.expires_at <= Date.now() ? '已到期' : '有效' })),
        products: (productConfirmed ? products : []).map(p => ({ ...p, price: (p.amountFen / 100).toFixed(2), rights: p.components.map(x => `${x.kind === 'photo' ? '图片' : '标准视频'} ${x.quantity} 次`).join(' + ') })),
        orders: orders.map(o => ({ ...o, price: (o.amountFen / 100).toFixed(2), statusText: states[o.status] || '待核实', time: new Date(o.createdAt).toLocaleString(), canRefund: o.status === 'paid' })),
        notice: ledgerOnlySandbox ? (catalog.available ? '沙箱联调可能实际扣款，以微信收银台为准；图片创作尚未开放。' : '沙箱购买暂未开放，已有订单可查询。沙箱联调可能实际扣款，以微信收银台为准；图片创作尚未开放。')
          : !purchase.supported ? purchase.message : !scopeVerified || !productConfirmed ? '套餐或适用效果尚未核实，暂不能购买。已有订单、权益与退款仍可查询。'
            : purchase.available ? '一次购买，到期不自动扣款。购买与制作分别确认。' : purchase.message });
      return true;
    } catch (error) { if (this.ready(task.revision, task.client) && this.refreshTask === task) this.showError(error); return false; }
    finally { if (this.refreshTask === task) { this.refreshTask = null; if (this.currentView(task.revision)) this.setData({ refreshing: false }); } }
  },
  async buy(event) {
    if (!this.ready() || this.data.loading || this.data.connecting || this.data.refreshing) return;
    const revision = this.revision, client = this.client;
    const product = this.data.products.find(item => item.id === event.currentTarget.dataset.id);
    if (!this.client || !this.data.available || !product || !Number.isSafeInteger(product.amountFen) || product.amountFen <= 0) {
      wx.showToast({ title: '套餐金额尚未确认，请刷新', icon: 'none' }); return;
    }
    if (!this.data.agreement) { wx.showToast({ title: '请先确认套餐及退款规则', icon: 'none' }); return; }
    const confirmation = { expectedAmountFen: product.amountFen, expectedProductId: product.id,
      expectedEnv: this.data.ledgerOnlySandbox ? 1 : 0 };
    const sandbox = this.data.ledgerOnlySandbox;
    const rulesVersion = this.data.rulesVersion;
    // Keep the contract the user saw, not a later quote with the same ID/price.
    const confirmedContract = JSON.stringify({ id: product.id, amountFen: product.amountFen,
      type: product.type, days: product.days, components: product.components });
    confirmation.validateFreshCatalog = fresh => {
      const match = fresh?.products?.filter(item => item.id === confirmation.expectedProductId) || [];
      if (match.length !== 1 || fresh.rulesVersion !== rulesVersion) return false;
      const item = match[0];
      return JSON.stringify({ id: item.id, amountFen: item.amountFen, type: item.type,
        days: item.days, components: item.components }) === confirmedContract
        && (sandbox ? fresh.ledgerOnlySandbox === true : fresh.ledgerOnlySandbox !== true
          && fresh.products.length === 1 && reviewedPhotoProduct(item, fresh.rulesVersion));
    };
    this.setData({ loading: true });
    try {
      const answer = await new Promise(resolve => wx.showModal({ title: sandbox ? '确认沙箱联调支付' : '确认支付',
        content: `所选套餐金额 ¥${(confirmation.expectedAmountFen / 100).toFixed(2)}。${sandbox
          ? '沙箱联调可能实际扣款，以微信收银台为准；图片创作尚未开放。'
          : '继续支付可能实际扣款，请以微信收银台显示金额为准。'}已有待确认订单请先刷新结果，勿重复付款。`,
        confirmText: '继续支付', cancelText: '取消', success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!answer.confirm || !this.ready(revision, client)) return;
      if (!sandbox) {
        const scope = verifiedEffects(await client.request('/api/catalog'));
        if (!this.ready(revision, client)) return;
        if (scope.length !== 3) throw new Error('适用效果已变化，请重新查看套餐；本次未发起购买。');
      }
      const result = await client.buy(confirmation.expectedProductId, rulesVersion, confirmation);
      if (!this.ready(revision, client)) return;
      if (!await this.refresh()) return;
      if (!this.ready(revision, client)) return;
      this.setData({ activeTab: 'orders', agreement: false });
      // Refresh may advance payment/refund state. Never announce success from
      // the older buy response, or from an unrelated order in the refreshed list.
      const orderId = result?.order?.id;
      const current = typeof orderId === 'string' && orderId
        ? this.data.orders.find(order => order.id === orderId) : null;
      const messages = {
        paid: { title: this.data.ledgerOnlySandbox ? '沙箱测试支付成功' : '购买成功',
          content: this.data.ledgerOnlySandbox ? '沙箱订单已确认支付，次数已记录。实际扣款以微信支付记录为准；图片创作尚未开放。' : '权益已到账，可查看剩余次数与有效期。' },
        pending: { title: '订单正在确认', content: '请在订单记录中刷新结果。暂时不要再次购买。' },
        closed: { title: '订单已关闭', content: '渠道确认该订单已关闭。请核对微信支付记录；如有疑问，请联系客户支持。' },
        refund_pending: { title: '退款处理中', content: '订单已进入退款流程，请在退款记录查看进度。原路退款结果以渠道确认为准，请勿重复申请。' },
        refunded: { title: '订单已退款', content: '渠道已确认该订单退款，请核对渠道退款记录及原路到账情况。' },
      };
      const message = Object.prototype.hasOwnProperty.call(messages, current?.status) ? messages[current.status]
        : { title: '订单状态待核实', content: '本次刷新尚未确认该订单，请在订单记录中核实，暂时不要再次购买。' };
      wx.showModal({ ...message, showCancel: false });
    } catch (error) { if (this.currentView(revision) && this.client === client) this.showError(error); }
    finally { if (this.currentView(revision) && this.client === client) this.setData({ loading: false }); }
  },
  async queryOrder(event) {
    if (!this.ready() || this.data.loading || this.data.refreshing || this.data.connecting) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.orders.some(order => order.id === id)) return;
    const revision = this.revision, client = this.client; this.setData({ loading: true });
    try { await client.refreshOrder(id); if (this.ready(revision, client)) await this.refresh(); }
    catch (error) { if (this.currentView(revision) && this.client === client) this.showError(error); }
    finally { if (this.currentView(revision) && this.client === client) this.setData({ loading: false }); }
  },
  async refundOrder(event) {
    if (!this.ready() || this.data.loading || this.data.refreshing || this.data.connecting) return;
    const order = this.data.orders.find(x => x.id === event.currentTarget.dataset.id);
    if (!order || !this.client) return;
    if (order.platform === 'ios') { wx.showModal({ title: 'Apple 支付订单退款', content: '请在 Apple 的报告问题页面申请退款。结果由 Apple 审核，完成后这里会同步。', showCancel: false }); return; }
    const revision = this.revision, client = this.client; this.setData({ loading: true });
    try {
      const answer = await new Promise(resolve => wx.showModal({ title: '申请未使用部分退款', content: '提交后，该订单剩余次数暂时冻结。金额按购买时各项权益金额、剩余次数和会员剩余时间计算，以审核结果为准。其他订单权益不受影响。', success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!answer.confirm || !this.ready(revision, client)) return;
      const refund = await client.refund(order.id, '用户申请未使用部分退款');
      if (!this.ready(revision, client) || !await this.refresh() || !this.ready(revision, client)) return;
      wx.showModal({ title: '申请已提交',
      content: this.data.ledgerOnlySandbox ? `待确认退款金额 ¥${(refund.amountFen / 100).toFixed(2)}。请在下方退款记录确认沙箱退款，原路退款结果以渠道确认为准。`
        : `待审核金额 ¥${(refund.amountFen / 100).toFixed(2)}，审核通过后原路退回。`, showCancel: false }); }
    catch (error) { if (this.currentView(revision) && this.client === client) this.showError(error); }
    finally { if (this.currentView(revision) && this.client === client) this.setData({ loading: false }); }
  },
  async confirmSandboxRefund(event) {
    if (!this.ready() || !this.data.ledgerOnlySandbox || this.data.loading || this.data.refreshing || this.data.connecting) return;
    const refund = this.data.refunds.find(item => item.id === event.currentTarget.dataset.id && item.canConfirm);
    if (!refund) return;
    const revision = this.revision, client = this.client;
    this.setData({ loading: true });
    try {
      const answer = await new Promise(resolve => wx.showModal({ title: '确认沙箱退款',
        content: `确认对本人这笔订单申请退款 ¥${refund.price}。原路退款结果以渠道确认为准，请核对微信支付记录。`,
        success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!answer.confirm || !this.ready(revision, client)) return;
      await client.confirmSandboxRefund(refund.id); if (this.ready(revision, client)) await this.refresh();
    }
    catch (error) { if (this.currentView(revision) && this.client === client) this.showError(error); }
    finally { if (this.currentView(revision) && this.client === client) this.setData({ loading: false }); }
  },
});
