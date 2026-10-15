import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, RefreshCw } from "lucide-react";
import { closePaymentOrder, createPaymentOrder, launchWechatPayment, nativePaymentStatus, orderStatusLabel, paymentOrder, paymentOrders, paymentProducts, paymentRefunds, paymentIdentity, paymentRefundQuote, requestPaymentRefund, type Product, type PurchaseOrder, type PurchaseRefund } from "@/lib/payments";
import { getAccountSessionGeneration, getServerEntitlements } from "@/lib/api";
import { PaymentIdentity, type PaymentIdentityStatus } from '@/components/PaymentIdentity';
import { loadPaymentAttempt, savePaymentAttempt, type PaymentAttempt } from '@/lib/payment-attempt';

export function PurchaseView({ onBack, onCredits }: { onBack: () => void; onCredits: (credits: number) => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [refunds, setRefunds] = useState<PurchaseRefund[]>([]);
  const [refundOrder, setRefundOrder] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundQuote,setRefundQuote]=useState<{amountFen:number;credits:number}|null>(null);
  const [identity,setIdentity]=useState<PaymentIdentityStatus|null>(null);
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState("");
  const [nativeReady, setNativeReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [pendingId, setPendingId] = useState("");
  const attempt = useRef<PaymentAttempt | null>(null);
  const attemptOwner = useRef("");
  const saveAttempt = useCallback((value: PaymentAttempt | null, owner = attemptOwner.current) => {
    if (owner !== attemptOwner.current) throw new Error('账号已切换，请在当前账号中重新查询订单。');
    savePaymentAttempt(owner, value);
    attempt.current = value;
  }, []);
  const applyIdentity = useCallback((account: PaymentIdentityStatus) => {
    if (!account.userId) throw new Error('账号尚未确认，请刷新后再购买。');
    if (attemptOwner.current !== account.userId) {
      // A failed read must leave the new account unconfirmed, never retain A's
      // in-memory identity while the session already belongs to B.
      attemptOwner.current = ''; attempt.current = null; setIdentity(null);
      setPendingId(''); setAccepted(false); setRefundOrder(''); setRefundQuote(null); setRefundReason('');
      const saved = loadPaymentAttempt(account.userId);
      attemptOwner.current = account.userId;
      attempt.current = saved;
      setPendingId(saved?.orderId || '');
    }
    setIdentity(account);
  }, []);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    const generation = getAccountSessionGeneration();
    const [history, refundHistory, account, credits] = await Promise.all([paymentOrders(), paymentRefunds(), paymentIdentity(), getServerEntitlements()]);
    if (generation !== getAccountSessionGeneration()) throw new Error('账号已切换，请重新刷新订单。');
    applyIdentity(account);
    setOrders(history); setRefunds(refundHistory); onCredits(credits);
  }, [onCredits, applyIdentity]);
  useEffect(() => {
    let active = true;
    const generation = getAccountSessionGeneration();
    void Promise.all([paymentProducts(), nativePaymentStatus(), paymentOrders(), paymentRefunds(), paymentIdentity()]).then(([catalog, native, history, refundHistory, account]) => {
      if (!active) return;
      if (generation !== getAccountSessionGeneration()) throw new Error('账号已切换，请重新刷新订单。');
      setProducts(catalog.products); setAvailable(catalog.available); setMode(catalog.mode); setNativeReady(native.configured && native.installed); setOrders(history); setRefunds(refundHistory);
      applyIdentity(account);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "加载失败，请返回后重试"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applyIdentity]);
  useEffect(() => {
    const returned = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const status = await nativePaymentStatus();
        if ("returnCode" in status && status.returnCode === -2) { setPendingId(""); setNotice("已取消本次支付操作。再次选择同一套餐会重试原订单，请以订单状态为准。"); }
        else if ("returnCode" in status && typeof status.returnCode === "number" && status.returnCode !== 0) setNotice("微信返回支付未完成，请查询订单确认结果后重试。");
      } catch { /* Order polling remains authoritative if the native status is unavailable. */ }
    };
    document.addEventListener("visibilitychange", returned);
    return () => document.removeEventListener("visibilitychange", returned);
  }, []);
  useEffect(() => {
    if (!pendingId || !identity?.userId) return;
    const owner = identity.userId;
    let active = true;
    let running = false;
    let attempts = 0;
    const check = async () => {
      if (running || !active || document.visibilityState === "hidden") return;
      running = true;
      try {
        const order = await paymentOrder(pendingId);
        if (!active || attemptOwner.current !== owner) return;
        setOrders((current) => [order, ...current.filter((item) => item.id !== order.id)]);
        if (["paid", "refunded", "partially_refunded", "closed", "failed", "cancelled"].includes(order.status)) {
          setNotice(order.status === "paid" ? "付款已由服务器确认，制作次数已到账。" : orderStatusLabel(order.status));
          setPendingId("");
          if (attempt.current?.orderId === order.id) saveAttempt(null, owner);
          await refresh();
        }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "订单确认暂时失败，请勿重复付款"); }
      finally { running = false; }
      attempts += 1;
      if (attempts >= 24 && active) { setPendingId(""); setNotice("暂未确认支付结果。如已付款请勿重复购买，可点击订单查询状态。"); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5000);
    document.addEventListener("visibilitychange", check);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [pendingId, refresh, identity?.userId, saveAttempt]);
  const buy = async (product: Product) => {
    if (lock.current || loading || !identity?.userId || !available || !nativeReady || !accepted || (mode==='live' && !identity.bound)) return;
    const owner = identity.userId;
    const generation = getAccountSessionGeneration();
    const assertCurrentAccount = () => {
      if (owner !== attemptOwner.current || generation !== getAccountSessionGeneration()) throw new Error('账号已切换，请回到原账号核对订单后再购买。');
    };
    lock.current = true; setBusy(true); setError("");
    try {
      assertCurrentAccount();
      if (attempt.current && attempt.current.productId !== product.id) throw new Error("上一笔购买尚未确认，请先查询原订单或重试原套餐，避免重复付款");
      if (!attempt.current) saveAttempt({ productId: product.id, key: crypto.randomUUID() }, owner);
      const currentAttempt = attempt.current!;
      const result = await createPaymentOrder(product.id, currentAttempt.key);
      assertCurrentAccount();
      saveAttempt({ ...currentAttempt, orderId: result.order.id }, owner);
      setPendingId(result.order.id);
      if (result.order.status === "paid") { saveAttempt(null, owner); setPendingId(""); setNotice("付款已确认，次数已到账。"); await refresh(); return; }
      if (["closed", "failed", "cancelled", "refunded", "partially_refunded"].includes(result.order.status)) {
        saveAttempt(null, owner); setPendingId(''); setNotice(`原订单${orderStatusLabel(result.order.status)}，请核对后重新选择套餐。`); await refresh(); return;
      }
      if (!result.payment) throw new Error("支付参数尚未就绪，请查询订单后再试，不要重复付款");
      assertCurrentAccount();
      await launchWechatPayment(result.payment);
      setNotice("已打开微信。支付完成或取消后返回此页，我们会查询真实到账状态。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法调起支付，请检查订单状态"); }
    finally { lock.current = false; setBusy(false); }
  };
  const lookupRefund = async (id:string) => {
    if(lock.current)return;
    lock.current=true;setBusy(true);setRefundOrder(id);setRefundQuote(null);setError('');
    try {setRefundQuote(await paymentRefundQuote(id));}
    catch(cause){setRefundOrder('');setError(cause instanceof Error?cause.message:'暂无法申请退款');}
    finally {lock.current=false;setBusy(false);}
  };
  const submitRefund = async () => {
    if (lock.current || !refundOrder || !refundQuote || refundReason.trim().length < 5) return;
    lock.current = true; setBusy(true); setError("");
    try {
      await requestPaymentRefund(refundOrder, refundReason.trim(), refundQuote.amountFen);
      setRefundOrder(""); setRefundReason(""); setNotice("退款申请已提交，实际结果请查看退款进度。"); await refresh();
    } catch (cause) { setRefundQuote(null); setError(cause instanceof Error ? cause.message : "退款申请失败，请重新查看退款金额后提交"); }
    finally { lock.current = false; setBusy(false); }
  };
  const closeOrder = async (id: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const order = await closePaymentOrder(id);
      if (order.status === "closed" || order.status === "paid") {
        if (attempt.current?.orderId === id) saveAttempt(null);
        setPendingId(""); setNotice(order.status === "paid" ? "该订单已支付，请勿重复购买。" : "订单已关闭，可以重新选择套餐。");
      } else { setPendingId(id); setNotice("正在确认订单状态，请勿重复付款。"); }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "订单关闭失败，请先核对支付状态"); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="h-full overflow-y-auto bg-[#0b0b0f] px-5 pb-10 pt-[max(24px,env(safe-area-inset-top))] text-white">
    <header className="mb-7 flex items-center gap-3"><button aria-label="返回" onClick={onBack} className="rounded-full bg-white/10 p-3"><ArrowLeft size={20} /></button><h1 className="text-2xl font-bold">套餐与购买记录</h1></header>
    <p className="mb-5 text-sm leading-6 text-white/65">次数包及 30 天套餐均不自动续费。30 天套餐从到账时起生效，提前续购顺延；每期次数独立到期，不结转。每次制作消耗以制作页面提示为准。</p>
    <PaymentIdentity status={identity} onRestored={async()=>{setPendingId('');setAccepted(false);setLoading(true);try{await refresh();}finally{setLoading(false);}}} />
    {mode === "merchant_test" && <p role="alert" className="mb-5 rounded-xl border border-amber-500/40 bg-amber-950 p-4 text-sm text-amber-200">商户联调：会产生真实扣款，仅指定测试账号可购买。</p>}
    {loading && <p role="status">正在加载套餐与订单…</p>}
    {!loading && !available && <p className="mb-5 rounded-xl bg-white/10 p-4 text-sm">购买暂未开放，目前不会收款。</p>}
    {!loading && available && !nativeReady && <p className="mb-5 rounded-xl bg-white/10 p-4 text-sm">请在已配置支付的安卓 App 内使用，并确认手机已安装微信。此页面暂不能付款。</p>}
    <div className="grid gap-3">{products.map((product) => <section key={product.id} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 p-4"><div><h2 className="font-semibold">{product.name}</h2><p className="mt-1 text-sm text-white/60">{product.credits} 次制作 · ¥{(product.amountFen / 100).toFixed(2)}</p><p className="mt-1 text-xs text-white/50">{product.type==='monthly'?'每期 30 天有效，不自动续费':'次数包，不设到期时间'}</p></div><button disabled={loading || busy || !identity?.userId || Boolean(pendingId) || !available || !nativeReady || !accepted || (mode==='live' && !identity?.bound)} onClick={() => void buy(product)} className="rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold disabled:bg-white/10 disabled:text-white/35">{busy ? "处理中…" : "购买"}</button></section>)}</div>
    <p className="mt-4 text-xs leading-6 text-white/60">退款说明：次数包按该订单未用次数比例计算；30 天套餐未使用且付款后 7 天内可申请全额退款，其余按剩余次数与剩余有效期比例取较低金额。制作中的任务需先结束。申请后冻结该订单剩余次数，退款成功后终止剩余权益。审核和到账以实际处理结果为准。</p>
    {available && <label className="my-5 flex items-start gap-3 text-sm leading-6 text-white/65"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1.5" />我已确认套餐金额、次数、有效期及退款规则，并知悉不会自动续费。</label>}
    {notice && <p role="status" className="my-4 flex gap-2 rounded-xl bg-emerald-950 p-4 text-sm text-emerald-200"><CheckCircle2 size={18} className="shrink-0" />{notice}</p>}
    {error && <p role="alert" className="my-4 rounded-xl bg-red-950 p-4 text-sm text-red-200">{error}</p>}
    <section className="mt-8"><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">我的订单</h2><button disabled={busy} onClick={() => { setError(""); void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "查询失败")); }} className="flex items-center gap-1 text-sm text-violet-300"><RefreshCw size={15} />刷新</button></div>
      {!loading && orders.length === 0 && <p className="text-sm text-white/50">暂无购买记录</p>}
      {orders.map((order) => <div key={order.id} className="mb-3 w-full rounded-xl border border-white/10 p-4 text-left">
        <button className="w-full text-left" onClick={() => setPendingId(order.id)}>
          <div className="flex justify-between gap-2"><span>¥{(order.amountFen / 100).toFixed(2)} · {order.credits} 次</span><span className="text-sm text-violet-300">{orderStatusLabel(order.status)}</span></div>
          <p className="mt-2 break-all text-xs text-white/45">订单号：{order.id}</p>
          <p className="mt-1 text-xs text-white/45">{new Date(order.createdAt).toLocaleString('zh-CN')} · 点击核对状态</p>
        </button>
        {order.expiresAt && <p className="mt-2 text-xs text-white/65">有效期：{new Date(order.startsAt!).toLocaleString('zh-CN')} 至 {new Date(order.expiresAt).toLocaleString('zh-CN')}</p>}
        {order.status==='paid' && <button disabled={busy} onClick={()=>void lookupRefund(order.id)} className="mt-3 text-sm text-violet-300">查看退款金额</button>}
        {refunds.filter(refund=>refund.orderId===order.id).map(refund=><p key={refund.id} className="mt-2 text-sm text-white/60">退款 ¥{(refund.amountFen/100).toFixed(2)}：{({requested:'待处理',processing:'处理中',abnormal:'异常待人工处理',succeeded:'退款成功',rejected:'申请未通过',closed:'渠道已关闭'}[refund.status] || '状态确认中')}</p>)}
      </div>)}
      {orders.filter((order) => order.status === "pending" || order.status === "created").map((order) => <button key={`close-${order.id}`} disabled={busy} onClick={() => void closeOrder(order.id)} className="mb-3 block text-sm text-white/60">关闭未付款订单 {order.id.slice(-8)}，重新选套餐</button>)}
      {refundOrder && <div className="my-4 rounded-xl bg-white/10 p-4">
        {refundQuote && <p className="mb-3 leading-6">本次可申请退回 ¥{(refundQuote.amountFen/100).toFixed(2)}，提交后冻结 {refundQuote.credits} 次剩余额度；退款成功后这些次数作废。</p>}
        <label htmlFor="refund-reason" className="text-sm">退款原因（至少 5 个字）</label><textarea id="refund-reason" maxLength={200} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-lg bg-black/30 p-3" />
        <div className="mt-2 flex gap-5"><button disabled={busy || !refundQuote || refundReason.trim().length < 5} onClick={() => void submitRefund()} className="text-violet-300 disabled:opacity-40">确认金额并提交</button><button disabled={busy} onClick={() => {setRefundOrder('');setRefundQuote(null);}}>取消</button></div>
      </div>}
    </section>
  </div>;
}
