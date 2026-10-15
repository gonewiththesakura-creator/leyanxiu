import { snapshot, metricsPersistenceState } from "./metrics.js";

const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedRate(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function production() {
  return String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
}

export function monitoringReadiness() {
  const mode = String(process.env.MONITORING_MODE || "local_log").trim() || "local_log";
  const blockers = [];
  const persistence = metricsPersistenceState();
  if (!persistence.ready) blockers.push("监控快照存储不可用，指标尚未可靠保存");
  // METRICS_LOG_PATH only persists alert lines. The rolling request series and
  // alert state are still process-memory data and cannot support production
  // incident recovery or audit by themselves.
  if (production()) blockers.push("rolling HTTP metrics and alert state are process-memory only; production requires a durable monitoring backend");
  if (production() && mode === "local_log" && !process.env.METRICS_LOG_PATH) blockers.push("METRICS_LOG_PATH is required when MONITORING_MODE=local_log");
  if (production() && mode !== "local_log") blockers.push("only the local log monitoring adapter is implemented; configure and verify a supported adapter");
  return {
    ready: blockers.length === 0,
    mode,
    backend: persistence.backend,
    durable: persistence.durable,
    persistence,
    blockers,
  };
}

function alertWindowStart(now) {
  const minutes = boundedInteger(process.env.MONITORING_ALERT_WINDOW_MINUTES, 24 * 60, 5, 7 * 24 * 60);
  return now - minutes * 60_000;
}

function thresholdIncident({ key, severity, title, impact, action, prevention, details, firstSeen, now, source = "live_metric_threshold" }) {
  return {
    id: `incident:${key}`,
    key,
    title,
    severity,
    status: "open",
    impact,
    action,
    prevention,
    details,
    source,
    firstSeen: new Date(firstSeen || now).toISOString(),
    lastSeen: new Date(now).toISOString(),
  };
}

function classifyAlert(alert, now) {
  const name = String(alert?.name || "unknown");
  const lower = name.toLowerCase();
  if (lower === "alert.drill") {
    return thresholdIncident({
      key: "alert-drill",
      severity: "low",
      title: "监控演练事件",
      impact: "仅用于验证告警链路，不影响用户服务",
      action: "核对值班人员是否收到告警，并在演练记录中关闭",
      prevention: "按月执行一次告警演练并保留回执",
      details: {},
      firstSeen: Date.parse(alert.createdAt) || now,
      now,
      source: "observed_alert",
    });
  }
  if (lower.includes("emergency_pause") || lower.includes("takedown.failed") || lower.includes("account.erasure_failed")) {
    return thresholdIncident({
      key: name,
      severity: "critical",
      title: name,
      impact: lower.includes("takedown") ? "违规内容可能继续对外可见" : lower.includes("erasure") ? "用户删除请求可能未完整执行" : "创作服务已被紧急暂停",
      action: lower.includes("takedown") ? "立即人工核对对象存储与公开链接，重试下架并保留证据" : lower.includes("erasure") ? "暂停相关账号后核对对象、任务、供应商删除回执" : "确认供应商与存储状态，修复根因后再恢复生成",
      prevention: lower.includes("takedown") ? "为下架操作配置可重试队列和删除回执监控" : lower.includes("erasure") ? "建立删除编排、超时重试和每日对账" : "发布前演练停机开关、回滚和恢复条件",
      details: alert.details || {},
      firstSeen: Date.parse(alert.createdAt) || now,
      now,
      source: "observed_alert",
    });
  }
  if (lower.includes("failed") || lower.includes("error") || lower.includes("failure")) {
    return thresholdIncident({
      key: name,
      severity: "high",
      title: name,
      impact: "对应业务流程可能失败，用户可能无法完成制作或数据控制",
      action: "先查看同一时间段服务日志和供应商状态，确认失败率后限流、回滚或切换已验收供应商",
      prevention: "为该流程设置失败率、重试上限和供应商健康检查",
      details: alert.details || {},
      firstSeen: Date.parse(alert.createdAt) || now,
      now,
      source: "observed_alert",
    });
  }
  if (lower.includes("budget") || lower.includes("daily_generation_limit")) {
    return thresholdIncident({
      key: name,
      severity: lower.includes("budget") ? "high" : "medium",
      title: name,
      impact: "生成请求会被额度闸门拒绝，可能影响创作转化；不会绕过额度继续调用供应商",
      action: "核对真实供应商账单与调用量，按预算审批调整上限或等待窗口恢复，不直接关闭保护",
      prevention: "按供应商和功能设置预算、单用户限额、日周月趋势监控",
      details: alert.details || {},
      firstSeen: Date.parse(alert.createdAt) || now,
      now,
      source: "observed_alert",
    });
  }
  return thresholdIncident({
    key: name,
    severity: "medium",
    title: name,
    impact: "需要运营核对该告警对应的业务流程",
    action: "查看告警详情与服务日志，确认是否需要暂停相关功能",
    prevention: "为告警补充明确阈值、责任人和复盘记录",
    details: alert.details || {},
    firstSeen: Date.parse(alert.createdAt) || now,
    now,
    source: "observed_alert",
  });
}

function playbooks() {
  return [
    {
      id: "playbook-http-5xx",
      title: "HTTP 5xx 率升高",
      severity: "high",
      status: "预案",
      isPlan: true,
      trigger: "最近滚动窗口的请求数达到最小样本且 5xx 率超过阈值",
      impact: "部分用户请求失败，可能造成生成任务无法创建或查询",
      action: "确认发布版本与供应商状态，先限流/回滚，再恢复并复盘",
      prevention: "灰度发布、健康检查、错误预算和供应商降级演练",
      steps: ["确认影响路由", "保留请求 ID 与日志", "必要时回滚最近版本", "验证错误率恢复"],
      source: "predefined_playbook",
    },
    {
      id: "playbook-http-latency",
      title: "接口延迟异常",
      severity: "medium",
      status: "预案",
      isPlan: true,
      trigger: "单一路由 p95 延迟超过配置阈值",
      impact: "页面等待时间变长，异步任务可能超时",
      action: "定位慢路由及其下游，限制重试并检查存储/供应商响应",
      prevention: "为下游设置超时、隔离和缓存，持续压测关键路径",
      steps: ["查看慢路由样本", "确认下游耗时", "降级非关键功能", "观察 p95 回落"],
      source: "predefined_playbook",
    },
    {
      id: "playbook-generation-failure",
      title: "生成失败或退款增加",
      severity: "high",
      status: "预案",
      isPlan: true,
      trigger: "按功能真实成功/退款序列出现异常波动",
      impact: "用户制作失败并触发次数退款，供应商成本与体验同时受影响",
      action: "按功能核对模板、供应商和输入质量，暂停问题功能并保留退款对账",
      prevention: "上线前样本验收、失败自动退款、供应商切换与回归测试",
      steps: ["识别问题功能", "抽查失败任务", "核对退款与账本", "修复后用小流量复测"],
      source: "predefined_playbook",
    },
  ];
}

export function monitoringSnapshot() {
  const data = snapshot();
  const now = Date.now();
  const p95Limit = Math.max(1, Number(process.env.ALERT_P95_MS || 15_000));
  const slowRoutes = Object.entries(data.p95Ms)
    .filter(([name, value]) => name.startsWith("http.") && value !== null && value > p95Limit)
    .map(([name, value]) => ({ name, value, limit: p95Limit }));
  const series = data.http?.series || [];
  const recentRequests = series.reduce((total, point) => total + point.requests, 0);
  const recent5xx = series.reduce((total, point) => total + point.errors5xx, 0);
  const http5xxRate = recentRequests ? recent5xx / recentRequests : 0;
  const minRequests = boundedInteger(process.env.ALERT_HTTP_5XX_MIN_REQUESTS, 5, 1, 1_000_000);
  const rateLimit = boundedRate(process.env.ALERT_HTTP_5XX_RATE, 0.05);
  const incidents = [];
  const seen = new Set();
  for (const alert of data.alerts.filter((item) => (Date.parse(item.createdAt) || 0) >= alertWindowStart(now))) {
    const incident = classifyAlert(alert, now);
    if (seen.has(incident.key)) continue;
    seen.add(incident.key);
    incidents.push(incident);
  }
  if (recentRequests >= minRequests && http5xxRate > rateLimit) {
    incidents.push(thresholdIncident({
      key: "http.5xx-rate",
      severity: "high",
      title: "HTTP 5xx 比例超过阈值",
      impact: `最近滚动窗口 ${recentRequests} 个请求中有 ${recent5xx} 个 5xx，部分用户请求失败`,
      action: "按路由查看日志和下游状态，必要时限流或回滚；修复后观察错误率恢复",
      prevention: "灰度发布、错误预算、下游超时与熔断演练",
      details: { requests: recentRequests, errors5xx: recent5xx, rate: Number(http5xxRate.toFixed(4)), limit: rateLimit, minRequests },
      firstSeen: now,
      now,
    }));
  }
  for (const route of slowRoutes) {
    const routeKey = route.name.replace(/^http\./, "");
    incidents.push(thresholdIncident({
      key: `http.slow:${routeKey}`,
      severity: "medium",
      title: `接口延迟异常：${routeKey}`,
      impact: "该路由的 95% 请求超过响应时延阈值，用户可能长时间等待",
      action: "检查该路由下游、存储和供应商耗时，限制重复重试并按需降级",
      prevention: "设置下游超时、隔离和慢请求采样，发布前压测",
      details: { p95Ms: route.value, limitMs: route.limit },
      firstSeen: now,
      now,
    }));
  }
  incidents.sort((left, right) => (SEVERITY_ORDER[right.severity] || 0) - (SEVERITY_ORDER[left.severity] || 0) || Date.parse(right.lastSeen) - Date.parse(left.lastSeen));
  return {
    status: incidents.some((item) => ["critical", "high", "medium"].includes(item.severity)) ? "ALERT" : "OK",
    thresholds: { p95Ms: p95Limit, http5xxRate: rateLimit, http5xxMinRequests: minRequests },
    http5xx: data.counters ? Object.entries(data.counters).filter(([name]) => name.startsWith("http.status.5")).reduce((total, [, value]) => total + value, 0) : recent5xx,
    http5xxRecent: recent5xx,
    http5xxRate,
    recentRequests,
    slowRoutes,
    series,
    incidents,
    playbooks: playbooks(),
    readiness: monitoringReadiness(),
    ...data,
  };
}
