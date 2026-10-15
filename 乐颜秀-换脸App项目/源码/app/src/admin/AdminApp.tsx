import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArchiveRestore,
  Blocks,
  Check,
  ChevronRight,
  CircleGauge,
  ClipboardCheck,
  Clock3,
  FileClock,
  GalleryVerticalEnd,
  Image as ImageIcon,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorCog,
  MonitorSmartphone,
  Paintbrush,
  PauseCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Video,
  X,
  XCircle,
} from "lucide-react";
import type { PhotoEffect, PhotoEffectCategory } from "@/data/effects";
import type { RuntimeCatalog } from "@/data/runtimeCatalog";
import type { Template } from "@/data/templates";
import { sortVideoTemplatesNewestFirst } from "@/data/templates";
import { MediaField, MediaLibrary } from "@/admin/MediaLibrary";
import { RiskIncidents } from "@/admin/RiskIncidents";
import { BillingPanel } from "@/admin/BillingPanel";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  currentAdmin,
  createWorkflow,
  decideModeration,
  emergencyPause,
  getAudits,
  getCatalogWorkspace,
  getDashboard,
  getModeration,
  getReadiness,
  getReports,
  getWorkflows,
  login,
  logout,
  publishCatalog,
  rollbackCatalog,
  saveCatalogDraft,
  validateCatalogDraft,
  updateReport,
  updateWorkflow,
  type AdminUser,
  type AuditItem,
  type CatalogRelease,
  type CatalogWorkspace,
  type DashboardData,
  type ModerationItem,
  type ReportItem,
  type WorkflowItem,
  type WorkflowRisk,
  type WorkflowStatus,
  type WorkflowType,
} from "@/admin/api";
import { LivePreview, type CatalogValidationState, type PreviewFocus, type PreviewSource } from "@/admin/LivePreview";
import "@/admin/admin.css";

type Page = "overview" | "analytics" | "billing" | "templates" | "photos" | "media" | "appearance" | "intake" | "publish" | "governance" | "audit" | "monitoring" | "risk" | "system";
type LoadState = "idle" | "loading" | "ready" | "error";
type PreviewEditState = { catalog: RuntimeCatalog; focus: PreviewFocus; dirty: boolean };

const NAVIGATION: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; section: string }> = [
  { id: "overview", label: "运营总览", icon: LayoutDashboard, section: "工作台" },
  { id: "analytics", label: "数据趋势", icon: Activity, section: "工作台" },
  { id: "billing", label: "商业管理", icon: ClipboardCheck, section: "工作台" },
  { id: "templates", label: "视频模板", icon: Video, section: "内容" },
  { id: "photos", label: "图片效果", icon: ImageIcon, section: "内容" },
  { id: "media", label: "素材库", icon: ImageIcon, section: "内容" },
  { id: "appearance", label: "外观与开关", icon: Paintbrush, section: "内容" },
  { id: "intake", label: "能力接入", icon: Blocks, section: "发布" },
  { id: "publish", label: "发布中心", icon: GalleryVerticalEnd, section: "发布" },
  { id: "governance", label: "审核与举报", icon: ShieldCheck, section: "治理" },
  { id: "audit", label: "操作审计", icon: FileClock, section: "治理" },
  { id: "monitoring", label: "服务监控", icon: MonitorCog, section: "系统" },
  { id: "risk", label: "风险应对", icon: AlertTriangle, section: "系统" },
  { id: "system", label: "上线闸门", icon: ShieldCheck, section: "系统" },
];

const ROLE_PAGE_ACCESS: Record<AdminUser["role"], Page[]> = {
  owner: NAVIGATION.map((item) => item.id),
  operator: ["overview", "analytics", "templates", "photos", "media", "appearance", "intake", "monitoring", "risk", "system"],
  reviewer: ["overview", "analytics", "billing", "intake", "publish", "governance", "audit", "monitoring", "risk", "system"],
  auditor: ["overview", "analytics", "billing", "intake", "audit", "monitoring", "risk", "system"],
};

const ROLE_LABELS: Record<AdminUser["role"], string> = {
  owner: "超级管理员",
  operator: "内容运营",
  reviewer: "审核发布",
  auditor: "审计只读",
};

const GROUP_LABELS: Record<string, string> = {
  singing: "唱歌",
  dancing: "跳舞",
  quote: "语录",
  avatar: "AI头像",
  comic: "漫画",
  portrait: "写真",
  restore: "修复",
};

const WORKFLOW_TYPE_LABELS: Record<WorkflowType, string> = {
  capability: "新功能",
  video_template: "视频模板",
  photo_effect: "图片效果",
  visual_asset: "视觉素材",
};

const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  submitted: "已提交",
  technical_review: "技术评审",
  integration: "接入开发",
  quality_validation: "质量验收",
  ready: "已就绪",
  rejected: "已驳回",
};

const WORKFLOW_NEXT: Partial<Record<WorkflowStatus, WorkflowStatus>> = {
  submitted: "technical_review",
  technical_review: "integration",
  integration: "quality_validation",
  quality_validation: "ready",
};

function formatDate(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function toLocalDateTimeValue(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function cloneCatalog(catalog: RuntimeCatalog) {
  return structuredClone(catalog);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function LoginView({ onAuthenticated }: { onAuthenticated: (user: AdminUser) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await login(username, password));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-login-shell">
      <section className="admin-login-panel" aria-labelledby="admin-login-title">
        <div className="admin-brand-mark"><Sparkles size={22} /></div>
        <p className="admin-eyebrow">LEYANXIU OPERATIONS</p>
        <h1 id="admin-login-title">乐颜秀运营后台</h1>
        <p className="admin-login-copy">模板、图片效果、发布和风险处置统一从这里管理。</p>
        <form onSubmit={submit} className="admin-login-form">
          <label>
            <span>管理员账号</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            <span>密码</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
          </label>
          {error && <div className="admin-form-error" role="alert"><AlertTriangle size={16} />{error}</div>}
          <button className="admin-primary-button admin-login-button" type="submit" disabled={busy}>
            {busy ? <RefreshCw size={17} className="admin-spin" /> : <ChevronRight size={17} />}
            {busy ? "正在验证" : "进入后台"}
          </button>
        </form>
        <div className="admin-login-security"><ShieldCheck size={15} />会话采用 HttpOnly Cookie，并对修改操作进行 CSRF 校验</div>
      </section>
    </main>
  );
}

function StatusDot({ tone = "neutral", children }: { tone?: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className={`admin-status admin-status-${tone}`}><i />{children}</span>;
}

function Metric({ label, value, note, icon }: { label: string; value: ReactNode; note: string; icon: ReactNode }) {
  return (
    <div className="admin-metric">
      <div className="admin-metric-head"><span>{label}</span><span className="admin-metric-icon">{icon}</span></div>
      <strong>{value}</strong>
      <p>{note}</p>
    </div>
  );
}

function EmptyState({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return <div className="admin-empty">{icon}<strong>{title}</strong><span>{copy}</span></div>;
}

function LoadErrorState({ title, message, onRetry, busy = false }: { title: string; message: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div className="admin-load-error" role="alert">
      <span><AlertTriangle size={24} /></span>
      <strong>{title}</strong>
      <p>{message}</p>
      <button type="button" className="admin-secondary-button" onClick={onRetry} disabled={busy}>
        <RefreshCw size={16} className={busy ? "admin-spin" : ""} />重新加载
      </button>
    </div>
  );
}

function OverviewPage({ data, onNavigate }: { data: DashboardData | null; onNavigate: (page: Page) => void }) {
  if (!data) return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取真实服务数据</div>;
  const readyCapabilities = data.capabilities.filter((item) => item.ready).length;
  return (
    <div className="admin-page-stack">
      <section className="admin-hero-band">
        <div>
          <p className="admin-eyebrow">TODAY AT A GLANCE</p>
          <h2>运营状态一眼看清</h2>
          <p>当前展示服务端实时值；未接入历史统计的数据不会用模拟值补齐。</p>
        </div>
        <div className="admin-hero-release">
          <span>线上配置</span>
          <strong>v{data.catalog.version}</strong>
          <StatusDot tone={data.catalog.generationEnabled ? "good" : "bad"}>{data.catalog.generationEnabled ? "生成开放" : "生成暂停"}</StatusDot>
        </div>
      </section>

      <section className="admin-metric-grid" aria-label="核心指标">
        <Metric label="启用模板" value={data.catalog.enabledTemplates} note={`视频 ${data.catalog.enabledVideoTemplates} 个 · 图片效果 ${data.catalog.enabledPhotoEffects} 个`} icon={<Blocks size={18} />} />
        <Metric label="封闭测试用户" value={data.usage.users} note="来自当前合规台账，不等同日活" icon={<Users size={18} />} />
        <Metric label="待处理治理项" value={data.usage.reportsOpen + data.usage.moderationReview} note={`举报 ${data.usage.reportsOpen} · 人工审核 ${data.usage.moderationReview}`} icon={<ClipboardCheck size={18} />} />
        <Metric label="能力验收" value={`${readyCapabilities}/${data.capabilities.length}`} note="每项需完成 30 个独立合格样本" icon={<CircleGauge size={18} />} />
      </section>

      <section className="admin-two-column">
        <div className="admin-panel">
          <div className="admin-panel-heading">
            <div><span className="admin-section-kicker">能力闸门</span><h3>真实 API 准入状态</h3></div>
            <button type="button" className="admin-text-button" onClick={() => onNavigate("system")}>查看全部<ChevronRight size={15} /></button>
          </div>
          <div className="admin-capability-list">
            {data.capabilities.map((capability) => (
              <div className="admin-capability-row" key={capability.id}>
                <div className={`admin-capability-symbol ${capability.ready ? "is-ready" : ""}`}>{capability.ready ? <Check size={17} /> : <Clock3 size={17} />}</div>
                <div className="admin-capability-main">
                  <div><strong>{capability.id}</strong><span>{capability.provider}</span></div>
                  <div className="admin-progress"><i style={{ width: `${Math.min(100, capability.passingSampleCount / capability.acceptanceTarget * 100)}%` }} /></div>
                </div>
                <div className="admin-capability-count"><strong>{capability.passingSampleCount}</strong><span>/ {capability.acceptanceTarget}</span></div>
              </div>
            ))}
          </div>
        </div>

        <div className="admin-panel">
          <div className="admin-panel-heading">
            <div><span className="admin-section-kicker">实时健康</span><h3>服务与风险</h3></div>
            <StatusDot tone={data.service.status === "OK" ? "good" : "bad"}>{data.service.status === "OK" ? "正常" : "需处理"}</StatusDot>
          </div>
          <div className="admin-health-summary">
            <div><span>HTTP 5xx</span><strong>{data.service.http5xx}</strong></div>
            <div><span>慢接口</span><strong>{data.service.slowRoutes.length}</strong></div>
            <div><span>删除积压</span><strong>{data.usage.supplierDeletionPending}</strong></div>
          </div>
          {data.service.alerts.length ? (
            <div className="admin-alert-list">
              {data.service.alerts.slice(0, 4).map((alert) => <div key={`${alert.name}-${alert.createdAt}`}><AlertTriangle size={16} /><span><strong>{alert.name}</strong><small>{formatDate(alert.createdAt)}</small></span></div>)}
            </div>
          ) : <EmptyState icon={<Activity size={24} />} title="暂无活跃告警" copy="当前实例尚未记录服务异常" />}
        </div>
      </section>
    </div>
  );
}

function percent(value: number | null | undefined) {
  return value == null ? "--" : `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
}

function purposeLabel(purpose: string) {
  const exact: Record<string, string> = {
    "video-fusion": "视频换脸",
    "photo-age": "年龄变化",
    "photo-restore": "照片修复",
    "photo-fusion": "照片融合",
    "photo-anime": "漫画风格",
    "photo-bg": "场景换背景",
    idphoto: "证件照",
    unknown: "历史未分类调用",
  };
  if (exact[purpose]) return exact[purpose];
  if (purpose.startsWith("photo-effect:")) return `图片效果 · ${purpose.slice("photo-effect:".length)}`;
  if (purpose.startsWith("photo-bg:")) return `场景背景 · ${purpose.slice("photo-bg:".length)}`;
  if (purpose.startsWith("photo-anime:")) return `漫画风格 · ${purpose.slice("photo-anime:".length)}`;
  return purpose;
}

function AnalyticsPage({ data }: { data: DashboardData | null }) {
  const [days, setDays] = useState<7 | 30>(7);
  if (!data) return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取调用账本</div>;
  const windowData = data.analytics.windows[String(days) as "7" | "30"];
  return (
    <div className="admin-page-stack">
      <div className="admin-toolbar"><div className="admin-segmented"><button type="button" className={days === 7 ? "is-active" : ""} onClick={() => setDays(7)}>近 7 天</button><button type="button" className={days === 30 ? "is-active" : ""} onClick={() => setDays(30)}>近 30 天</button></div><div className="admin-toolbar-note"><ShieldCheck size={16} />来源：真实生成扣次与退款账本</div></div>
      <section className="admin-metric-grid">
        <Metric label="功能调用" value={windowData.calls} note={`${days} 天实际生成预占次数`} icon={<Activity size={18} />} />
        <Metric label="成功率" value={percent(windowData.successRate)} note={`${windowData.successes} 次成功完成`} icon={<Check size={18} />} />
        <Metric label="失败退款" value={windowData.refunds} note="仅统计已执行退款的失败任务" icon={<ArchiveRestore size={18} />} />
        <Metric label="处理中" value={windowData.pending} note="含正在运行或尚未回写结果的任务" icon={<Clock3 size={18} />} />
      </section>
      <section className="admin-panel admin-chart-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">DAILY SERIES</span><h3>调用、成功与退款趋势</h3></div><time>{formatDate(data.analytics.generatedAt)}</time></div>
        {windowData.calls === 0 ? <EmptyState icon={<Activity size={24} />} title="统计周期内暂无调用" copy="曲线只会在真实生成请求进入账本后出现" /> : <div className="admin-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={windowData.daily} margin={{ top: 8, right: 10, bottom: 0, left: -24 }}><CartesianGrid stroke="#edf0ef" vertical={false} /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} tick={{ fontSize: 9, fill: "#87928f" }} axisLine={false} tickLine={false} minTickGap={18} /><YAxis allowDecimals={false} tick={{ fontSize: 9, fill: "#87928f" }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => `日期 ${value}`} contentStyle={{ border: "1px solid #dde4e1", borderRadius: 7, boxShadow: "0 10px 30px rgba(25,45,38,.1)", fontSize: 11 }} /><Line type="monotone" dataKey="calls" name="调用" stroke="#266f61" strokeWidth={2.2} dot={false} activeDot={{ r: 3 }} /><Line type="monotone" dataKey="successes" name="成功" stroke="#4b79b5" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="refunds" name="退款" stroke="#b34b43" strokeWidth={1.8} dot={false} /></LineChart></ResponsiveContainer></div>}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">BY FUNCTION</span><h3>各功能调用表现</h3></div><span className="admin-muted">按真实调用量排序</span></div>
        {windowData.byPurpose.length ? <div className="admin-usage-table"><div className="admin-usage-head"><span>功能</span><span>调用</span><span>成功</span><span>退款</span><span>成功率</span></div>{windowData.byPurpose.map((row) => { const successRate = row.calls ? row.successes / row.calls : null; return <div className="admin-usage-row" key={row.purpose}><span><strong>{purposeLabel(row.purpose)}</strong><small>{row.purpose}</small></span><b>{row.calls}</b><b>{row.successes}</b><b className={row.refunds ? "is-bad" : ""}>{row.refunds}</b><b>{percent(row.successRate ?? successRate)}</b></div>; })}</div> : <EmptyState icon={<CircleGauge size={24} />} title="暂无分功能数据" copy="不会用榜单数字或演示数据填充" />}
      </section>
    </div>
  );
}

function MonitoringPage({ data }: { data: DashboardData | null }) {
  if (!data) return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取服务观测</div>;
  const service = data.service;
  return (
    <div className="admin-page-stack">
      <section className="admin-system-banner admin-monitor-banner"><span className={service.status === "OK" ? "is-good" : "is-bad"}>{service.status === "OK" ? <Check size={24} /> : <AlertTriangle size={24} />}</span><div><p className="admin-eyebrow">LIVE WINDOW</p><h3>{service.status === "OK" ? "当前滚动窗口未触发异常" : "当前滚动窗口需要关注"}</h3><p>{service.readiness.durable ? "请求、5xx 与耗时来自真实观测，已启用单实例快照；正常保存间隔约 10 秒，存储故障期间可能延迟。" : "请求、5xx 与耗时来自真实观测；尚无可靠持久化，请检查存储状态，避免重启丢失窗口。"}</p></div><time>{formatDate(service.capturedAt)}</time></section>
      <section className="admin-metric-grid">
        <Metric label="滚动请求量" value={service.requests} note="当前监控保留窗口" icon={<Activity size={18} />} />
        <Metric label="5xx 比例" value={percent(service.http5xxRate)} note={`${service.http5xx} 次近期服务端错误`} icon={<AlertTriangle size={18} />} />
        <Metric label="平均响应" value={`${service.avgLatencyMs} ms`} note="全路由滚动平均值" icon={<Clock3 size={18} />} />
        <Metric label="活跃事件" value={service.incidents.length} note="由真实告警和阈值规则产生" icon={<ShieldCheck size={18} />} />
      </section>
      <section className="admin-panel admin-chart-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">SERVICE CURVE</span><h3>请求量与 5xx 曲线</h3></div><StatusDot tone={service.readiness.ready ? "good" : "warn"}>{service.readiness.durable ? "持久化" : "实例内存"}</StatusDot></div>
        {service.series.length ? <div className="admin-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={service.series} margin={{ top: 8, right: 10, bottom: 0, left: -24 }}><CartesianGrid stroke="#edf0ef" vertical={false} /><XAxis dataKey="timestamp" tickFormatter={(value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} tick={{ fontSize: 9, fill: "#87928f" }} axisLine={false} tickLine={false} minTickGap={24} /><YAxis allowDecimals={false} tick={{ fontSize: 9, fill: "#87928f" }} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => new Date(value).toLocaleString("zh-CN")} contentStyle={{ border: "1px solid #dde4e1", borderRadius: 7, fontSize: 11 }} /><Line type="monotone" dataKey="requests" name="请求" stroke="#266f61" strokeWidth={2.2} dot={false} /><Line type="monotone" dataKey="errors5xx" name="5xx" stroke="#b34b43" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div> : <EmptyState icon={<Activity size={24} />} title="尚无 HTTP 时间序列" copy="服务收到真实请求后，按分钟形成曲线" />}
      </section>
      <section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-section-kicker">SLOW ROUTES</span><h3>慢接口</h3></div><span className="admin-muted">p95 阈值告警</span></div>{service.slowRoutes.length ? <div className="admin-slow-list">{service.slowRoutes.map((route) => <div key={route.name}><code>{route.name}</code><span><strong>{route.value} ms</strong><small>阈值 {route.limit} ms</small></span></div>)}</div> : <EmptyState icon={<CircleGauge size={24} />} title="暂无慢接口" copy="当前没有路由超过配置的 p95 阈值" />}</section>
    </div>
  );
}

function severityLabel(severity: "critical" | "high" | "medium" | "low") {
  return severity === "critical" ? "严重" : severity === "high" ? "高" : severity === "medium" ? "中" : "低";
}

function RiskPage({ data, user }: { data: DashboardData | null; user: AdminUser }) {
  if (!data) return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取风险事件</div>;
  const { playbooks } = data.service;
  return (
    <div className="admin-page-stack">
      <RiskIncidents user={user} />
      <section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-section-kicker">RESPONSE PLAYBOOKS</span><h3>固定应急预案</h3></div><StatusDot tone="neutral">预案，不是当前故障</StatusDot></div><div className="admin-playbook-grid">{playbooks.map((playbook) => <article className="admin-playbook" key={playbook.id}><div><span className={`admin-risk-level is-${playbook.severity}`}>{severityLabel(playbook.severity)}风险</span><strong>{playbook.title}</strong></div><dl><div><dt>触发条件</dt><dd>{playbook.trigger}</dd></div><div><dt>影响</dt><dd>{playbook.impact}</dd></div><div><dt>解决办法</dt><dd>{playbook.action}</dd></div><div><dt>预防</dt><dd>{playbook.prevention}</dd></div></dl><ol>{playbook.steps.map((step) => <li key={step}>{step}</li>)}</ol></article>)}</div></section>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <button type="button" className={`admin-toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked} aria-label={label}><i /></button>;
}

function TemplateEditor({ template, validation, onClose, onSave, onPreview }: {
  template: Template;
  validation: CatalogValidationState;
  onClose: () => void;
  onSave: (template: Template) => void;
  onPreview: (template: Template, dirty: boolean) => void;
}) {
  const [value, setValue] = useState(template);
  const dirty = JSON.stringify(value) !== JSON.stringify(template);
  const requestClose = () => {
    if (dirty && !window.confirm("当前编辑还没有应用到草稿，确定放弃吗？")) return;
    onClose();
  };
  const update = <K extends keyof Template>(key: K, next: Template[K]) => {
    const updated = { ...value, [key]: next };
    setValue(updated);
    onPreview(updated, JSON.stringify(updated) !== JSON.stringify(template));
  };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="admin-modal admin-modal-editor" role="dialog" aria-labelledby="template-editor-title">
        <div className="admin-modal-head"><div><span className="admin-section-kicker">受控配置 · 右侧实时预览</span><h3 id="template-editor-title">编辑「{template.name}」</h3></div><button type="button" className="admin-icon-button" onClick={requestClose} title="关闭" aria-label="关闭模板编辑"><X size={18} /></button></div>
        <div className="admin-editor-layout admin-editor-layout-form">
          <div className="admin-form-grid">
            <label className="admin-field"><span>名称</span><input value={value.name} onChange={(event) => update("name", event.target.value)} maxLength={24} /></label>
            <label className="admin-field"><span>分类</span><input value={value.category} onChange={(event) => update("category", event.target.value)} maxLength={16} /></label>
            {value.media === "video" && <><label className="admin-field"><span>玩法分区</span><select value={value.group} disabled={!value.id.startsWith("custom-video-")} onChange={(event) => update("group", event.target.value as Template["group"])}><option value="singing">唱歌</option><option value="dancing">跳舞</option><option value="quote">语录</option></select></label><label className="admin-field admin-field-wide"><span>视频使用授权记录</span><input value={value.rightsReference || ""} onChange={(event) => update("rightsReference", event.target.value)} minLength={4} maxLength={200} placeholder="更换或新增视频时填写授权合同编号或自有素材依据" /></label><p className="admin-muted admin-field-wide">选择上传的 MP4 会同时替换动态预览与实际制作源，完成预览和审核后再启用发布。</p></>}
            <label className="admin-field admin-field-wide"><span>说明</span><textarea value={value.description} onChange={(event) => update("description", event.target.value)} maxLength={80} rows={3} /></label>
            <MediaField label="封面图片" value={value.cover} onChange={(url) => update("cover", url)} />
            {value.media === "video" && <MediaField label="制作源与动态预览（MP4）" kind="video" mp4Only value={value.previewVideo || ""} onChange={(url) => update("previewVideo", url)} />}
            <label className="admin-field"><span>展示顺序</span><input type="number" min={0} max={9999} value={value.sortOrder ?? 0} onChange={(event) => update("sortOrder", Number(event.target.value))} /></label>
            <label className="admin-field"><span>预计耗时</span><input value={value.duration} onChange={(event) => update("duration", event.target.value)} maxLength={20} /></label>
            {value.media === "video" && <label className="admin-field"><span>适用人群</span><select value={value.audience || "all"} onChange={(event) => update("audience", event.target.value as Template["audience"])}><option value="all">全部</option><option value="female">女性</option><option value="male">男性</option></select></label>}
            {value.media === "video" && <label className="admin-field"><span>上新时间</span><input type="datetime-local" value={toLocalDateTimeValue(value.publishedAt)} onChange={(event) => update("publishedAt", event.target.value ? new Date(event.target.value).toISOString() : undefined)} /></label>}
            <div className="admin-field admin-field-wide admin-switch-row">
              <span><strong>客户端可见</strong><small>关闭后发布，新用户端将隐藏该模板</small></span><Toggle checked={value.enabled !== false} onChange={(checked) => update("enabled", checked)} label="客户端可见" />
            </div>
            {value.media === "video" && <div className="admin-field admin-field-wide admin-switch-row"><span><strong>进入精选瀑布流</strong><small>最新上架优先；同一上新时间按展示顺序排列</small></span><Toggle checked={value.featured === true} onChange={(checked) => update("featured", checked)} label="进入精选" /></div>}
          </div>
        </div>
        <footer className="admin-modal-actions admin-editor-actions">
          <span className={`admin-inline-validation is-${validation.state}`}>{validation.state === "checking" ? "正在校验客户端配置" : validation.state === "valid" ? "配置与素材校验通过" : validation.state === "invalid" ? validation.message : "等待校验"}</span>
          <button type="button" className="admin-secondary-button" onClick={requestClose}>取消</button>
          <button type="button" className="admin-primary-button" disabled={validation.state !== "valid"} onClick={() => onSave(value)}><Check size={16} />应用到草稿</button>
        </footer>
      </section>
    </div>
  );
}

function TemplatesPage({ catalog, validation, previewActive, onChange, onPreview, onEditorClose }: {
  catalog: RuntimeCatalog;
  validation: CatalogValidationState;
  previewActive: boolean;
  onChange: (catalog: RuntimeCatalog) => void;
  onPreview: (catalog: RuntimeCatalog, focus: PreviewFocus, dirty: boolean) => void;
  onEditorClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newTemplate, setNewTemplate] = useState<Template | null>(null);
  const templates = useMemo(() => sortVideoTemplatesNewestFirst(catalog.templates.filter((item) => item.media === "video" && `${item.name}${item.category}${item.description}`.toLowerCase().includes(query.toLowerCase()))), [catalog.templates, query]);
  const editing = newTemplate || catalog.templates.find((item) => item.id === editingId);
  const withTemplate = (template: Template) => catalog.templates.some((item) => item.id === template.id) ? catalog.templates.map((item) => item.id === template.id ? template : item) : [...catalog.templates, template];
  const replace = (template: Template) => {
    onChange({ ...catalog, templates: withTemplate(template) });
    setNewTemplate(null);
    setEditingId(null);
    onEditorClose();
  };
  const preview = (template: Template, dirty: boolean) => onPreview({ ...catalog, templates: withTemplate(template) }, { kind: "template", id: template.id }, dirty);
  const closeEditor = () => { setEditingId(null); setNewTemplate(null); onEditorClose(); };
  const createTemplate = () => {
    const base = catalog.templates.find((item) => item.media === "video");
    if (!base) return;
    const template: Template = { ...base, id: `custom-video-${crypto.randomUUID()}`, name: "新视频模板", media: "video", mode: "video-fusion", enabled: false, featured: false, cover: "", previewVideo: "", publishedAt: new Date().toISOString(), rightsReference: "" };
    setNewTemplate(template); preview(template, true);
  };
  const openEditor = (template: Template) => { setEditingId(template.id); onPreview(catalog, { kind: "template", id: template.id }, false); };
  return (
    <div className="admin-page-stack">
      <div className="admin-toolbar">
        <div className="admin-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、分类或说明" /></div>
        <div className="admin-toolbar-note"><ShieldCheck size={16} />技术标识和调用能力已锁定</div>
        <button type="button" className="admin-primary-button" onClick={createTemplate} disabled={!catalog.templates.some((item) => item.media === "video")}><Plus size={16} />新增视频模板</button>
      </div>
      <div className="admin-table-panel">
        <div className="admin-table-head admin-template-columns"><span>模板</span><span>玩法</span><span>状态</span><span>精选</span><span>顺序</span><span /></div>
        {templates.length ? templates.map((template) => (
          <div className="admin-table-row admin-template-columns" key={template.id}>
            <div className="admin-template-cell"><div className="admin-template-thumb">{template.previewVideo && !previewActive ? <video src={template.previewVideo} poster={template.cover} muted loop autoPlay playsInline preload="metadata" /> : <img src={template.cover} alt="" />}</div><span><strong>{template.name}</strong><small>{template.description}</small></span></div>
            <span><strong className="admin-cell-primary">{GROUP_LABELS[template.group] || template.group}</strong><small className="admin-cell-secondary">{template.category}</small></span>
            <StatusDot tone={template.enabled !== false ? "good" : "neutral"}>{template.enabled !== false ? "已启用" : "已隐藏"}</StatusDot>
            <span>{template.featured ? "是" : "否"}</span>
            <span className="admin-order-value">{template.sortOrder ?? 0}</span>
            <button type="button" className="admin-icon-button" onClick={() => openEditor(template)} title={`编辑${template.name}`} aria-label={`编辑${template.name}`}><Settings2 size={17} /></button>
          </div>
        )) : <EmptyState icon={<Search size={24} />} title={query ? "未找到匹配模板" : "暂无视频模板"} copy={query ? "请调整关键词后重新搜索" : "当前草稿中没有可管理的视频模板"} />}
      </div>
      {editing && <TemplateEditor template={editing} validation={validation} onClose={closeEditor} onSave={replace} onPreview={preview} />}
    </div>
  );
}

function PhotoEffectEditor({ effect, categories, validation, onClose, onSave, onPreview }: {
  effect: PhotoEffect;
  categories: PhotoEffectCategory[];
  validation: CatalogValidationState;
  onClose: () => void;
  onSave: (effect: PhotoEffect) => void;
  onPreview: (effect: PhotoEffect, dirty: boolean) => void;
}) {
  const [value, setValue] = useState(effect);
  const dirty = JSON.stringify(value) !== JSON.stringify(effect);
  const update = (patch: Partial<PhotoEffect>) => {
    const updated = { ...value, ...patch };
    setValue(updated);
    onPreview(updated, JSON.stringify(updated) !== JSON.stringify(effect));
  };
  const requestClose = () => {
    if (dirty && !window.confirm("当前编辑还没有应用到草稿，确定放弃吗？")) return;
    onClose();
  };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="admin-modal admin-modal-compact admin-modal-editor" role="dialog" aria-labelledby="effect-editor-title">
        <div className="admin-modal-head"><div><span className="admin-section-kicker">效果卡片 · 右侧实时预览</span><h3 id="effect-editor-title">编辑「{effect.title}」</h3></div><button type="button" className="admin-icon-button" onClick={requestClose} title="关闭" aria-label="关闭图片效果编辑"><X size={18} /></button></div>
        <div className="admin-effect-editor admin-effect-editor-form">
          <div className="admin-form-grid">
            <label className="admin-field"><span>名称</span><input value={value.title} onChange={(event) => update({ title: event.target.value })} maxLength={24} /></label>
            <label className="admin-field"><span>角标</span><input value={value.badge || ""} onChange={(event) => update({ badge: event.target.value })} maxLength={8} placeholder="可留空" /></label>
            <label className="admin-field"><span>所属分类</span><select value={value.categoryId} onChange={(event) => update({ categoryId: event.target.value as PhotoEffect["categoryId"] })}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            {!["age-change", "face-enhance", "natural-color", "super-resolution"].includes(value.id) && <label className="admin-field admin-field-wide"><span>生成效果提示词（后台专用）</span><textarea value={value.prompt || ""} onChange={(event) => update({ prompt: event.target.value })} minLength={10} maxLength={1500} rows={5} placeholder="明确人物保留特征、画面风格、服装和场景要求；已有效果留空时沿用默认提示词" /><small>修改后请通过真实样本验收效果，再启用发布。预览图仅表示展示素材。</small></label>}
            <label className="admin-field admin-field-wide"><span>效果说明</span><textarea value={value.subtitle} onChange={(event) => update({ subtitle: event.target.value })} maxLength={60} rows={3} /></label>
            <MediaField label="效果预览图" value={value.preview || ""} onChange={(preview) => update({ preview })} />
            <label className="admin-field"><span>展示顺序</span><input type="number" min={0} max={9999} value={value.sortOrder ?? 0} onChange={(event) => update({ sortOrder: Number(event.target.value) })} /></label>
            <div className="admin-field admin-switch-row"><span><strong>客户端可见</strong></span><Toggle checked={value.enabled !== false} onChange={(enabled) => update({ enabled })} label="效果可见" /></div>
          </div>
        </div>
        <footer className="admin-modal-actions admin-editor-actions"><span className={`admin-inline-validation is-${validation.state}`}>{validation.state === "checking" ? "正在校验" : validation.state === "valid" ? "配置与素材校验通过" : validation.state === "invalid" ? validation.message : "等待校验"}</span><button type="button" className="admin-secondary-button" onClick={requestClose}>取消</button><button type="button" className="admin-primary-button" disabled={validation.state !== "valid"} onClick={() => onSave(value)}><Check size={16} />应用到草稿</button></footer>
      </section>
    </div>
  );
}

function PhotoCategoryEditor({ category, validation, onClose, onSave, onPreview }: {
  category: PhotoEffectCategory;
  validation: CatalogValidationState;
  onClose: () => void;
  onSave: (category: PhotoEffectCategory) => void;
  onPreview: (category: PhotoEffectCategory, dirty: boolean) => void;
}) {
  const [value, setValue] = useState(category);
  const dirty = JSON.stringify(value) !== JSON.stringify(category);
  const update = (patch: Partial<PhotoEffectCategory>) => {
    const updated = { ...value, ...patch };
    setValue(updated);
    onPreview(updated, JSON.stringify(updated) !== JSON.stringify(category));
  };
  const requestClose = () => {
    if (dirty && !window.confirm("当前编辑还没有应用到草稿，确定放弃吗？")) return;
    onClose();
  };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="admin-modal admin-modal-compact admin-modal-editor" role="dialog" aria-labelledby="category-editor-title">
        <div className="admin-modal-head"><div><span className="admin-section-kicker">功能分区 · 右侧实时预览</span><h3 id="category-editor-title">编辑「{category.name}」</h3></div><button type="button" className="admin-icon-button" onClick={requestClose} title="关闭" aria-label="关闭图片分类编辑"><X size={18} /></button></div>
        <div className="admin-effect-editor admin-effect-editor-form">
          <div className="admin-form-grid">
            <label className="admin-field"><span>分类名称</span><input value={value.name} onChange={(event) => update({ name: event.target.value })} maxLength={16} /></label>
            <label className="admin-field"><span>短标签</span><input value={value.kicker} onChange={(event) => update({ kicker: event.target.value })} maxLength={12} /></label>
            <label className="admin-field admin-field-wide"><span>分类说明</span><textarea value={value.description} onChange={(event) => update({ description: event.target.value })} maxLength={80} rows={3} /></label>
            <MediaField label="分类封面" value={value.cover} onChange={(cover) => update({ cover })} />
            <label className="admin-field"><span>强调色</span><input type="color" value={value.accent} onChange={(event) => update({ accent: event.target.value })} /></label>
            <label className="admin-field"><span>展示顺序</span><input type="number" min={0} max={9999} value={value.sortOrder ?? 0} onChange={(event) => update({ sortOrder: Number(event.target.value) })} /></label>
            <div className="admin-field admin-field-wide admin-switch-row"><span><strong>客户端可见</strong><small>隐藏分类时，其中效果也不会出现在客户端</small></span><Toggle checked={value.enabled !== false} onChange={(enabled) => update({ enabled })} label="分类可见" /></div>
          </div>
        </div>
        <footer className="admin-modal-actions admin-editor-actions"><span className={`admin-inline-validation is-${validation.state}`}>{validation.state === "checking" ? "正在校验" : validation.state === "valid" ? "配置与素材校验通过" : validation.state === "invalid" ? validation.message : "等待校验"}</span><button type="button" className="admin-secondary-button" onClick={requestClose}>取消</button><button type="button" className="admin-primary-button" disabled={validation.state !== "valid"} onClick={() => onSave(value)}><Check size={16} />应用到草稿</button></footer>
      </section>
    </div>
  );
}

function PhotosPage({ catalog, validation, onChange, onPreview, onEditorClose }: {
  catalog: RuntimeCatalog;
  validation: CatalogValidationState;
  onChange: (catalog: RuntimeCatalog) => void;
  onPreview: (catalog: RuntimeCatalog, focus: PreviewFocus, dirty: boolean) => void;
  onEditorClose: () => void;
}) {
  const [activeCategory, setActiveCategory] = useState(catalog.photoCategories[0]?.id || "time");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [newEffect, setNewEffect] = useState<PhotoEffect | null>(null);
  const [newCategory, setNewCategory] = useState<PhotoEffectCategory | null>(null);
  const categories = [...catalog.photoCategories].sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
  const effects = catalog.photoEffects.filter((effect) => effect.categoryId === activeCategory).sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0));
  const editing = newEffect || catalog.photoEffects.find((effect) => effect.id === editingId);
  const editingCategory = newCategory || catalog.photoCategories.find((category) => category.id === editingCategoryId);
  const withCategory = (category: PhotoEffectCategory) => catalog.photoCategories.some((item) => item.id === category.id) ? catalog.photoCategories.map((item) => item.id === category.id ? category : item) : [...catalog.photoCategories, category];
  const withEffect = (effect: PhotoEffect) => catalog.photoEffects.some((item) => item.id === effect.id) ? catalog.photoEffects.map((item) => item.id === effect.id ? effect : item) : [...catalog.photoEffects, effect];
  const updateCategory = (category: PhotoEffectCategory, enabled: boolean) => onChange({ ...catalog, photoCategories: catalog.photoCategories.map((item) => item.id === category.id ? { ...item, enabled } : item) });
  const replaceCategory = (category: PhotoEffectCategory) => {
    onChange({ ...catalog, photoCategories: withCategory(category) });
    setNewCategory(null); setActiveCategory(category.id);
    setEditingCategoryId(null);
    onEditorClose();
  };
  const replaceEffect = (effect: PhotoEffect) => {
    onChange({ ...catalog, photoEffects: withEffect(effect) });
    setNewEffect(null); setActiveCategory(effect.categoryId);
    setEditingId(null);
    onEditorClose();
  };
  const previewCategory = (category: PhotoEffectCategory, dirty: boolean) => onPreview({ ...catalog, photoCategories: withCategory(category) }, { kind: "photo-category", id: category.id }, dirty);
  const previewEffect = (effect: PhotoEffect, dirty: boolean) => onPreview({ ...catalog, photoEffects: withEffect(effect) }, { kind: "photo-effect", id: effect.id }, dirty);
  const closeEditors = () => { setEditingId(null); setEditingCategoryId(null); setNewEffect(null); setNewCategory(null); onEditorClose(); };
  const createCategory = () => {
    const base = catalog.photoCategories[0];
    if (!base) return;
    const category: PhotoEffectCategory = { ...base, id: `custom-category-${crypto.randomUUID()}`, name: "新分类", kicker: "创意效果", description: "自定义图片效果分类", cover: "", enabled: false };
    setNewCategory(category); previewCategory(category, true);
  };
  const createEffect = () => {
    const base = catalog.photoEffects.find((item) => !["age-change", "face-enhance", "natural-color", "super-resolution"].includes(item.id));
    if (!base) return;
    const effect: PhotoEffect = { ...base, id: `custom-effect-${crypto.randomUUID()}`, title: "新图片效果", subtitle: "填写具体效果说明", categoryId: activeCategory as PhotoEffect["categoryId"], preview: "", enabled: false, prompt: "" };
    setNewEffect(effect); previewEffect(effect, true);
  };
  const openCategoryEditor = (category: PhotoEffectCategory) => { setEditingCategoryId(category.id); onPreview(catalog, { kind: "photo-category", id: category.id }, false); };
  const openEffectEditor = (effect: PhotoEffect) => { setEditingId(effect.id); onPreview(catalog, { kind: "photo-effect", id: effect.id }, false); };
  return (
    <div className="admin-photo-layout">
      <aside className="admin-category-rail">
        <div className="admin-category-title"><span>图片分类</span><small>{categories.length} 个</small></div>
        <button type="button" className="admin-secondary-button" onClick={createCategory}><Plus size={15} />新增分类</button>
        {categories.map((category) => (
          <div key={category.id} className={`admin-category-item ${activeCategory === category.id ? "is-active" : ""}`}>
            <button type="button" className="admin-category-select" onClick={() => setActiveCategory(category.id)}>
              <i style={{ backgroundColor: category.accent }} /><span><strong>{category.name}</strong><small>{catalog.photoEffects.filter((effect) => effect.categoryId === category.id && effect.enabled !== false).length} 个效果</small></span>
            </button>
            <span className="admin-category-actions"><Toggle checked={category.enabled !== false} onChange={(enabled) => updateCategory(category, enabled)} label={`${category.name}可见`} /><button type="button" className="admin-icon-button" onClick={() => openCategoryEditor(category)} title={`编辑${category.name}`} aria-label={`编辑${category.name}`}><Settings2 size={15} /></button></span>
          </div>
        ))}
      </aside>
      <section className="admin-effects-main">
        <div className="admin-toolbar"><div><span className="admin-section-kicker">效果预览</span><h3>{categories.find((item) => item.id === activeCategory)?.name}</h3></div><button type="button" className="admin-primary-button" onClick={createEffect}><Plus size={16} />新增效果</button><div className="admin-toolbar-note"><ImageIcon size={16} />展示图实时预览，生成质量须单独验收</div></div>
        <div className="admin-effect-grid">
          {effects.map((effect) => (
            <button type="button" className={`admin-effect-card ${effect.enabled === false ? "is-disabled" : ""}`} key={effect.id} onClick={() => openEffectEditor(effect)}>
              <span className="admin-effect-media"><img src={effect.preview} alt={`${effect.title}预览`} />{effect.badge && <em>{effect.badge}</em>}</span>
              <span className="admin-effect-copy"><strong>{effect.title}</strong><small>{effect.subtitle}</small></span>
              <span className="admin-effect-footer"><StatusDot tone={effect.enabled !== false ? "good" : "neutral"}>{effect.enabled !== false ? "显示" : "隐藏"}</StatusDot><span>顺序 {effect.sortOrder ?? 0}</span></span>
            </button>
          ))}
        </div>
      </section>
      {editing && <PhotoEffectEditor effect={editing} categories={categories} validation={validation} onClose={closeEditors} onSave={replaceEffect} onPreview={previewEffect} />}
      {editingCategory && <PhotoCategoryEditor category={editingCategory} validation={validation} onClose={closeEditors} onSave={replaceCategory} onPreview={previewCategory} />}
    </div>
  );
}

type WorkflowCreateInput = {
  type: WorkflowType;
  name: string;
  desiredOutcome: string;
  businessOwner: string;
  providerHint: string;
  riskLevel: WorkflowRisk;
  notes: string;
};

function WorkflowCreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (input: WorkflowCreateInput) => Promise<boolean> }) {
  const [value, setValue] = useState<WorkflowCreateInput>({ type: "capability", name: "", desiredOutcome: "", businessOwner: "", providerHint: "", riskLevel: "medium", notes: "" });
  const [busy, setBusy] = useState(false);
  const valid = value.name.trim().length >= 2 && value.desiredOutcome.trim().length >= 4 && value.businessOwner.trim().length >= 2;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const created = await onCreate(value);
    setBusy(false);
    if (created) onClose();
  };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="admin-modal admin-modal-compact" role="dialog" aria-modal="true" aria-labelledby="workflow-create-title" onSubmit={(event) => void submit(event)}>
        <div className="admin-modal-head"><div><span className="admin-section-kicker">受控接入</span><h3 id="workflow-create-title">提交新能力或素材</h3></div><button type="button" className="admin-icon-button" onClick={onClose} title="关闭" aria-label="关闭新需求窗口"><X size={18} /></button></div>
        <div className="admin-workflow-form admin-form-grid">
          <label className="admin-field"><span>需求类型</span><select value={value.type} onChange={(event) => setValue({ ...value, type: event.target.value as WorkflowType })}>{Object.entries(WORKFLOW_TYPE_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label className="admin-field"><span>风险等级</span><select value={value.riskLevel} onChange={(event) => setValue({ ...value, riskLevel: event.target.value as WorkflowRisk })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label className="admin-field admin-field-wide"><span>名称</span><input value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} maxLength={80} placeholder="例如：照片跳舞模板" /></label>
          <label className="admin-field admin-field-wide"><span>用户得到什么</span><textarea value={value.desiredOutcome} onChange={(event) => setValue({ ...value, desiredOutcome: event.target.value })} maxLength={2000} rows={4} placeholder="用可验收的结果描述，不填写实现方案" /></label>
          <label className="admin-field"><span>业务负责人</span><input value={value.businessOwner} onChange={(event) => setValue({ ...value, businessOwner: event.target.value })} maxLength={80} /></label>
          <label className="admin-field"><span>候选供应商 / 模型</span><input value={value.providerHint} onChange={(event) => setValue({ ...value, providerHint: event.target.value })} maxLength={160} placeholder="不得填写密钥" /></label>
          <label className="admin-field admin-field-wide"><span>验收与版权备注</span><textarea value={value.notes} onChange={(event) => setValue({ ...value, notes: event.target.value })} maxLength={2000} rows={3} /></label>
        </div>
        <footer className="admin-modal-actions"><button type="button" className="admin-secondary-button" onClick={onClose}>取消</button><button type="submit" className="admin-primary-button" disabled={!valid || busy}>{busy ? <RefreshCw size={16} className="admin-spin" /> : <Plus size={16} />}{busy ? "正在提交" : "提交需求"}</button></footer>
      </form>
    </div>
  );
}

function WorkflowTransitionDialog({ item, target, onClose, onConfirm }: { item: WorkflowItem; target: WorkflowStatus; onClose: () => void; onConfirm: (item: WorkflowItem, target: WorkflowStatus, note: string) => Promise<boolean> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = note.trim().length >= 4;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const updated = await onConfirm(item, target, note.trim());
    setBusy(false);
    if (updated) onClose();
  };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="admin-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="workflow-action-title">
        <div className={`admin-confirm-icon ${target === "rejected" ? "is-danger" : ""}`}>{target === "rejected" ? <XCircle size={19} /> : <ChevronRight size={19} />}</div>
        <h3 id="workflow-action-title">{target === "rejected" ? "驳回" : "推进"}「{item.name}」</h3>
        <p>状态将从“{WORKFLOW_STATUS_LABELS[item.status]}”变为“{WORKFLOW_STATUS_LABELS[target]}”，该操作进入审计记录。</p>
        <label className="admin-field"><span>{target === "rejected" ? "驳回原因" : "阶段结论"}</span><textarea autoFocus rows={3} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="至少填写 4 个字" /></label>
        <footer className="admin-modal-actions"><button type="button" className="admin-secondary-button" onClick={onClose}>取消</button><button type="button" className={target === "rejected" ? "admin-danger-button" : "admin-primary-button"} disabled={!valid || busy} onClick={() => void submit()}>{busy ? <RefreshCw size={16} className="admin-spin" /> : target === "rejected" ? <XCircle size={16} /> : <ChevronRight size={16} />}{busy ? "正在处理" : target === "rejected" ? "确认驳回" : "确认推进"}</button></footer>
      </section>
    </div>
  );
}

function WorkflowPage({ user, items, loadState, loadError, onRetry, onCreate, onTransition }: {
  user: AdminUser;
  items: WorkflowItem[];
  loadState: LoadState;
  loadError: string;
  onRetry: () => void;
  onCreate: (input: WorkflowCreateInput) => Promise<boolean>;
  onTransition: (item: WorkflowItem, target: WorkflowStatus, note: string) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<"all" | WorkflowStatus>("all");
  const [creating, setCreating] = useState(false);
  const [transition, setTransition] = useState<{ item: WorkflowItem; target: WorkflowStatus } | null>(null);
  const canCreate = user.role === "owner" || user.role === "operator";
  const canReview = user.role === "owner" || user.role === "reviewer";
  const visible = status === "all" ? items : items.filter((item) => item.status === status);
  if (loadState === "loading" || loadState === "idle") return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取接入需求</div>;
  if (loadState === "error") return <LoadErrorState title="接入需求加载失败" message={loadError} onRetry={onRetry} />;
  return (
    <div className="admin-page-stack">
      <div className="admin-toolbar">
        <div className="admin-segmented admin-workflow-filter"><button type="button" className={status === "all" ? "is-active" : ""} onClick={() => setStatus("all")}>全部 <span>{items.length}</span></button>{(["submitted", "technical_review", "integration", "quality_validation", "ready", "rejected"] as WorkflowStatus[]).map((itemStatus) => <button type="button" className={status === itemStatus ? "is-active" : ""} onClick={() => setStatus(itemStatus)} key={itemStatus}>{WORKFLOW_STATUS_LABELS[itemStatus]} <span>{items.filter((item) => item.status === itemStatus).length}</span></button>)}</div>
        {canCreate && <button type="button" className="admin-primary-button" onClick={() => setCreating(true)}><Plus size={16} />新建接入需求</button>}
      </div>
      <section className="admin-workflow-list" aria-label="能力接入需求">
        {visible.length ? visible.map((item) => {
          const next = WORKFLOW_NEXT[item.status];
          const tone = item.status === "ready" ? "good" : item.status === "rejected" || item.riskLevel === "high" ? "bad" : item.status === "submitted" ? "neutral" : "warn";
          return <article className="admin-workflow-row" key={item.id}>
            <div className="admin-workflow-symbol"><Blocks size={18} /></div>
            <div className="admin-workflow-copy"><div><span>{WORKFLOW_TYPE_LABELS[item.type]}</span><StatusDot tone={tone}>{WORKFLOW_STATUS_LABELS[item.status]}</StatusDot><em className={`is-${item.riskLevel}`}>{item.riskLevel === "high" ? "高风险" : item.riskLevel === "medium" ? "中风险" : "低风险"}</em></div><h3>{item.name}</h3><p>{item.desiredOutcome}</p><small>负责人 {item.businessOwner} · 更新 {formatDate(item.updatedAt)} · r{item.revision}{item.providerHint ? ` · ${item.providerHint}` : ""}</small></div>
            {canReview && !["ready", "rejected"].includes(item.status) && <div className="admin-workflow-actions">{next && <button type="button" className="admin-primary-button admin-small-button" onClick={() => setTransition({ item, target: next })}>推进到{WORKFLOW_STATUS_LABELS[next]}</button>}<button type="button" className="admin-secondary-button admin-small-button" onClick={() => setTransition({ item, target: "rejected" })}>驳回</button></div>}
          </article>;
        }) : <EmptyState icon={<Blocks size={24} />} title={status === "all" ? "暂无接入需求" : `暂无“${WORKFLOW_STATUS_LABELS[status]}”需求`} copy="只展示真实提交记录，不用示例数据填充" />}
      </section>
      {creating && <WorkflowCreateDialog onClose={() => setCreating(false)} onCreate={onCreate} />}
      {transition && <WorkflowTransitionDialog item={transition.item} target={transition.target} onClose={() => setTransition(null)} onConfirm={onTransition} />}
    </div>
  );
}

function AppearancePage({ catalog, onChange }: { catalog: RuntimeCatalog; onChange: (catalog: RuntimeCatalog) => void }) {
  const setTheme = (key: keyof RuntimeCatalog["theme"], value: string) => onChange({ ...catalog, theme: { ...catalog.theme, [key]: value } });
  const setSettings = <K extends keyof RuntimeCatalog["settings"]>(key: K, value: RuntimeCatalog["settings"][K]) => onChange({ ...catalog, settings: { ...catalog.settings, [key]: value } });
  const colors: Array<{ key: keyof RuntimeCatalog["theme"]; label: string; description: string }> = [
    { key: "accent", label: "品牌主色", description: "导航选中、主操作与品牌标题" },
    { key: "secondary", label: "辅助高亮", description: "分类指示与状态强调" },
    { key: "background", label: "页面背景", description: "客户端主背景" },
    { key: "surface", label: "卡片表面", description: "列表与功能卡片背景" },
    { key: "text", label: "主要文字", description: "系统会阻止低对比度发布" },
  ];
  return (
    <div className="admin-appearance-grid">
      <section className="admin-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">设计令牌</span><h3>品牌配色</h3></div><Paintbrush size={20} /></div>
        <div className="admin-color-list">
          {colors.map((color) => <label className="admin-color-row" key={color.key}><input type="color" value={catalog.theme[color.key]} onChange={(event) => setTheme(color.key, event.target.value)} /><span><strong>{color.label}</strong><small>{color.description}</small></span><code>{catalog.theme[color.key]}</code></label>)}
        </div>
        <div className="admin-theme-preview" style={{ background: catalog.theme.background, color: catalog.theme.text }}>
          <span style={{ color: catalog.theme.accent }}>乐颜秀</span>
          <div style={{ background: catalog.theme.surface }}><strong>经典歌曲</strong><small>让照片唱出熟悉旋律</small><button type="button" style={{ background: catalog.theme.accent }}>立即制作</button></div>
          <i style={{ background: catalog.theme.secondary }} />
        </div>
      </section>
      <section className="admin-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">全局控制</span><h3>产品开关</h3></div><SlidersHorizontal size={20} /></div>
        <div className="admin-setting-list">
          <div className="admin-setting-row"><span><strong>允许生成作品</strong><small>关闭后所有真实生成接口立即拒绝新任务</small></span><Toggle checked={catalog.settings.generationEnabled} onChange={(value) => setSettings("generationEnabled", value)} label="允许生成作品" /></div>
          <div className="admin-setting-row"><span><strong>成片分享文案</strong><small>控制客户端文案入口是否开放</small></span><Toggle checked={catalog.settings.captionEnabled} onChange={(value) => setSettings("captionEnabled", value)} label="分享文案" /></div>
          <label className="admin-field"><span>产品名称</span><input value={catalog.settings.productName} maxLength={12} onChange={(event) => setSettings("productName", event.target.value)} /></label>
          <label className="admin-field"><span>维护提示</span><textarea rows={3} maxLength={80} value={catalog.settings.maintenanceNotice} onChange={(event) => setSettings("maintenanceNotice", event.target.value)} placeholder="仅在暂停生成时显示" /></label>
        </div>
        <div className="admin-guardrail-note"><ShieldCheck size={18} /><span><strong>不能在后台关闭的合规基线</strong><small>内容审核、AI 标识、人脸单独同意、保存期限和供应商密钥不属于运营配置。</small></span></div>
      </section>
    </div>
  );
}

function ActionDialog({ type, release, onClose, onConfirm, busy }: { type: "publish" | "rollback" | "pause"; release?: CatalogRelease; onClose: () => void; onConfirm: (note: string) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  const labels = type === "publish" ? { title: "发布当前草稿", copy: "发布后客户端会读取新的配置版本。", action: "确认发布", icon: <Play size={19} /> }
    : type === "rollback" ? { title: `回滚到 v${release?.version}`, copy: "系统会创建一个新的回滚版本，不会删除历史记录。", action: "确认回滚", icon: <ArchiveRestore size={19} /> }
      : { title: "紧急暂停生成", copy: "这会立即发布停机开关，所有新生成请求将被拒绝。", action: "立即暂停", icon: <PauseCircle size={19} /> };
  return (
    <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="admin-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="action-dialog-title">
        <div className={`admin-confirm-icon ${type === "pause" ? "is-danger" : ""}`}>{labels.icon}</div>
        <h3 id="action-dialog-title">{labels.title}</h3><p>{labels.copy}</p>
        <label className="admin-field"><span>{type === "pause" ? "停机原因" : "变更说明"}</span><textarea autoFocus rows={3} maxLength={120} value={note} onChange={(event) => setNote(event.target.value)} placeholder="至少填写 4 个字，便于审计追踪" /></label>
        <div className="admin-modal-actions"><button type="button" className="admin-secondary-button" onClick={onClose}>取消</button><button type="button" disabled={busy || note.trim().length < 4} className={type === "pause" ? "admin-danger-button" : "admin-primary-button"} onClick={() => onConfirm(note.trim())}>{busy ? <RefreshCw size={16} className="admin-spin" /> : labels.icon}{labels.action}</button></div>
      </section>
    </div>
  );
}

function PublishPage({ workspace, localChanged, canPause, onPublish, onRollback, onPause }: { workspace: CatalogWorkspace; localChanged: boolean; canPause: boolean; onPublish: () => void; onRollback: (release: CatalogRelease) => void; onPause: () => void }) {
  return (
    <div className="admin-page-stack">
      <section className="admin-release-summary">
        <div><span className="admin-section-kicker">CURRENT RELEASE</span><strong>v{workspace.published.version}</strong><p>{formatDate(workspace.published.publishedAt)} · {workspace.published.publishedBy}</p></div>
        <div className="admin-release-state"><StatusDot tone={workspace.dirty || localChanged ? "warn" : "good"}>{localChanged ? "有未保存修改" : workspace.dirty ? "草稿待发布" : "线上已同步"}</StatusDot><button type="button" className="admin-primary-button" disabled={localChanged || !workspace.dirty} onClick={onPublish}><Play size={16} />发布草稿</button>{canPause && <button type="button" className="admin-danger-ghost" onClick={onPause}><PauseCircle size={16} />紧急停机</button>}</div>
      </section>
      <section className="admin-panel">
        <div className="admin-panel-heading"><div><span className="admin-section-kicker">完整性封印</span><h3>发布与回滚记录</h3></div><span className="admin-muted">保留最近 {workspace.releases.length} 个版本</span></div>
        <div className="admin-release-timeline">
          {workspace.releases.map((release, index) => {
            const current = release.id === workspace.published.releaseId;
            const sealed = release.integrityStatus !== "legacy-unsealed";
            return <div className="admin-release-row" key={release.id}><span className={`admin-release-node ${current ? "is-current" : ""}`}>{current ? <Check size={15} /> : release.action === "rollback" ? <ArchiveRestore size={15} /> : <FileClock size={15} />}</span><div><strong>v{release.version} · {release.action === "rollback" ? "回滚发布" : release.action === "seed" ? "初始版本" : "正式发布"}</strong><p>{release.note}</p><small>{formatDate(release.publishedAt)} · {release.publishedBy}{sealed ? " · 素材已封印" : " · 历史素材未封印"}</small></div>{current ? <StatusDot tone="good">当前在线</StatusDot> : index > 0 ? <button type="button" className="admin-secondary-button admin-small-button" disabled={!sealed} title={sealed ? "创建新的回滚发布" : release.integrityReason || "缺少发布时素材指纹，不能直接回滚"} onClick={() => onRollback(release)}><ArchiveRestore size={14} />{sealed ? "回滚到此版" : "需重新审核"}</button> : null}</div>;
          })}
        </div>
      </section>
    </div>
  );
}

function GovernancePage({ reports, moderation, loadState, loadError, onRetry, onReport, onModeration }: { reports: ReportItem[]; moderation: ModerationItem[]; loadState: LoadState; loadError: string; onRetry: () => void; onReport: (item: ReportItem, status: string) => void; onModeration: (item: ModerationItem, decision: "allow" | "block") => void }) {
  const [tab, setTab] = useState<"reports" | "moderation">("reports");
  if (loadState === "idle" || loadState === "loading") return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取治理数据</div>;
  if (loadState === "error") return <LoadErrorState title="治理数据加载失败" message={loadError} onRetry={onRetry} />;
  return (
    <div className="admin-page-stack">
      <div className="admin-segmented"><button type="button" className={tab === "reports" ? "is-active" : ""} onClick={() => setTab("reports")}>用户举报 <span>{reports.length}</span></button><button type="button" className={tab === "moderation" ? "is-active" : ""} onClick={() => setTab("moderation")}>内容审核 <span>{moderation.length}</span></button></div>
      <div className="admin-table-panel">
        {tab === "reports" && (reports.length ? reports.map((report) => <div className="admin-governance-row" key={report.id}><div className="admin-governance-symbol"><ClipboardCheck size={18} /></div><div><strong>{report.category} · {report.id.slice(0, 12)}</strong><p>{report.sensitive?.description || "敏感说明已过保存期或无法解密"}</p><small>{formatDate(report.createdAt)}{report.templateId ? ` · 模板 ${report.templateId}` : ""}</small></div><StatusDot tone={report.status === "resolved" ? "good" : report.status === "processing" ? "warn" : "neutral"}>{report.status}</StatusDot><div className="admin-row-actions">{report.status === "submitted" && <button type="button" onClick={() => onReport(report, "processing")}>开始处理</button>}{!["resolved", "rejected"].includes(report.status) && <button type="button" onClick={() => onReport(report, "resolved")}>标记解决</button>}</div></div>) : <EmptyState icon={<ClipboardCheck size={24} />} title="暂无用户举报" copy="新的举报会自动出现在这里" />)}
        {tab === "moderation" && (moderation.length ? moderation.map((item) => <div className="admin-governance-row" key={item.id}><div className="admin-governance-symbol"><ShieldCheck size={18} /></div><div><strong>{item.direction === "input" ? "输入审核" : "输出审核"} · {item.id.slice(0, 12)}</strong><p>{item.reason || item.categories.join("、") || "未记录风险说明"}</p><small>{formatDate(item.createdAt)} · {item.provider}</small></div><StatusDot tone={item.decision === "allow" ? "good" : item.decision === "block" ? "bad" : "warn"}>{item.decision}</StatusDot><div className="admin-row-actions">{item.decision === "review" && <><button type="button" onClick={() => onModeration(item, "allow")}>通过</button><button type="button" className="is-danger" onClick={() => onModeration(item, "block")}>拦截</button></>}</div></div>) : <EmptyState icon={<ShieldCheck size={24} />} title="暂无审核记录" copy="真实审核记录会按时间倒序显示" />)}
      </div>
    </div>
  );
}

function AuditPage({ admin, business, loadState, loadError, onRetry }: { admin: AuditItem[]; business: AuditItem[]; loadState: LoadState; loadError: string; onRetry: () => void }) {
  const [source, setSource] = useState<"admin" | "business">("admin");
  const items = source === "admin" ? admin : business;
  if (loadState === "idle" || loadState === "loading") return <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取审计记录</div>;
  if (loadState === "error") return <LoadErrorState title="审计记录加载失败" message={loadError} onRetry={onRetry} />;
  return (
    <div className="admin-page-stack">
      <div className="admin-segmented"><button type="button" className={source === "admin" ? "is-active" : ""} onClick={() => setSource("admin")}>后台变更</button><button type="button" className={source === "business" ? "is-active" : ""} onClick={() => setSource("business")}>业务与合规</button></div>
      <div className="admin-table-panel">
        {items.length ? items.map((item) => <div className="admin-audit-row" key={item.id}><span className="admin-audit-icon"><FileClock size={17} /></span><div><strong>{item.action}</strong><p>{item.actor || item.reviewerId || "system"} · {item.resourceType || "后台配置"}{item.resourceId ? ` / ${item.resourceId.slice(0, 20)}` : ""}</p></div><time>{formatDate(item.createdAt)}</time></div>) : <EmptyState icon={<FileClock size={24} />} title="暂无审计记录" copy="保存、发布、回滚和治理操作会记录在这里" />}
      </div>
    </div>
  );
}

function SystemPage({ dashboard, readiness }: { dashboard: DashboardData | null; readiness: { status: string; publicLaunchAllowed: boolean; blockers: string[]; checkedAt: string } | null }) {
  return (
    <div className="admin-page-stack">
      <section className="admin-system-banner">
        <span className={readiness?.publicLaunchAllowed ? "is-good" : "is-bad"}>{readiness?.publicLaunchAllowed ? <Check size={22} /> : <XCircle size={22} />}</span>
        <div><p className="admin-section-kicker">PUBLIC LAUNCH GATE</p><h3>{readiness?.status || "正在核验"}</h3><p>{readiness?.publicLaunchAllowed ? "生产闸门已满足代码侧检查。" : "当前仅适合内部受控测试，不可据此对外宣称已具备上架条件。"}</p></div>
        <time>{formatDate(readiness?.checkedAt)}</time>
      </section>
      <section className="admin-two-column">
        <div className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-section-kicker">运行环境</span><h3>服务配置摘要</h3></div><MonitorCog size={20} /></div><dl className="admin-definition-list"><div><dt>部署环境</dt><dd>{dashboard?.environment.deploy || "--"}</dd></div><div><dt>视频主渠道</dt><dd>{dashboard?.environment.provider || "--"}</dd></div><div><dt>图片主渠道</dt><dd>{dashboard?.environment.photoProvider || "--"}</dd></div><div><dt>发布渠道</dt><dd>{dashboard?.environment.releaseChannel || "--"}</dd></div></dl></div>
        <div className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-section-kicker">阻断项</span><h3>正式上线前仍需完成</h3></div><span className="admin-count-badge">{readiness?.blockers.length || 0}</span></div>{readiness?.blockers.length ? <ol className="admin-blocker-list">{readiness.blockers.map((blocker, index) => <li key={`${blocker}-${index}`}><span>{index + 1}</span><p>{blocker}</p></li>)}</ol> : <EmptyState icon={<Check size={24} />} title="暂无代码侧阻断项" copy="仍需以平台与主管部门实际审核为准" />}</div>
      </section>
    </div>
  );
}

function AdminConsole({ user, onSignedOut }: { user: AdminUser; onSignedOut: () => void }) {
  const [page, setPage] = useState<Page>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [workspace, setWorkspace] = useState<CatalogWorkspace | null>(null);
  const [draft, setDraft] = useState<RuntimeCatalog | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [moderation, setModeration] = useState<ModerationItem[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [audits, setAudits] = useState<{ admin: AuditItem[]; business: AuditItem[] }>({ admin: [], business: [] });
  const [readiness, setReadiness] = useState<{ status: string; publicLaunchAllowed: boolean; blockers: string[]; checkedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [coreError, setCoreError] = useState("");
  const [governanceLoadState, setGovernanceLoadState] = useState<LoadState>("idle");
  const [governanceLoadError, setGovernanceLoadError] = useState("");
  const [auditLoadState, setAuditLoadState] = useState<LoadState>("idle");
  const [auditLoadError, setAuditLoadError] = useState("");
  const [workflowLoadState, setWorkflowLoadState] = useState<LoadState>("idle");
  const [workflowLoadError, setWorkflowLoadError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>("draft");
  const [previewEdit, setPreviewEdit] = useState<PreviewEditState | null>(null);
  const [catalogValidation, setCatalogValidation] = useState<CatalogValidationState>({ state: "idle" });
  const [toast, setToast] = useState<{ tone: "good" | "bad"; message: string } | null>(null);
  const [action, setAction] = useState<{ type: "publish" | "rollback" | "pause"; release?: CatalogRelease } | null>(null);

  const notify = useCallback((tone: "good" | "bad", message: string) => {
    setToast({ tone, message });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const loadCore = useCallback(async () => {
    setLoading(true);
    setCoreError("");
    try {
      const [nextDashboard, nextWorkspace] = await Promise.all([getDashboard(), getCatalogWorkspace()]);
      setDashboard(nextDashboard);
      setWorkspace(nextWorkspace);
      setDraft(cloneCatalog(nextWorkspace.draft.catalog));
      setPreviewEdit(null);
      return true;
    } catch (error) {
      setCoreError(errorMessage(error));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDashboard = useCallback(async () => {
    try {
      setDashboard(await getDashboard());
    } catch {
      // Keep the last known snapshot; the manual refresh path surfaces errors.
    }
  }, []);

  const loadGovernance = useCallback(async () => {
    setGovernanceLoadState("loading");
    setGovernanceLoadError("");
    try {
      const [nextReports, nextModeration] = await Promise.all([getReports(), getModeration()]);
      setReports(nextReports);
      setModeration(nextModeration);
      setGovernanceLoadState("ready");
    } catch (error) {
      setGovernanceLoadError(errorMessage(error));
      setGovernanceLoadState("error");
    }
  }, []);

  const loadAudits = useCallback(async () => {
    setAuditLoadState("loading");
    setAuditLoadError("");
    try {
      setAudits(await getAudits());
      setAuditLoadState("ready");
    } catch (error) {
      setAuditLoadError(errorMessage(error));
      setAuditLoadState("error");
    }
  }, []);

  const loadWorkflows = useCallback(async () => {
    setWorkflowLoadState("loading");
    setWorkflowLoadError("");
    try {
      setWorkflows(await getWorkflows());
      setWorkflowLoadState("ready");
    } catch (error) {
      setWorkflowLoadError(errorMessage(error));
      setWorkflowLoadState("error");
    }
  }, []);

  useEffect(() => { void loadCore(); }, [loadCore]);

  const previewCatalog = previewEdit?.catalog || draft;

  useEffect(() => {
    if (!previewCatalog) {
      setCatalogValidation({ state: "idle" });
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setCatalogValidation({ state: "checking" });
      void validateCatalogDraft(previewCatalog)
        .then((result) => { if (active) setCatalogValidation({ state: "valid", hash: result.catalogHash }); })
        .catch((error) => { if (active) setCatalogValidation({ state: "invalid", message: errorMessage(error) }); });
    }, 260);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [previewCatalog]);

  useEffect(() => {
    if (!["overview", "analytics", "monitoring", "risk"].includes(page)) return;
    const timer = window.setInterval(() => void refreshDashboard(), 30_000);
    return () => window.clearInterval(timer);
  }, [page, refreshDashboard]);

  useEffect(() => {
    if (page === "governance") void loadGovernance();
    if (page === "audit") void loadAudits();
    if (page === "intake") void loadWorkflows();
    if (page === "system") void getReadiness().then(setReadiness).catch((error) => notify("bad", errorMessage(error)));
  }, [loadAudits, loadGovernance, loadWorkflows, notify, page]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!previewEdit?.dirty && !(draft && workspace && JSON.stringify(draft) !== JSON.stringify(workspace.draft.catalog))) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [draft, previewEdit?.dirty, workspace]);

  const localChanged = Boolean(draft && workspace && JSON.stringify(draft) !== JSON.stringify(workspace.draft.catalog));
  const canEdit = user.role === "owner" || user.role === "operator";
  const canSaveCurrentPage = canEdit && ["templates", "photos", "appearance"].includes(page);
  const canPublish = user.role === "owner" || user.role === "reviewer";
  const canPause = user.role === "owner";
  const canGovern = user.role === "owner" || user.role === "reviewer";
  const allowedPages = ROLE_PAGE_ACCESS[user.role];
  const navigation = NAVIGATION.filter((item) => allowedPages.includes(item.id));
  const currentNav = navigation.find((item) => item.id === page) || navigation[0];

  const revealPreview = () => {
    setPreviewSource("draft");
    if (window.innerWidth >= 760) setPreviewOpen(true);
  };

  const changeDraft = (catalog: RuntimeCatalog) => {
    setDraft(catalog);
    setPreviewEdit(null);
    revealPreview();
  };

  const previewTransientCatalog = (catalog: RuntimeCatalog, focus: PreviewFocus, dirty: boolean) => {
    setPreviewEdit({ catalog, focus, dirty });
    revealPreview();
  };

  const closeEditorPreview = () => setPreviewEdit(null);

  const navigate = (nextPage: Page) => {
    if (previewEdit?.dirty && !window.confirm("当前编辑还没有应用到草稿，确定离开吗？")) return;
    setPreviewEdit(null);
    setPage(nextPage);
    setMobileNav(false);
    if (["templates", "photos", "appearance", "publish"].includes(nextPage) && window.innerWidth >= 1180) setPreviewOpen(true);
  };

  const saveDraft = async () => {
    if (!draft || !workspace || !canEdit) return;
    if (catalogValidation.state !== "valid") {
      notify("bad", catalogValidation.message || "草稿尚未通过配置与素材校验");
      return;
    }
    setBusy(true);
    try {
      const next = await saveCatalogDraft(draft, workspace.draft.revision, "后台手动保存");
      setWorkspace(next); setDraft(cloneCatalog(next.draft.catalog)); setPreviewEdit(null); notify("good", "草稿已安全保存");
      setDashboard(await getDashboard());
    } catch (error) { notify("bad", errorMessage(error)); }
    finally { setBusy(false); }
  };

  const executeAction = async (note: string) => {
    if (!workspace || !action) return;
    const authorized = action.type === "pause" ? canPause : canPublish;
    if (!authorized) {
      setAction(null);
      notify("bad", "当前账号没有执行此操作的权限");
      return;
    }
    setBusy(true);
    try {
      const next = action.type === "publish" ? await publishCatalog(workspace.draft.revision, note)
        : action.type === "rollback" && action.release ? await rollbackCatalog(action.release.id, note)
          : await emergencyPause(note);
      setWorkspace(next); setDraft(cloneCatalog(next.draft.catalog)); setPreviewEdit(null); setAction(null); setDashboard(await getDashboard());
      notify("good", action.type === "publish" ? "新配置已发布" : action.type === "rollback" ? "历史版本已回滚并重新发布" : "生成服务已紧急暂停");
    } catch (error) { notify("bad", errorMessage(error)); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    if ((localChanged || previewEdit?.dirty) && !window.confirm("仍有未保存或未应用的编辑，退出后会丢失。确定退出吗？")) return;
    try { await logout(); } catch { /* local state is still cleared */ }
    onSignedOut();
  };

  const refresh = async () => {
    if ((localChanged || previewEdit?.dirty) && !window.confirm("当前有未保存或未应用的修改，刷新后会丢失。确定继续刷新吗？")) return;
    if (!await loadCore()) return;
    if (page === "governance") await loadGovernance();
    if (page === "audit") await loadAudits();
    if (page === "intake") await loadWorkflows();
    if (page === "system") {
      try { setReadiness(await getReadiness()); }
      catch (error) { notify("bad", errorMessage(error)); }
    }
  };

  const reportDecision = async (item: ReportItem, status: string) => {
    if (!canGovern) return;
    try { await updateReport(item.id, status, "后台人工处置"); setReports(await getReports()); notify("good", "举报状态已更新"); } catch (error) { notify("bad", errorMessage(error)); }
  };
  const moderationDecision = async (item: ModerationItem, decision: "allow" | "block") => {
    if (!canGovern) return;
    try { await decideModeration(item.id, decision, "后台人工复核"); setModeration(await getModeration()); notify("good", decision === "allow" ? "内容已通过" : "内容已拦截"); } catch (error) { notify("bad", errorMessage(error)); }
  };
  const workflowCreate = async (input: WorkflowCreateInput) => {
    try {
      await createWorkflow(input);
      await loadWorkflows();
      notify("good", "接入需求已提交");
      return true;
    } catch (error) {
      notify("bad", errorMessage(error));
      return false;
    }
  };
  const workflowTransition = async (item: WorkflowItem, status: WorkflowStatus, note: string) => {
    try {
      await updateWorkflow(item.id, item.revision, { status, notes: note });
      await loadWorkflows();
      notify("good", status === "rejected" ? "需求已驳回并留痕" : `需求已推进到${WORKFLOW_STATUS_LABELS[status]}`);
      return true;
    } catch (error) {
      notify("bad", errorMessage(error));
      return false;
    }
  };

  const sections = [...new Set(navigation.map((item) => item.section))];
  return (
    <div className={`admin-app ${previewOpen ? "has-live-preview" : ""}`}>
      <aside className={`admin-sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="admin-sidebar-brand"><div className="admin-brand-mark"><Sparkles size={19} /></div><span><strong>乐颜秀</strong><small>运营控制台</small></span><button type="button" className="admin-sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button></div>
        <nav>
          {sections.map((section) => <div className="admin-nav-section" key={section}><p>{section}</p>{navigation.filter((item) => item.section === section).map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={page === item.id ? "is-active" : ""} onClick={() => navigate(item.id)}><Icon size={18} /><span>{item.label}</span>{item.id === "publish" && (workspace?.dirty || localChanged) && <i />}</button>; })}</div>)}
        </nav>
        <div className="admin-sidebar-footer"><div className="admin-avatar">{user.displayName.slice(0, 1)}</div><span><strong>{user.displayName}</strong><small>{ROLE_LABELS[user.role]}</small></span><button type="button" className="admin-icon-button" onClick={() => void signOut()} title="退出登录" aria-label="退出登录"><LogOut size={17} /></button></div>
      </aside>
      {mobileNav && <button type="button" className="admin-sidebar-scrim" onClick={() => setMobileNav(false)} aria-label="关闭导航" />}
      <main className="admin-main">
        <header className="admin-topbar"><button type="button" className="admin-mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={20} /></button><div><p>{currentNav.section}</p><h1>{currentNav.label}</h1></div><div className="admin-topbar-actions"><StatusDot tone={dashboard?.environment.deploy === "production" ? "warn" : "neutral"}>{dashboard?.environment.deploy || "连接中"}</StatusDot>{draft && workspace && <button type="button" className={`admin-preview-button ${previewOpen ? "is-active" : ""}`} onClick={() => setPreviewOpen((open) => !open)} aria-pressed={previewOpen}><MonitorSmartphone size={16} /><span>实时预览</span></button>}<button type="button" className="admin-icon-button" onClick={() => void refresh()} title="刷新" aria-label="刷新后台数据"><RefreshCw size={17} className={loading ? "admin-spin" : ""} /></button>{canSaveCurrentPage && draft && workspace && <button type="button" className="admin-primary-button" disabled={!localChanged || busy || catalogValidation.state !== "valid"} onClick={() => void saveDraft()}><Save size={16} />保存草稿</button>}</div></header>
        <div className="admin-content">
          {loading && (!dashboard || !workspace) ? <div className="admin-page-loading"><RefreshCw className="admin-spin" />正在读取后台核心数据</div> : coreError ? (
            <LoadErrorState title="后台核心数据加载失败" message={coreError} onRetry={() => void refresh()} busy={loading} />
          ) : <>
            {page === "overview" && <OverviewPage data={dashboard} onNavigate={navigate} />}
            {page === "analytics" && <AnalyticsPage data={dashboard} />}
            {page === "billing" && <BillingPanel user={user} />}
            {page === "templates" && canEdit && draft && <TemplatesPage catalog={draft} validation={catalogValidation} previewActive={previewOpen} onChange={changeDraft} onPreview={previewTransientCatalog} onEditorClose={closeEditorPreview} />}
            {page === "photos" && canEdit && draft && <PhotosPage catalog={draft} validation={catalogValidation} onChange={changeDraft} onPreview={previewTransientCatalog} onEditorClose={closeEditorPreview} />}
            {page === "appearance" && canEdit && draft && <AppearancePage catalog={draft} onChange={changeDraft} />}
            {page === "media" && canEdit && <section className="admin-panel"><div className="admin-panel-heading"><h3>素材库</h3></div><p className="admin-muted">上传后可在视频模板、图片效果或分类编辑器中选择使用，右侧预览同步更新。</p><MediaLibrary /></section>}
            {page === "intake" && <WorkflowPage user={user} items={workflows} loadState={workflowLoadState} loadError={workflowLoadError} onRetry={() => void loadWorkflows()} onCreate={workflowCreate} onTransition={workflowTransition} />}
            {page === "publish" && canPublish && workspace && <PublishPage workspace={workspace} localChanged={localChanged} canPause={canPause} onPublish={() => setAction({ type: "publish" })} onRollback={(release) => setAction({ type: "rollback", release })} onPause={() => setAction({ type: "pause" })} />}
            {page === "governance" && canGovern && <GovernancePage reports={reports} moderation={moderation} loadState={governanceLoadState} loadError={governanceLoadError} onRetry={() => void loadGovernance()} onReport={(item, status) => void reportDecision(item, status)} onModeration={(item, decision) => void moderationDecision(item, decision)} />}
            {page === "audit" && <AuditPage admin={audits.admin} business={audits.business} loadState={auditLoadState} loadError={auditLoadError} onRetry={() => void loadAudits()} />}
            {page === "monitoring" && <MonitoringPage data={dashboard} />}
            {page === "risk" && <RiskPage data={dashboard} user={user} />}
            {page === "system" && <SystemPage dashboard={dashboard} readiness={readiness} />}
          </>}
        </div>
      </main>
      {previewOpen && draft && workspace && (
        <LivePreview
          draftCatalog={previewCatalog || draft}
          publishedCatalog={workspace.published.catalog}
          focus={previewEdit?.focus || null}
          editorDirty={Boolean(previewEdit?.dirty)}
          localChanged={localChanged}
          workspaceDirty={workspace.dirty}
          revision={workspace.draft.revision}
          version={workspace.published.version}
          validation={catalogValidation}
          source={previewSource}
          onSourceChange={setPreviewSource}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {toast && <div className={`admin-toast is-${toast.tone}`} role="status">{toast.tone === "good" ? <Check size={17} /> : <AlertTriangle size={17} />}{toast.message}</div>}
      {action && <ActionDialog type={action.type} release={action.release} onClose={() => setAction(null)} onConfirm={(note) => void executeAction(note)} busy={busy} />}
    </div>
  );
}

export default function AdminApp() {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    void currentAdmin().then(setUser).catch(() => setUser(null)).finally(() => setChecking(false));
  }, []);
  if (checking) return <main className="admin-boot"><div className="admin-brand-mark"><Sparkles size={22} /></div><RefreshCw className="admin-spin" size={18} /><span>正在验证后台会话</span></main>;
  return user ? <AdminConsole user={user} onSignedOut={() => setUser(null)} /> : <LoginView onAuthenticated={setUser} />;
}
