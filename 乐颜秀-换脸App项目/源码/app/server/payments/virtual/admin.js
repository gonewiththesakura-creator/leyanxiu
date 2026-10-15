/* global document, fetch, window */
const element = id => document.getElementById(id);
let csrf;
let reconcileCursor = '';
const names = { pending: '待确认', paid: '已支付', refund_pending: '退款处理中', refunded: '已退款', closed: '已关闭', requested: '待审核', processing: '渠道处理中', abnormal: '需核实', succeeded: '已到账', rejected: '已拒绝' };
async function api(url, data) {
  const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw new Error(result.message || result.code || '请求失败'); return result.data;
}
function cell(row, value, detail) {
  const td = document.createElement('td'); td.textContent = value == null ? '' : String(value);
  if (detail) { const small = document.createElement('small'); small.textContent = detail; td.append(small); }
  row.append(td); return td;
}
function rows(id, values, render) {
  element(id).replaceChildren();
  for (const value of values) { const row = document.createElement('tr'); render(row, value); element(id).append(row); }
}
async function action(work) {
  const buttons = Array.from(document.querySelectorAll('button')); buttons.forEach(b => { b.disabled = true; });
  try { await work(); } catch (error) { element('notice').textContent = error.message; }
  finally { buttons.forEach(b => { b.disabled = false; }); }
}
async function refresh() {
  const data = await api('/api/admin/mini-payments');
  element('status').textContent = data.readiness.ready ? '收款已开放' : `收款关闭：${data.readiness.blockers.join('；')}`;
  element('notice').textContent = '列表已更新。审批及退款结果均保留审计记录。';
  rows('orders', data.orders, (row, order) => {
    cell(row, order.product.name, order.id); cell(row, `¥${(order.amountFen / 100).toFixed(2)}`); cell(row, names[order.status] || order.status);
    cell(row, `¥${(order.refundedFen / 100).toFixed(2)}`); cell(row, new Date(order.createdAt).toLocaleString());
  });
  rows('refunds', data.refunds, (row, refund) => {
    cell(row, refund.orderId, refund.id); cell(row, `¥${(refund.amountFen / 100).toFixed(2)}`); cell(row, refund.reason); cell(row, names[refund.status] || refund.status);
    const actions = cell(row, '');
    if (refund.status === 'requested') for (const approve of [true, false]) {
      const button = document.createElement('button'); button.textContent = approve ? '批准原路退款' : '拒绝并解冻';
      button.addEventListener('click', () => action(async () => {
        if (!window.confirm(`${button.textContent} ¥${(refund.amountFen / 100).toFixed(2)}？\n订单：${refund.orderId}`)) return;
        await api(`/api/admin/mini-payments/refunds/${refund.id}/review`, { approve }); await refresh();
      })); actions.append(button);
    }
  });
  rows('audit', data.audit, (row, event) => { cell(row, event.action); cell(row, event.reference_id); cell(row, new Date(event.created_at).toLocaleString()); });
  rows('generations', data.generations, (row, job) => {
    cell(row, job.id, job.purpose); cell(row, job.status === 'unknown' ? '结果未知，次数保留' : '制作中'); cell(row, new Date(job.created_at).toLocaleString());
    const actions = cell(row, '');
    if (job.status !== 'unknown' && Date.now() - job.created_at < 600000) return;
    for (const outcome of ['success', 'failed']) {
      const button = document.createElement('button'); button.textContent = outcome === 'success' ? '已核实成功' : '已核实失败，返还';
      button.addEventListener('click', () => action(async () => {
        const evidence = window.prompt('填写供应商任务编号和核实结果（至少8字），不要填写密钥或个人敏感信息：'); if (!evidence) return;
        await api(`/api/admin/mini-payments/generations/${job.id}/resolve`, { userId: job.user_id, outcome, evidence }); await refresh();
      })); actions.append(button);
    }
  });
}
element('refresh').addEventListener('click', () => action(refresh));
element('reconcile').addEventListener('click', () => action(async () => {
  const result = await api('/api/admin/mini-payments/reconcile', {}); await refresh();
  element('notice').textContent = result.skipped ? '支付服务未配置或已有核实任务在运行。' : `本轮查询 ${result.checked} 笔，补发确认 ${result.delivered} 笔，待处理异常 ${result.errors} 笔。`;
}));
element('bill').addEventListener('click', () => action(async () => {
  const result = await api('/api/admin/mini-payments/bill', { ios: element('billType').value === 'ios', begin: element('begin').value, end: element('end').value });
  element('billResult').textContent = JSON.stringify(result, null, 2);
}));
element('reconcilePaid').addEventListener('click', () => action(async () => {
  const report = await api('/api/admin/mini-payments/reconcile-paid', { afterId: reconcileCursor });
  reconcileCursor = report.nextCursor || '';
  element('reconcilePaid').textContent = report.nextCursor ? '继续核对下一批订单' : '重新核对已支付订单';
  element('reconcileResult').textContent = `本批匹配 ${report.matched} 笔，差异或待确认 ${report.differences} 笔。${report.nextCursor ? '仍有订单，请继续下一批。' : '本轮已完成。'}\n渠道查单不等于银行结算到账，请另核渠道账单。\n${JSON.stringify(report.rows, null, 2)}`;
}));
void action(async () => { csrf = (await api('/api/admin/me')).csrfToken; await refresh(); });
