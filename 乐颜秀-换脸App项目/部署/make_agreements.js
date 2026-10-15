import fs from "node:fs";
import {
  AlignmentType, Document, Footer, Packer, PageNumber,
  Paragraph, TextRun, convertInchesToTwip,
} from "docx";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node make_agreements.js /abs/out.docx");

const font = { ascii: "SimSun", hAnsi: "SimSun", cs: "SimSun", eastAsia: "SimSun" };
const run = (text, options = {}) => new TextRun({ text, font, size: 22, ...options });
const para = (children, options = {}) => new Paragraph({
  spacing: { after: 100, line: 320 },
  ...options,
  children: Array.isArray(children) ? children : [children],
});
const title = (text) => para(run(text, { bold: true, size: 30 }), { alignment: AlignmentType.CENTER, spacing: { after: 200 } });
const h = (text) => para(run(text, { bold: true, size: 22 }), { spacing: { before: 140, after: 60 } });
const p = (text) => para(run(text), { indent: { firstLine: convertInchesToTwip(0.31) } });
const pn = (text) => para(run(text));
const pb = (label, text) => para([run(label, { bold: true }), run(text)]);
const pageBreak = () => new Paragraph({ children: [], pageBreakBefore: true });

const vendors = [
  {
    name: "阿里巴巴达摩院（杭州）科技有限公司",
    product: "阿里云视觉智能开放平台",
    algs: "达摩院图像合成算法（备案编号：网信算备330110507206401230027号）",
    scene: "视频换脸、照片换脸（模板合照）、老照片修复增强",
  },
  {
    name: "北京抖音信息服务有限公司",
    product: "火山引擎",
    algs: "火山引擎文本转语音算法（备案编号：网信算备110108823483901230057号）；火山引擎虚拟数字人算法（备案编号：网信算备110108823483901230049号）；豆包大模型图像生成与编辑（火山方舟平台）",
    scene: "AI 配音、本人声音克隆、照片唱歌歌声合成、照片动漫化、照片换背景、AI 写真、视频换脸（备用）",
  },
  {
    name: "深圳市腾讯计算机系统有限公司",
    product: "腾讯云",
    algs: "腾讯云 AI 绘画算法（备案编号：网信算备440305295988701230063号）；腾讯云语音合成算法（备案编号：网信算备440305295988701230039号）",
    scene: "AI 写真（备用）、AI 配音（备用）、照片减龄/变老",
  },
  {
    name: "上海稀宇科技有限公司",
    product: "MiniMax 开放平台",
    algs: "应事视频合成算法-2（备案编号：网信算备310104297296101230049号）",
    scene: "照片动起来（照片动态化）等动态化玩法",
  },
];

function agreement(v, i) {
  return [
    title("技术服务合作协议"),
    pn(),
    pb("甲方（小程序运营主体）：", "REDACTED_COMPANY_NAME"),
    pb("统一社会信用代码：", "REDACTED_COMPANY_REGISTRATION"),
    pn(),
    pb("乙方（技术服务主体）：", v.name),
    pb("乙方平台：", v.product),
    pn(),
    p(`鉴于甲方开发并运营微信小程序「乐颜秀」，乙方为具备相应技术能力与合法资质的技术服务提供方，双方就乙方向甲方提供人工智能生成合成算法技术服务事宜，达成如下协议：`),
    h("一、合作内容"),
    p(`1.1 乙方通过 ${v.product} 向甲方提供以下已履行国家网信部门算法备案的算法技术服务：`),
    p(v.algs + "。"),
    p("1.2 上述算法在甲方产品中的应用场景为：微信小程序「乐颜秀」内的" + v.scene + "等功能。"),
    p("1.3 服务方式：乙方向甲方开放应用程序接口（API），甲方服务端经加密通道调用，乙方按约定标准计费。"),
    h("二、双方权利与义务"),
    p("2.1 乙方保证其提供的算法服务已按《互联网信息服务算法推荐管理规定》《互联网信息服务深度合成管理规定》履行备案手续，备案状态正常有效；备案信息发生变更、注销的，应及时通知甲方。"),
    p("2.2 甲方承诺按照法律法规及乙方平台规则使用技术服务，不将服务用于违法违规用途，并负责其产品内的内容审核、标识与用户管理。"),
    p("2.3 双方各自承担其侧的数据安全与个人信息保护责任；涉及用户数据的传输均采用加密通道，限于当次任务所必需的范围。"),
    h("三、协议期限"),
    p("3.1 本协议自双方盖章之日起生效，有效期一年；期满前双方无异议的，自动续展一年。"),
    h("四、其他"),
    p("4.1 本协议一式两份，甲乙双方各执一份，具有同等法律效力。"),
    p("4.2 未尽事宜，双方友好协商解决。"),
    pn(),
    pn(),
    pb("甲方（盖章）：REDACTED_COMPANY_NAME", ""),
    pb("授权代表（签字）：", ""),
    pb("日期：　　　年　　月　　日", ""),
    pn(),
    pb("乙方（盖章）：" + v.name, ""),
    pb("授权代表（签字）：", ""),
    pb("日期：　　　年　　月　　日", ""),
    ...(i < vendors.length - 1 ? [pageBreak()] : []),
  ];
}

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: 1200, right: 1400, bottom: 1200, left: 1400 } } },
    footers: { default: new Footer({ children: [para(new TextRun({ children: [PageNumber.CURRENT], font, size: 18 }), { alignment: AlignmentType.CENTER })] }) },
    children: [
      para(run("使用说明", { bold: true, size: 26, color: "C00000" }), { alignment: AlignmentType.CENTER }),
      p("本文件含 4 份独立协议（每家技术主体一份，各占一页）。用法：① 按实际使用的厂商打印对应页（4 家都用了就都打）；② 甲方栏盖「REDACTED_COMPANY_NAME」公章、授权代表签字、填日期；③ 联系对应厂商渠道（火山引擎：商务经理/工单；阿里云：控制台工单；腾讯云：控制台工单；MiniMax：开放平台客服）请其加盖乙方鲜章后回传；④ 将盖章完成的协议拍照或扫描（jpg/png，<10MB），上传至微信小程序「添加类目」的「合作协议」资质入口。"),
      pageBreak(),
      ...vendors.flatMap((v, i) => agreement(v, i)),
    ],
  }],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
console.log("OK:", outputPath);
