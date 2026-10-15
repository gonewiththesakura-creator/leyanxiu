import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node make_checklist_docx.js /abs/path/老板方需办理事项清单.docx");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const T = String.raw;
const docTitle = T`乐颜秀小程序 · 老板方需办理及交接事项清单`;
const palette = { dark: "263238", primary: "37474F", light: "78909C", fill: "EEF3F6" };
const font = { ascii: "Times New Roman", hAnsi: "Times New Roman", cs: "Times New Roman", eastAsia: "SimSun" };

const run = (text, options = {}) => new TextRun({ text, font, size: 24, ...options });
const para = (children, options = {}) =>
  new Paragraph({
    spacing: { after: 140, line: 300 },
    ...options,
    children: Array.isArray(children) ? children : [children],
  });
const h1 = (text) =>
  para(run(text, { bold: true, size: 30, color: palette.dark }), {
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
  });
const h2 = (text) =>
  para(run(text, { bold: true, size: 26, color: palette.primary }), {
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
  });
const bullet = (text, opts = {}) => para(run(text, opts), { bullet: { level: 0 }, spacing: { after: 80, line: 300 } });
const bulletRich = (parts) => para(parts, { bullet: { level: 0 }, spacing: { after: 80, line: 300 } });
const cell = (text, options = {}) =>
  new TableCell({
    children: [para(run(text), { spacing: { after: 40, line: 280 } })],
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    ...options,
  });
const makeTable = (widths, rows) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    rows: rows.map(
      (row, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          children: row.map((text, ci) =>
            cell(text, {
              width: { size: widths[ci], type: WidthType.DXA },
              shading: ri === 0 ? { type: ShadingType.CLEAR, fill: palette.fill } : undefined,
            }),
          ),
        }),
    ),
  });

const handover = (text) =>
  para([run(T`✔ 交接给开发侧：`, { bold: true, color: "1B5E20" }), run(text)], {
    indent: { left: 360 },
    spacing: { after: 120 },
  });

const children = [
  para(run(docTitle, { bold: true, size: 38, color: palette.dark }), {
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    spacing: { before: 1000, after: 360 },
  }),
  para(run(T`开发侧已完成全部代码和云端部署准备。以下事项需以公司主体办理，办理后把对应信息交接给开发侧即可上线。`, { size: 22, color: palette.light }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
  }),
  para(run(T`按办理顺序排列；全功能统一上线，整体周期主要取决于第 4 项深度合成备案速度（1~3 个月）。`, { size: 22, color: palette.light }), {
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
  }),

  h1(T`一、必须办理（卡上线）`),

  h2(T`1. 注册微信小程序（1~2 天）`),
  bullet(T`入口：https://mp.weixin.qq.com → 立即注册 →「小程序」→ 主体选「企业」`),
  bulletRich([run(T`用`), run(T`公司营业执照`, { bold: true }), run(T`注册，并完成`), run(T`微信认证`, { bold: true }), run(T`（300 元/年，腾讯收取）`)]),
  bulletRich([run(T`每个小程序需要一个独立邮箱`, { bold: true }), run(T`（未注册过微信公众平台/微信开放平台的邮箱），请提前准备`)]),
  handover(T`小程序 AppID；并把开发人员微信号加为项目成员（开发者权限）：小程序后台「管理 → 成员管理」。小程序名称请提前想好（涉及 AI/换脸字样可能被要求补充资质，建议用中性名，如「乐颜秀」）`),
  bulletRich([run(T`📌 如计划`), run(T`矩阵运营`, { bold: true }), run(T`：建议一次想好 2~3 个名称分别注册（流程相同，每个约 10 分钟）。首发号先完成微信认证；矩阵号可先免费注册占位（拿到 AppID、锁定名称），上线前再认证。全部 AppID 在深度合成备案（第 4 项）时一次挂满，备案号全矩阵共用。`)]),

  h2(T`2. 开通云开发（10 分钟，需管理员扫码）`),
  bullet(T`小程序后台 →「开发 → 云服务 → 云开发」→ 开通（选按量计费）`),
  bullet(T`云托管、云存储、云数据库随用随扣，预计小流量每月几元~几十元，费用从公司账户/微信扣除`),
  handover(T`开通时开发人员在场扫码，或把开发人员加为云环境协作者，后续部署由开发侧完成`),

  h2(T`3. 小程序备案（工信部，1~2 周审核）`),
  bullet(T`小程序后台 →「设置 → 小程序备案」按指引提交`),
  bullet(T`需要：营业执照、法人/负责人身份证、负责人手机 + 人脸核验`),
  para([run(T`✔ `, { bold: true, color: "1B5E20" }), run(T`无需交接，公司侧自行完成`)], { indent: { left: 360 } }),

  h2(T`4. 深度合成服务备案（网信办，最慢，建议立即启动）`),
  bullet(T`入口：互联网信息服务算法备案系统 https://beian.cac.gov.cn`),
  bullet(T`以公司为主体备案「深度合成服务提供者」（换脸类功能的法定要求）`),
  bulletRich([run(T`共提交两条算法备案，建议同日提交`, { bold: true }), run(T`：`)]),
  bulletRich([run(T`备案 A：图像视频生成合成算法`, { bold: true }), run(T`（换脸/写真/照片唱歌等全部视觉功能）`)]),
  bulletRich([run(T`备案 B：语音合成算法`, { bold: true }), run(T`（声音克隆/AI 配音）——声音复刻是监管重点，单独备案即使被问询也不拖累 A`)]),
  handover(T`技术材料由开发侧提供（材料包 A、B 两份 Word 文档，第三方备案编号已全部查证填好），公司侧填主体信息、盖章提交，并按文档指引在备案系统检索第三方编号截图附证`),
  bullet(T`配套：《隐私政策》及《人脸信息处理规则》《声纹信息处理规则》开发侧已提供模板（隐私政策模板.docx），公司侧法务确认后发布`),

  h1(T`二、配套办理`),

  h2(T`5. 用户协议与隐私政策`),
  bulletRich([run(T`涉及人脸照片（敏感个人信息），隐私政策需包含人脸信息处理条款并`), run(T`单独取得用户同意`, { bold: true })]),
  handover(T`开发侧提供模板，公司侧法务确认后使用`),

  h2(T`6. 微信支付商户号（如需付费功能，3~5 天）`),
  bullet(T`入口：https://pay.weixin.qq.com，用公司执照申请，结算到公司对公账户`),
  bullet(T`注意：苹果不允许 iOS 小程序内虚拟商品支付，付费方案开发侧会规避`),
  handover(T`商户号 + API 密钥（配置时）`),

  h2(T`7. 云资源归属（建议）`),
  bullet(T`目前 AI 接口（阿里云视觉智能、腾讯云人像变换）用的是开发侧个人账号测试`),
  bulletRich([run(T`建议公司注册`), run(T`自己的阿里云/腾讯云账号`, { bold: true }), run(T`（企业认证），开发侧把配置切过去；或维持现状、定期结算`)]),
  handover(T`如换账号：交接新账号的 AccessKey（开发侧会指导创建子账号，权限最小化）`),

  h1(T`交接汇总（公司办完后给开发侧这些）`),
  makeTable([3200, 3000, 2800], [
    [T`信息`, T`用途`, T`敏感性`],
    [T`小程序 AppID`, T`代码配置`, T`公开信息`],
    [T`开发人员加为小程序项目成员`, T`上传代码、发版`, T`扫码即可，最安全`],
    [T`云开发环境协作者权限`, T`部署服务`, T`扫码即可`],
    [T`（可选）商户号 + API 密钥`, T`付费功能`, T`敏感，线下交接`],
    [T`（可选）公司云账号 AK`, T`AI 接口切换`, T`敏感，线下交接`],
  ]),

  para(
    run(T`时间提示：老板方已确定全功能统一上线（不分批），因此提审需等第 4 项深度合成备案完成（1~3 个月）。等待期间开发侧完成全部功能开发与模板制作，并以「体验版」供内部测试；备案编号下发后即可提审，全量功能一次上线。`, { bold: true, color: "8A4B08" }),
    { spacing: { before: 320 } },
  ),
];

const doc = new Document({
  features: { updateFields: false },
  sections: [
    {
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: {
        default: new Header({
          children: [
            para(run(docTitle, { bold: true, size: 18, color: palette.primary }), {
              alignment: AlignmentType.CENTER,
              spacing: { after: 40 },
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [para(new TextRun({ children: [PageNumber.CURRENT] }), { alignment: AlignmentType.CENTER })],
        }),
      },
      children,
    },
  ],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
console.log("written:", outputPath);
