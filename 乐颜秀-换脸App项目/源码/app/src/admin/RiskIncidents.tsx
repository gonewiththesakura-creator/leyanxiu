import { useCallback, useEffect, useState } from "react";
import { actOnRisk, getRisks, type AdminUser, type ManagedIncident } from "./api";

const labels = { open: "待处理", investigating: "处理中", resolved: "已解决" };
const severities = { critical: "严重", high: "高", medium: "中", low: "低" };
export function RiskIncidents({ user }: { user: AdminUser }) {
  const [items, setItems] = useState<ManagedIncident[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("active");
  const canWrite = user.role !== "auditor";
  const canResolve = user.role === "owner" || user.role === "reviewer";
  const load = useCallback(async () => {
    try { setItems((await getRisks()).items); setLoaded(true); setError(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "风险事件读取失败"); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer); }, [load]);
  const act = async (item: ManagedIncident, action: "claim" | "note" | "resolve" | "reopen") => {
    const note = (notes[item.id] || "").trim();
    if (action !== "claim" && note.length < 2) { setError("请先填写至少 2 个字的处理说明"); return; }
    setBusy(item.id); setError("");
    try { const next = await actOnRisk(item.id, item.revision, action, note); setItems((previous) => previous.map((entry) => entry.id === item.id ? next : entry)); setNotes((previous) => ({ ...previous, [item.id]: "" })); }
    catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作失败";
      if ((caught as { status?: number }).status === 409) { await load(); setError("事件已被其他人更新，已刷新。请核对最新状态后重新操作，填写的说明已保留。"); }
      else setError(message);
    } finally { setBusy(""); }
  };
  const visible = items.filter((item) => filter === "all" || (filter === "active" ? item.status !== "resolved" : item.status === "resolved"));
  return <section className="admin-panel">
    <div className="admin-panel-heading"><div><span className="admin-section-kicker">事件处置闭环</span><h3>风险事件</h3></div><select aria-label="筛选风险状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="active">待处理与处理中</option><option value="resolved">已解决</option><option value="all">全部记录</option></select><button type="button" className="admin-secondary-button" onClick={() => void load()}>刷新</button></div>
    {error && <p className="admin-form-error" role="alert">{error}</p>}
    <div className="admin-risk-list">{visible.map((item) => <article className="admin-risk-row" key={item.id}>
      <div className={`admin-risk-severity is-${item.severity}`}><span>{severities[item.severity]}</span><small>严重程度</small></div>
      <div className="admin-risk-body"><div><h4>{item.title}</h4><span>{labels[item.status]}</span></div><p className="admin-muted">负责人：{item.assignee || "未认领"} · {item.observedActive ? "当前仍观测到异常" : "当前未观测到异常"} · 版本 {item.revision}</p>
        <dl><div><dt>会影响什么</dt><dd>{item.impact}</dd></div><div><dt>如何处理</dt><dd>{item.action}</dd></div><div><dt>如何预防</dt><dd>{item.prevention}</dd></div></dl>
        {item.notes.length > 0 && <details className="admin-risk-history"><summary>处理记录（{item.notes.length}）</summary>{item.notes.map((entry, index) => <p key={`${entry.createdAt}-${index}`}><strong>{entry.actor}</strong> · {new Date(entry.createdAt).toLocaleString("zh-CN")} · {({ claim: "认领", note: "备注", resolve: "解决", reopen: "重开" } as Record<string, string>)[entry.action] || entry.action}<br />{entry.note}</p>)}</details>}
        {canWrite && <div className="admin-risk-actions"><label>处理说明<textarea maxLength={2000} rows={2} value={notes[item.id] || ""} onChange={(event) => setNotes((previous) => ({ ...previous, [item.id]: event.target.value }))} placeholder="记录原因、采取的措施和验证结果" /></label><div>
          {item.status !== "resolved" && <button type="button" disabled={Boolean(busy)} className="admin-secondary-button" onClick={() => void act(item, "claim")}>我来处理</button>}
          <button type="button" disabled={Boolean(busy)} className="admin-secondary-button" onClick={() => void act(item, "note")}>添加记录</button>
          {canResolve && <button type="button" disabled={Boolean(busy)} className="admin-primary-button" onClick={() => void act(item, item.status === "resolved" ? "reopen" : "resolve")}>{busy === item.id ? "正在保存…" : item.status === "resolved" ? "重新打开" : "标记已解决"}</button>}
        </div>{item.observedActive && <small>关闭处置记录不会消除监控告警；请先核实修复结果。</small>}</div>}
      </div>
    </article>)}</div>
    {!visible.length && <p className="admin-muted">{loaded ? "当前筛选下没有风险事件。" : "正在读取风险事件…"}</p>}
  </section>;
}
