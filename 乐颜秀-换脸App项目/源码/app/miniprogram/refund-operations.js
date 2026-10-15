const { createPaymentClient } = require('./payments');
const base = '/api/mini/operations/refunds';
const fail = (message, code) => Object.assign(new Error(message), { code });
const labels = { requested: '待人工审核', processing: '退款处理中，尚未确认到账', succeeded: '渠道已确认退款完成',
  rejected: '申请已拒绝，冻结权益已恢复', abnormal: '退款异常，仍需核实，权益保持冻结' };
function refundView(value) {
  if (!value || !/^[a-f0-9]{32}$/.test(value.id || '') || !/^[a-f0-9]{32}$/.test(value.orderId || '')
    || !Number.isSafeInteger(value.amountFen) || value.amountFen <= 0 || !Object.hasOwn(labels, value.status)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || value.reviewable !== (value.status === 'requested')) {
    throw fail('退款记录尚未确认，请刷新原记录', 'REFUND_OPS_RECEIPT_INVALID');
  }
  return { id: value.id, orderId: value.orderId, amountFen: value.amountFen, amount: (value.amountFen / 100).toFixed(2),
    status: value.status, statusLabel: labels[value.status], createdAt: value.createdAt, reviewable: value.reviewable };
}

function createRefundOperationsClient(wxApi, endpoint) {
  const api = createPaymentClient(wxApi, endpoint);
  let busy = false, operator = false, account, pending, records = [], active = true, activityRevision = 0;
  const key = () => `lyx-refund-review-pending:${account}`;
  const ensureIdentity = () => {
    if (!account || api.currentAccountId() !== account) throw fail('微信账号已变化，请重新打开页面', 'XPAY_ACCOUNT_CHANGED');
  };
  const persisted = value => value && /^[a-f0-9]{32}$/.test(value.refundId || '') && /^[a-f0-9]{32}$/.test(value.orderId || '')
    && Number.isSafeInteger(value.amountFen) && value.amountFen > 0 && typeof value.approve === 'boolean';
  const snapshot = () => ({ operator, records: records.map(value => ({ ...value })), pending: pending ? { ...pending } : null });
  const recover = async () => {
    if (!pending) return null;
    if (!persisted(pending)) throw fail('上次审核记录尚未确认，请人工核对，勿重复审核', 'REFUND_OPS_UNCONFIRMED');
    const value = refundView(await api.request(`${base}/${pending.refundId}`)); ensureIdentity();
    if (value.id !== pending.refundId || value.orderId !== pending.orderId || value.amountFen !== pending.amountFen) {
      throw fail('原退款金额或订单已变化，请人工核对', 'REFUND_OPS_UNCONFIRMED');
    }
    if (value.status !== 'requested') { wxApi.removeStorageSync(key()); pending = null; }
    return value;
  };
  const load = async () => {
    const values = await api.request(base); ensureIdentity();
    if (!Array.isArray(values) || values.length > 100) throw fail('退款列表尚未确认', 'REFUND_OPS_RECEIPT_INVALID');
    records = values.map(refundView);
    await recover();
    return snapshot();
  };
  return {
    setActive(value) { if (active !== (value === true)) activityRevision++; active = value === true; },
    snapshot,
    async login() {
      if (busy) throw fail('上一项操作尚未完成', 'REFUND_OPS_BUSY');
      busy = true; operator = false; records = [];
      try {
        await api.login(); const id = api.currentAccountId();
        if (typeof id !== 'string' || !/^usr_[a-f0-9-]{36}$/.test(id)) throw fail('微信身份尚未确认', 'XPAY_ACCOUNT_CHANGED');
        if (account && account !== id) throw fail('微信账号已变化，请重新打开页面', 'XPAY_ACCOUNT_CHANGED');
        account = id;
        const status = await api.request('/api/mini/operations/status'); ensureIdentity();
        if (status?.operator !== true) throw fail('当前账号没有退款审核权限', 'XPAY_REFUND_OPERATOR_FORBIDDEN');
        operator = true;
        pending = wxApi.getStorageSync(key()) || null;
        return await load();
      } finally { busy = false; }
    },
    async refresh() {
      if (busy) throw fail('上一项操作尚未完成', 'REFUND_OPS_BUSY');
      if (!operator) throw fail('请先重新登录并验证运营权限', 'XPAY_REFUND_OPERATOR_RELOGIN_REQUIRED');
      busy = true;
      try { return await load(); }
      finally { busy = false; }
    },
    async detail(refundId) {
      if (busy || !operator || !/^[a-f0-9]{32}$/.test(refundId || '')) throw fail('请先登录并刷新退款列表', 'REFUND_OPS_BUSY');
      busy = true;
      try { const value = refundView(await api.request(`${base}/${refundId}`)); ensureIdentity();
        if (value.id !== refundId) throw fail('退款编号不一致，请刷新', 'REFUND_OPS_RECEIPT_INVALID'); return value; }
      finally { busy = false; }
    },
    async review(value, approve, confirmed) {
      if (busy) throw fail('上一项审核尚未完成', 'REFUND_OPS_BUSY');
      if (!operator || !active || confirmed !== true || typeof approve !== 'boolean') throw fail('请核对退款金额并确认审核决定', 'REFUND_OPS_CONFIRMATION_REQUIRED');
      const selected = refundView(value);
      const revision = activityRevision;
      if (!selected.reviewable) throw fail('此退款已经审核，请刷新原记录', 'REFUND_OPS_ALREADY_REVIEWED');
      busy = true;
      try {
        ensureIdentity(); pending = wxApi.getStorageSync(key()) || null;
        if (pending) throw fail('上次审核尚未确认，请只刷新原记录，勿重复提交', 'REFUND_OPS_UNCONFIRMED');
        // A fresh login cannot change the account. Recheck the displayed amount
        // before the one mutation; neither reads nor authentication charge money.
        await api.login(); ensureIdentity();
        const current = refundView(await api.request(`${base}/${selected.id}`)); ensureIdentity();
        if (!active || revision !== activityRevision) throw fail('页面已离开，本次未提交审核', 'REFUND_OPS_INACTIVE');
        if (current.id !== selected.id || current.orderId !== selected.orderId || current.amountFen !== selected.amountFen || !current.reviewable) {
          throw fail('原退款记录已变化，请重新打开并确认', 'REFUND_OPS_CONFIRMATION_CHANGED');
        }
        const intended = { refundId: selected.id, orderId: selected.orderId, amountFen: selected.amountFen, approve };
        wxApi.setStorageSync(key(), intended); pending = intended;
        // Persistence must succeed before POST; an ambiguous POST is never
        // repeated by this client, including after restart or page re-entry.
        let result;
        try { result = refundView(await api.request(`${base}/${selected.id}/review`, { method: 'POST', data: {
          confirm: true, approve, expectedOrderId: selected.orderId, expectedAmountFen: selected.amountFen } })); }
        catch (error) {
          if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error;
          throw fail('审核结果尚未确认，请刷新原退款记录，勿重复提交', 'REFUND_OPS_UNCONFIRMED');
        }
        ensureIdentity();
        if (result.id !== intended.refundId || result.orderId !== intended.orderId || result.amountFen !== intended.amountFen
          || result.status !== (approve ? 'processing' : 'rejected')) throw fail('审核结果尚未确认，请刷新原退款记录', 'REFUND_OPS_UNCONFIRMED');
        wxApi.removeStorageSync(key()); pending = null;
        records = records.map(record => record.id === result.id ? result : record); return result;
      } finally { busy = false; }
    },
  };
}
module.exports = { createRefundOperationsClient, refundView };
