import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType, Document, Footer, Header, HeadingLevel, Packer, PageNumber,
  Paragraph, TextRun, convertInchesToTwip,
  ShadingType, Table, TableRow, TableCell, WidthType,
} from "docx";

const T = String.raw;
const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node make_xcx_beian_guide.js /absolute/path/output.docx");

const font = { ascii: "Microsoft YaHei", hAnsi: "Microsoft YaHei", cs: "Microsoft YaHei", eastAsia: "Microsoft YaHei" };
const run = (text, options = {}) => new TextRun({ text, font, size: 20, ...options });
const para = (children, options = {}) => new Paragraph({
  spacing: { after: 40, line: 235 },
  ...options,
  children: Array.isArray(children) ? children : [children],
});

const h1 = (text) => para(run(text, { bold: true, size: 22, color: "1F4E79" }), {
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 90, after: 40, line: 235 },
});
const p = (text) => para(run(text));
const bp = (label, text) => para([run(label, { bold: true }), run(text)]);
const step = (n, title, text) => para([
  run(`${n}．${title}　`, { bold: true, color: "2E74B5" }),
  run(text),
]);

const widths = [2200, 5600];
const cell = (children, options = {}) => new TableCell({
  children: Array.isArray(children) ? children : [children],
  margins: { top: 50, bottom: 50, left: 100, right: 100 },
  ...options,
});
const row2 = (k, v) => new TableRow({ children: [
  cell(para(run(k, { bold: true })), { shading: { type: ShadingType.CLEAR, fill: "EEF3F6" }, width: { size: widths[0], type: WidthType.DXA } }),
  cell(para(run(v)), { width: { size: widths[1], type: WidthType.DXA } }),
] });

const doc = new Document({
  features: { updateFields: false },
  sections: [{
    properties: { page: { margin: { top: 800, right: 1000, bottom: 800, left: 1000 } } },
    footers: { default: new Footer({ children: [para(
      new TextRun({ children: [PageNumber.CURRENT], font, size: 18 }),
      { alignment: AlignmentType.CENTER },
    )] }) },
    children: [
      para(run("微信小程序备案 · 一页纸办理指引", { bold: true, size: 30, color: "1F4E79" }), { alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
      para(run("乐颜秀项目 ｜ 2026-08-08 ｜ 与算法备案并行办理，互不等待", { color: "808080", size: 18 }), { alignment: AlignmentType.CENTER, spacing: { after: 160 } }),

      h1("一、为什么要办"),
      p(T`微信平台要求：小程序必须完成备案才能正式发布上线。咱们计划 2026 年 12 月上线，正常 3～20 个工作日可办结，现在办时间充裕；算法备案（网信办）和它互不影响，两条线并行最快。`),

      h1("二、在哪办"),
      p(T`登录微信公众平台 mp.weixin.qq.com → 用小程序账号扫码登录 → 左侧菜单「设置」→「小程序备案」→ 点「去备案」。`),

      h1("三、要准备什么（提前放桌面）"),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: widths,
        rows: [
          row2("营业执照", T`原件拍照或彩色扫描，边角完整、清晰无反光，有效期内` ),
          row2("主体负责人证件", T`法人身份证 + 本人实名手机号（收工信部核验短信，保持畅通）`),
          row2("小程序负责人", T`默认填法人；如不是同一人，需其身份证 + 手机做人脸核验`),
          row2("人脸核验照片", T`办理时现场拍摄：纯白背景、表情自然、不遮挡面部`),
          row2("承诺书等", T`《互联网信息服务承诺书》办理页面在线阅读确认即可，无需提前准备`),
          row2("前置审批", T`咱们是 AI 影像/语音娱乐工具，不属于新闻、出版、医疗等前置审批行业，该栏选「以上都不涉及」`),
        ],
      }),

      h1("四、五步流程"),
      step(1, "填写信息", T`主体信息（对照营业执照填，地址填实际通讯地址）→ 小程序信息（名称、简介、服务类目）→ 负责人信息并人脸核验，然后提交。`),
      step(2, "平台初审（1～2 个工作日）", T`腾讯审核，可能电话核对公司名，法人注意接听来电。结果以站内信通知。`),
      step(3, "工信部短信核验（24 小时内必须完成）", T`初审通过后，负责人手机会收到 12381 发来的核验短信，点链接登录 beian.miit.gov.cn 完成核验。⚠️ 24 小时内没核验会被自动驳回，要重新提交——收到短信当天就办。`),
      step(4, "通管局审核（1～20 个工作日）", T`各省通信管理局终审，一般几天到两周，留意站内信和短信。`),
      step(5, "备案成功", T`下发小程序备案号，自动展示在小程序资料页，无需自己悬挂。备案号也填进算法备案系统的产品信息里。`),

      h1("五、注意事项"),
      bp(T`· 手机畅通：`, T`主体负责人和小程序负责人手机全程保持畅通，腾讯初审电话、12381 短信都靠它。`),
      bp(T`· 信息一致：`, T`公司名称、信用代码与营业执照一字不差，与算法备案系统填的主体信息保持一致（同一套公司信息，两处通用）。`),
      bp(T`· 不用办证：`, T`小程序备案免费，也不需要先办 ICP 经营许可证；咱们现阶段有付费玩法也不影响备案办理。`),
      bp(T`· 办完告诉我：`, T`拿到备案号后发我，我同步更新算法备案材料和后续提审配置。`),
    ],
  }],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
console.log("OK:", outputPath);
