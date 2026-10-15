import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { actOnRefund, getBilling, reconcileBilling, reconcileDailyBill, saveBillingProducts, type AdminUser, type BillingData, type BillingRefund } from "./api";

const labels: Record<string, string> = { pending: "待付款", paid: "已付款", refunded: "已退款", partially_refunded:'已部分退款', closed:'已关闭', requested: "待审核", processing: "渠道处理中", abnormal: "退款异常", succeeded: "退款成功", rejected: "已拒绝／关闭" };
const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const date = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
const dayKey = (value: string | number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));

export function BillingPanel({ user }: { user: AdminUser }) {
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [productDraft, setProductDraft] = useState<BillingData["products"] | null>(null);
  const [billDate,setBillDate]=useState(()=>dayKey(Date.now()-86400000));
  const inFlight = useRef(false);
  const owner = user.role === "owner";
  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await getBilling()); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "支付数据读取失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const summary = useMemo(() => {
    const days = Array.from({ length: 30 }, (_, index) => ({ date: dayKey(Date.now() - (29 - index) * 86400000), 支付金额: 0, 退款金额: 0 }));
    let paidFen = 0, refundedFen = 0;
    for (const order of data?.orders || []) {
      if (order.fulfilledAt) {
        paidFen += order.amountFen;
        if (Number.isFinite(Date.parse(order.fulfilledAt))) { const day = days.find(item => item.date === dayKey(order.fulfilledAt!)); if (day) day.支付金额 += order.amountFen; }
      }
      if (order.refundedAt) {
        refundedFen += order.refundedFen ?? order.amountFen;
        if (Number.isFinite(Date.parse(order.refundedAt))) { const day = days.find(item => item.date === dayKey(order.refundedAt!)); if (day) day.退款金额 += order.refundedFen ?? order.amountFen; }
      }
    }
    return { paidFen, refundedFen, days: days.map(item => ({ ...item, 支付金额: item.支付金额 / 100, 退款金额: item.退款金额 / 100 })) };
  }, [data]);
  const act = async (refund: BillingRefund, action: "approve" | "reject" | "sync") => {
    if (inFlight.current || !owner) return;
    const reason = (notes[refund.id] || "").trim();
    if (action === "reject" && !reason) { setError("请填写拒绝退款的原因，用户售后处理需要保留依据。"); return; }
    if (action === "approve" && !window.confirm(`确认向原支付渠道退回 ${money(refund.amountFen)}？\n订单：${refund.orderId}\n本操作会申请真实退款，${refund.credits} 次已冻结额度将作废。`)) return;
    if (action === "reject" && !window.confirm(`确认拒绝这笔退款并释放 ${refund.credits} 次冻结额度？\n原因：${reason}`)) return;
    inFlight.current = true; setBusy(refund.id); setError(""); setNotice("");
    try {
      const result = await actOnRefund(refund.id, action, reason);
      await load();
      setNotice(`退款状态：${labels[result.refund.status] || result.refund.status}。${result.refund.holdActive ? "额度继续冻结，请以渠道最终结果为准。" : "账本已更新。"}`);
      setNotes(previous => ({ ...previous, [refund.id]: "" }));
    } catch (caught) {
      await load();
      setError(`${caught instanceof Error ? caught.message : "操作未完成"}。已尝试刷新状态；提交过渠道的退款请先查询结果，不要重复申请。`);
    } finally { inFlight.current = false; setBusy(""); }
  };
  const saveProducts = async () => {
    if (!owner || !productDraft || inFlight.current) return;
    const ids = new Set<string>();
    const invalid = productDraft.length > 50 || productDraft.some(item => {
      const duplicate = ids.has(item.id); ids.add(item.id);
      return duplicate || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || !item.name.trim() || new TextEncoder().encode(item.name.trim()).length > 127 || !Number.isSafeInteger(item.amountFen) || item.amountFen < 1 || item.amountFen > 1000000 || !Number.isSafeInteger(item.credits) || item.credits < 1 || item.credits > 100000;
    });
    if (invalid) { setError("请检查套餐：编号须唯一且只含字母数字下划线短横线；名称不超过 127 字节；价格为 1～1000000 分整数；次数为 1～100000 整数。"); return; }
    if (!window.confirm(`确认发布 ${productDraft.length} 个套餐？${productDraft.length ? "新订单立即使用新配置。" : "所有套餐将下架，停止新购买。"}\n历史订单的金额与次数保持不变。请确认公司已批准本次价格。`)) return;
    inFlight.current = true; setBusy("products"); setError(""); setNotice("");
    try { await saveBillingProducts(productDraft); setProductDraft(null); await load(); setNotice("套餐配置已发布，历史订单未改变。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "套餐发布失败，编辑内容已保留"); }
    finally { inFlight.current = false; setBusy(""); }
  };
  const reconcile = async () => {
    if (!owner || inFlight.current || !data?.operationsReadiness?.ready) return;
    inFlight.current = true; setBusy("reconcile"); setNotice(""); setError("");
    try {
      const result = await reconcileBilling();
      await load();
      setNotice(result.busy ? "已有对账任务正在执行，请稍后刷新。" : `本批已检查 ${result.checked ?? 0} 笔待付款订单，确认到账 ${result.settled ?? 0} 笔，查询异常 ${result.errors ?? 0} 笔。每批最多 20 笔，未确认的订单不会补发额度。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "对账失败，请稍后重试"); }
    finally { inFlight.current = false; setBusy(""); }
  };
  const changeProduct = (index: number, patch: Partial<BillingData["products"][number]>) => setProductDraft(previous => previous?.map((item, position) => position === index ? { ...item, ...patch } : item) || null);
  const search = query.trim().toLowerCase();
  const matches = (...values: Array<string | undefined>) => !search || values.some(value => value?.toLowerCase().includes(search));
  const refunds = (data?.refunds || []).filter(item => (filter === "all" || ["requested", "processing", "abnormal"].includes(item.status)) && matches(item.id, item.orderId, item.userId)).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const orders = (data?.orders || []).filter(item => matches(item.id, item.userId, item.productId, item.providerTradeId));
  return <div className="admin-page-stack">
    <section className="admin-panel">
      <div className="admin-panel-heading"><div><span className="admin-section-kicker">支付与售后</span><h3>商业管理</h3></div><button type="button" className="admin-secondary-button" disabled={loading || Boolean(busy)} onClick={() => void load()}>{loading ? "正在刷新…" : "刷新支付数据"}</button></div>
      <p className="admin-muted">只展示服务器确认的订单与退款。金额为订单现金流水，未扣渠道手续费、税费及模型成本，不等同结算收入或利润。{!owner && "当前账号为只读权限。"}</p>
      {error && <p className="admin-form-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && <p>{loading ? "正在读取支付账本…" : "尚未取得支付数据，请刷新重试。"}</p>}
      {data && <><span className={`admin-status admin-status-${data.readiness.ready ? "good" : "warn"}`}>{data.readiness.ready ? (data.readiness.mode==="merchant_test"?"仅商户联调":"支付配置已就绪") : "真实收款未就绪"}</span><span className={`admin-status admin-status-${data.reconciliation.ok ? "good" : "bad"}`}>{data.reconciliation.ok ? "额度账本一致" : `发现 ${data.reconciliation.mismatches.length} 项账本差异`}</span>
      {!data.readiness.ready && <details><summary>查看支付阻断项（{data.readiness.blockers.length}）</summary><ul>{data.readiness.blockers.map(item => <li key={item}>{item}</li>)}</ul></details>}
      {!data.operationsReadiness?.ready && <details><summary>退款与渠道查单尚未就绪</summary><ul>{(data.operationsReadiness?.blockers || ["请刷新服务状态"]).map(item => <li key={item}>{item}</li>)}</ul></details>}
      {owner && <div className="admin-billing-actions"><button type="button" className="admin-secondary-button" disabled={Boolean(busy) || !data.operationsReadiness?.ready} onClick={() => void reconcile()}>{busy === "reconcile" ? "正在核对渠道订单…" : "核对待付款订单"}</button><span className="admin-muted">暂停新销售后，已付款订单查单和售后退款仍可独立处理。</span></div>}
      {!data.reconciliation.ok && <div role="alert"><p>额度账本存在差异，请暂停人工退款操作并核查以下用户，不要直接修改余额。</p>{data.reconciliation.mismatches.map(item => <p key={`${item.userId}-${item.referenceId || ""}`}><code>{item.userId}</code>：{item.referenceId ? `订单或额度批次 ${item.referenceId}` : `购买额度账本 ${item.expectedPurchased} / 实际 ${item.actualPurchased}；试用额度账本 ${item.expectedTrial} / 实际 ${item.actualTrial}`}</p>)}</div>}</>}
    </section>
    {data && <>
      <section className="admin-panel"><h3>渠道日账单核对</h3><p className="admin-muted">从微信下载并校验账单文件，核对交易与退款差异。报告不会自动修改余额或补发次数。</p>
        {owner && <div className="admin-billing-actions"><input aria-label="账单日期" type="date" value={billDate} onChange={e=>setBillDate(e.target.value)} /><button disabled={Boolean(busy) || !data.operationsReadiness?.ready} className="admin-secondary-button" onClick={()=>{
          if(inFlight.current)return;inFlight.current=true;setBusy('daily');setError('');
          void reconcileDailyBill(billDate).then(async result=>{await load();setNotice(result.blocked?'日账单服务尚未就绪':result.busy?'已有账单核对正在执行':result.ok?'日账单金额与本地订单一致':'发现差异，请查看报告并查询渠道订单。');}).catch(cause=>setError(cause instanceof Error?cause.message:'账单核对失败')).finally(()=>{inFlight.current=false;setBusy('');});
        }}>核对日账单</button></div>}
        {(data.dailyBills || []).map(report=><details key={report.id}><summary>{report.date} · {report.ok?'一致':`${report.differences.length} 项差异`} · 支付 {money(report.paymentFen)} · 退款 {money(report.refundFen)}</summary>{report.differences.map((item,index)=><p key={index}>{item.type} · <code>{item.orderId || item.refundId}</code></p>)}</details>)}
      </section>
      <section className="admin-metric-grid" aria-label="支付流水汇总">{[["累计确认支付", money(summary.paidFen)], ["累计确认退款", money(summary.refundedFen)], ["支付减退款", money(summary.paidFen - summary.refundedFen)], ["待处理退款", String(data.refunds.filter(item => ["requested", "processing", "abnormal"].includes(item.status)).length)]].map(([label, value]) => <div className="admin-metric" key={label}><div className="admin-metric-head">{label}</div><strong>{value}</strong><p>当前账本范围</p></div>)}</section>
      <section className="admin-panel admin-chart-panel"><div className="admin-panel-heading"><h3>近 30 天支付与退款</h3><span className="admin-muted">北京时间 · 元</span></div><div style={{height:260}}><ResponsiveContainer width="100%" height="100%"><LineChart data={summary.days}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={value => String(value).slice(5)} minTickGap={25}/><YAxis/><Tooltip/><Legend/><Line type="monotone" dataKey="支付金额" stroke="#4f46e5" dot={false}/><Line type="monotone" dataKey="退款金额" stroke="#d97706" dot={false}/></LineChart></ResponsiveContainer></div></section>
      <section className="admin-panel"><div className="admin-panel-heading"><h3>在售套餐</h3>{owner && !productDraft && <button type="button" className="admin-secondary-button" disabled={Boolean(busy)} onClick={() => setProductDraft(data.products.map(item => ({...item})))}>编辑套餐</button>}</div>
      {productDraft ? <><p className="admin-muted">价格单位为分（100 分 = 1 元）。删除套餐会停止新购买，历史订单仍保留。</p><div className="admin-billing-products">{productDraft.map((item,index) => <article key={index} className="admin-billing-product-edit"><label>套餐编号<input value={item.id} maxLength={64} onChange={event => changeProduct(index,{id:event.target.value})}/></label><label>套餐类型<select value={item.type || "credits"} onChange={event=>changeProduct(index,{type:event.target.value as "credits"|"monthly",durationDays:event.target.value==="monthly"?30:null})}><option value="credits">次数包，不设到期时间</option><option value="monthly">30 天套餐，不自动续费</option></select></label><label>显示名称<input value={item.name} onChange={event => changeProduct(index,{name:event.target.value})}/></label><label>价格（分）<input type="number" min={1} max={1000000} step={1} value={item.amountFen || ""} onChange={event => changeProduct(index,{amountFen:Number(event.target.value)})}/></label><label>制作次数<input type="number" min={1} max={100000} step={1} value={item.credits || ""} onChange={event => changeProduct(index,{credits:Number(event.target.value)})}/></label><button type="button" className="admin-secondary-button" disabled={Boolean(busy)} onClick={() => setProductDraft(previous => previous?.filter((_,position) => position !== index) || [])}>移除此套餐</button></article>)}</div><div className="admin-billing-actions"><button type="button" className="admin-secondary-button" disabled={Boolean(busy) || productDraft.length >= 50} onClick={() => setProductDraft(previous => [...(previous || []),{id:"",name:"",amountFen:0,credits:0}])}>添加套餐</button><button type="button" className="admin-primary-button" disabled={Boolean(busy)} onClick={() => void saveProducts()}>确认并发布套餐</button><button type="button" className="admin-secondary-button" disabled={Boolean(busy)} onClick={() => setProductDraft(null)}>取消编辑</button></div></> : data.products.length ? <div className="admin-billing-products">{data.products.map(item => <article key={item.id}><strong>{item.name}</strong><p>{money(item.amountFen)} / {item.credits} 次 · {item.type==="monthly"?"30 天有效":"不设到期时间"}</p><code>{item.id}</code></article>)}</div> : <p className="admin-muted">尚未配置经公司确认的套餐，用户不能购买。</p>}</section>
      <section className="admin-panel"><div className="admin-panel-heading"><h3>退款处理</h3><select aria-label="退款筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="active">待处理</option><option value="all">全部退款</option></select></div><label className="admin-billing-search">查询订单、退款单或用户<input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入编号搜索"/></label>
      <div className="admin-billing-refunds">{refunds.map(item => <article key={item.id}><div className="admin-panel-heading"><strong>{money(item.amountFen)} · {labels[item.status] || item.status}</strong><time>{date(item.createdAt)}</time></div><p>申请原因：{item.reason}</p><p className="admin-muted">订单 <code>{item.orderId}</code><br/>退款单 <code>{item.id}</code><br/>用户 <code>{item.userId}</code> · {item.holdActive ? `冻结 ${item.credits} 次` : "冻结已解除"}</p>{item.reviewReason && <p>处理原因：{item.reviewReason}</p>}
      {owner && <div className="admin-billing-actions">{item.status === "requested" && <><label>拒绝原因<textarea maxLength={200} rows={2} value={notes[item.id] || ""} onChange={event => setNotes(previous => ({...previous,[item.id]:event.target.value}))}/></label><button type="button" className="admin-primary-button" disabled={Boolean(busy) || !data.operationsReadiness?.ready || !data.reconciliation.ok} onClick={() => void act(item,"approve")}>批准并原路退款</button><button type="button" className="admin-secondary-button" disabled={Boolean(busy) || !notes[item.id]?.trim() || !data.reconciliation.ok} onClick={() => void act(item,"reject")}>拒绝并释放额度</button></>}{["processing","abnormal"].includes(item.status) && <><p>款项状态尚未确认，额度保持冻结。先查询渠道结果，不要人工释放额度。</p><button type="button" className="admin-secondary-button" disabled={Boolean(busy) || !data.operationsReadiness?.ready} onClick={() => void act(item,"sync")}>{busy === item.id ? "正在查询…" : "查询渠道退款结果"}</button></>}</div>}</article>)}</div>{!refunds.length && <p className="admin-muted">当前筛选下没有退款申请。</p>}</section>
      <section className="admin-panel"><div className="admin-panel-heading"><h3>订单记录</h3><span>{orders.length} 笔</span></div><div className="admin-billing-table-wrap"><table className="admin-billing-table"><thead><tr><th>订单 / 用户</th><th>套餐 / 次数</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{orders.map(item => <tr key={item.id}><td><code>{item.id}</code><small>{item.userId}</small></td><td>{item.productSnapshot?.name || data.products.find(product => product.id === item.productId)?.name || item.productId}<small>{item.credits} 次</small></td><td>{money(item.amountFen)}{Boolean(item.refundedFen) && <small>已退 {money(item.refundedFen!)}</small>}</td><td>{labels[item.status] || item.status}</td><td>{date(item.createdAt)}</td></tr>)}</tbody></table></div>{!orders.length && <p className="admin-muted">暂无匹配订单。</p>}</section>
    </>}
  </div>;
}
