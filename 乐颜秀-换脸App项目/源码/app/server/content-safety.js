const POLICY_VERSION = process.env.CONTENT_POLICY_VERSION || "unapproved-local-v1";
const MODE = process.env.CONTENT_SAFETY_MODE || "local_rules";

const RULES = [
  { category: "sexual_content", words: ["色情", "裸聊", "淫秽", "裸体", "成人视频", "porn"] },
  { category: "minors", words: ["未成年", "儿童", "小学生", "幼儿", "未成年人"] },
  { category: "fraud_or_impersonation", words: ["冒充", "诈骗", "假证", "伪造", "换脸诈骗", "客服验证码"] },
  { category: "violence_or_extremism", words: ["暴恐", "爆炸", "斩首", "恐怖组织", "极端主义"] },
  { category: "identity_abuse", words: ["公众人物换脸", "明星换脸", "去水印", "去标识", "移除水印"] },
];

function matches(text) {
  const normalized = String(text || "").toLowerCase();
  return RULES.filter((rule) => rule.words.some((word) => normalized.includes(word.toLowerCase()))).map((rule) => rule.category);
}

export function moderate({ text = "", metadata = {}, direction = "input" } = {}) {
  if (MODE !== "local_rules") {
    return {
      decision: "block",
      categories: ["moderation_provider_unavailable"],
      direction,
      provider: MODE,
      policyVersion: POLICY_VERSION,
      reason: "外部内容安全适配器尚未接入，已按失败关闭策略阻断",
    };
  }
  const categories = [...new Set([...matches(text), ...matches(JSON.stringify(metadata))])];
  const decision = categories.some((category) => ["sexual_content", "minors", "fraud_or_impersonation", "violence_or_extremism"].includes(category))
    ? "block"
    : categories.length
      ? "review"
      : "allow";
  return {
    decision,
    categories,
    direction,
    provider: MODE === "local_rules" ? "local-rules" : MODE,
    policyVersion: POLICY_VERSION,
    reason: categories.length ? `命中内容安全规则: ${categories.join(",")}` : null,
  };
}

export function contentSafetyReadiness() {
  const production = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
  const blockers = [];
  if (!POLICY_VERSION || POLICY_VERSION.startsWith("unapproved-")) blockers.push("CONTENT_POLICY_VERSION must reference an approved company policy");
  if (production && MODE === "local_rules") blockers.push("production requires an approved image/video content safety provider or reviewed policy exception");
  if (production && MODE !== "local_rules") blockers.push("external content safety adapter is not implemented; credentials alone cannot satisfy launch readiness");
  return { ready: blockers.length === 0, mode: MODE, policyVersion: POLICY_VERSION, blockers };
}

export function contentSafetyConfig() {
  return { mode: MODE, policyVersion: POLICY_VERSION, rules: RULES.map(({ category }) => category) };
}
