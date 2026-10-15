const { createPaymentClient } = require('./payments');
const publicSupport = require('./public-support');
const categories = [
  { id: 'other', name: '服务、订单或其他问题' }, { id: 'likeness', name: '肖像或人脸授权' },
  { id: 'minor', name: '未成年人保护' }, { id: 'rights', name: '版权或其他权利' },
  { id: 'ai_label', name: 'AI 标识问题' }, { id: 'harmful', name: '违法或有害内容' },
];
const documentFields = [
  ['userAgreementUrl', '服务协议'], ['privacyPolicyUrl', '隐私政策'], ['thirdPartyListUrl', '第三方信息清单'],
];
const fail = (message, code) => Object.assign(new Error(message), { code });
const text = (value, max = 500) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
// Native mini-programs do not provide a portable browser URL implementation.
// Only public DNS HTTPS documents can be copied; never open an embedded webview.
function publicHttps(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\<>"#]/.test(value)) return null;
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(?:[/?][^#]*)?$/.exec(value);
  if (!match) return null;
  const labels = match[1].toLowerCase().split('.');
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels[labels.length - 1])
    || ['local', 'localhost', 'internal', 'lan'].includes(labels[labels.length - 1])
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return value;
}
function serviceInformation(value) {
  const publishedOperator = text(value?.operatorName, 200), publishedSupport = text(value?.supportContact, 500);
  const operator = publishedOperator || publicSupport.operatorName;
  const support = publishedSupport || publicSupport.email;
  const documents = documentFields.map(([id, title]) => ({ id, title, url: publicHttps(value?.[id]) || '', available: Boolean(publicHttps(value?.[id])) }));
  const suppliers = (Array.isArray(value?.aiServices) ? value.aiServices : []).slice(0, 30).map(item => ({
    provider: text(item?.provider, 200), model: text(item?.model, 200), purpose: text(item?.purpose),
    region: text(item?.region, 100), filingReference: text(item?.filingReference, 200),
  })).filter(item => Object.values(item).every(Boolean));
  const retention = value?.retention;
  const sourceHours = Number.isFinite(retention?.sourceHours) && retention.sourceHours > 0 ? retention.sourceHours : null;
  const resultHours = Number.isFinite(retention?.resultHours) && retention.resultHours > 0 ? retention.resultHours : null;
  const supplierPolicy = text(retention?.supplierPolicy);
  const available = value?.status === 'approved' && Boolean(publishedOperator && publishedSupport && suppliers.length && sourceHours && resultHours && supplierPolicy)
    && documents.every(document => document.available);
  return { available, operator, support, supportSource: publishedSupport ? 'server' : 'public-config',
    documents, suppliers, sourceHours, resultHours, supplierPolicy,
    notice: available ? '以下信息由服务运营方公开提供；服务可用状态以创作页和订单页为准。' : '服务信息或协议尚不完整，暂不可用；仍可通过公开客服联系。协议、处理方和保存期以服务端完整公开信息为准。' };
}

function createServiceClient(wxApi, endpoint) {
  // Public contact/WeChat privacy access works even before endpoint/login is ready.
  let api, snapshot = serviceInformation(null), sending = false;
  const paymentApi = () => api || (api = createPaymentClient(wxApi, endpoint));
  const unavailableInformation = () => ({ ...serviceInformation(null), operator: snapshot.operator,
    support: snapshot.support, supportSource: snapshot.supportSource });
  const invoke = (method, options = {}) => new Promise((resolve, reject) => {
    if (typeof wxApi[method] !== 'function') { reject(fail('当前微信版本暂不支持，请升级微信后重试', 'SERVICE_NATIVE_UNAVAILABLE')); return; }
    wxApi[method]({ ...options, success: resolve, fail: reject });
  });
  const ensureAccount = async () => {
    const api = paymentApi();
    await api.login();
    const account = api.currentAccountId();
    if (typeof account !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(account)) throw fail('微信账号已变化，请重新打开页面', 'XPAY_ACCOUNT_CHANGED');
    return account;
  };
  const reportKey = account => `lyx-service-report:${account}`;
  const receipt = value => {
    if (!value || !['complaint', 'account_deletion'].includes(value.kind)
      || !['unconfirmed', 'submitted'].includes(value.state)) return null;
    if (value.state === 'submitted' && (!/^rpt_[A-Za-z0-9-]{1,100}$/.test(value.ticketId || '')
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))) return null;
    return { kind: value.kind, state: value.state, ...(value.state === 'submitted' ? { ticketId: value.ticketId, createdAt: value.createdAt } : {}) };
  };
  const submit = async (kind, input) => {
    if (sending) throw fail('上一条申请正在提交，请稍候', 'SERVICE_REPORT_BUSY');
    const category = input?.category, description = text(input?.description, 2000), contact = text(input?.contact || '', 200);
    if (!categories.some(item => item.id === category) || description.length < 10
      || (input?.contact && !contact)) throw fail('请选择问题类型，填写 10 至 2000 字说明；联系方式选填且最多 200 字', 'SERVICE_REPORT_INVALID');
    sending = true;
    try {
      const account = await ensureAccount(), key = reportKey(account);
      const previous = wxApi.getStorageSync(key);
      if (previous && (!receipt(previous) || previous.state === 'unconfirmed')) {
        throw fail('上一条申请是否收到尚未确认，请联系公开客服核实，暂勿重复提交', 'SERVICE_REPORT_UNCONFIRMED');
      }
      // No description, phone number, image or bearer token is stored locally.
      wxApi.setStorageSync(key, { kind, state: 'unconfirmed' });
      let response;
      try {
        response = await paymentApi().request('/api/reports', { method: 'POST', data: { category, description, ...(contact ? { contact } : {}) } });
      } catch (error) {
        // Definite pre-storage rejection restores a previous receipt; only this
        // attempt's temporary pending record can be removed when none existed.
        if (['REPORT_SUBMISSION_DISABLED', 'INVALID_REPORT_CATEGORY', 'INVALID_REPORT_DESCRIPTION',
          'INVALID_REPORT_CONTACT', 'REPORT_RATE_LIMITED'].includes(error.code)) {
          const prior = receipt(previous);
          if (prior?.state === 'submitted') wxApi.setStorageSync(key, prior);
          else wxApi.removeStorageSync(key);
        }
        if (error.code === 'REPORT_SUBMISSION_DISABLED') {
          throw fail('在线反馈暂未开通，本次未提交申请，请通过公开客服邮箱联系。', 'REPORT_SUBMISSION_DISABLED');
        }
        if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error;
        throw fail('提交结果尚未确认，请先联系公开客服核实，勿重复提交', 'SERVICE_REPORT_UNCONFIRMED');
      }
      const confirmed = receipt({ kind, state: 'submitted', ticketId: response?.ticketId, createdAt: response?.createdAt });
      if (response?.status !== 'submitted' || !confirmed || confirmed.state !== 'submitted') {
        throw fail('服务端尚未返回有效回执，请联系公开客服核实，勿重复提交', 'SERVICE_REPORT_UNCONFIRMED');
      }
      wxApi.setStorageSync(key, confirmed);
      return confirmed;
    } finally { sending = false; }
  };
  return {
    unavailableInformation,
    async refresh() {
      const account = await ensureAccount();
      snapshot = serviceInformation(await paymentApi().request('/api/public/compliance'));
      let refundOperator = false;
      try { refundOperator = (await paymentApi().request('/api/mini/operations/status'))?.operator === true; }
      catch (error) { if (error.code === 'XPAY_ACCOUNT_CHANGED') throw error; }
      const stored = wxApi.getStorageSync(reportKey(account));
      return { ...snapshot, refundOperator, receipt: stored ? (receipt(stored) || { kind: 'complaint', state: 'unconfirmed' }) : null };
    },
    submitReport: input => submit('complaint', input),
    requestAccountDeletion({ informationConfirmed, applicationConfirmed } = {}) {
      if (informationConfirmed !== true || applicationConfirmed !== true) throw fail('请先完成两次注销申请确认', 'SERVICE_DELETION_CONFIRMATION_REQUIRED');
      // The legacy DELETE /api/account does not invalidate the new persistent
      // photo context. File a review request until a unified deletion API exists.
      return submit('account_deletion', { category: 'other', description: '本人申请注销当前微信小程序服务账号。请先协助核对未完成订单、退款、未使用权益及制作任务，再按正式流程处理账号与个人信息；依法需留存的交易和安全记录按规则保留。此工单是注销申请，不表示注销已完成，也不授权清空或放弃权益。' });
    },
    async copyDocument(id) {
      const document = snapshot?.documents.find(item => item.id === id && item.available);
      if (!document || !publicHttps(document.url)) throw fail('该协议尚未公开，暂不可查看', 'SERVICE_DOCUMENT_UNAVAILABLE');
      return invoke('setClipboardData', { data: document.url });
    },
    async copySupport() {
      if (!snapshot?.support) throw fail('客服联系方式尚未公开', 'SERVICE_SUPPORT_UNAVAILABLE');
      return invoke('setClipboardData', { data: snapshot.support });
    },
    openPrivacyContract: () => invoke('openPrivacyContract'),
  };
}
module.exports = { createServiceClient, serviceInformation, publicHttps, categories };
