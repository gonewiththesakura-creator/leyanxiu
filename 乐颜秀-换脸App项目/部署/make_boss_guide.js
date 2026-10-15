import fs from "node:fs";
import {
  AlignmentType, Document, Footer, Packer, PageNumber,
  Paragraph, TextRun, convertInchesToTwip,
  ShadingType, Table, TableRow, TableCell, WidthType,
} from "docx";

const T = String.raw;
const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node make_boss_guide.js /abs/out.docx");

const font = { ascii: "Microsoft YaHei", hAnsi: "Microsoft YaHei", cs: "Microsoft YaHei", eastAsia: "Microsoft YaHei" };
const run = (text, options = {}) => new TextRun({ text, font, size: 21, ...options });
const para = (children, options = {}) => new Paragraph({
  spacing: { after: 80, line: 270 },
  ...options,
  children: Array.isArray(children) ? children : [children],
});
const h1 = (text) => para(run(text, { bold: true, size: 26, color: "1F4E79" }), { spacing: { before: 260, after: 120, line: 300 } });
const h2 = (text) => para(run(text, { bold: true, size: 22, color: "2E74B5" }), { spacing: { before: 160, after: 80 } });
const p = (text) => para(run(text));
const step = (n, text) => para([run(`${n}．`, { bold: true, color: "2E74B5" }), run(text)]);
const warn = (text) => para(run(text, { bold: true, color: "C00000" }));
const gray = (text) => para(run(text, { color: "808080", size: 19 }));

const widths = [3000, 4800];
const cell = (children, options = {}) => new TableCell({
  children: Array.isArray(children) ? children : [children],
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  ...options,
});
const row2 = (k, v, fill = "EEF3F6") => new TableRow({ children: [
  cell(para(run(k, { bold: true })), { shading: { type: ShadingType.CLEAR, fill }, width: { size: widths[0], type: WidthType.DXA } }),
  cell(para(run(v)), { width: { size: widths[1], type: WidthType.DXA } }),
] });
const tbl = (rows) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: widths, rows });

const doc = new Document({
  sections: [{
    properties: { page: { margin: { top: 1000, right: 1100, bottom: 1000, left: 1100 } } },
    footers: { default: new Footer({ children: [para(new TextRun({ children: [PageNumber.CURRENT], font, size: 18 }), { alignment: AlignmentType.CENTER })] }) },
    children: [
      para(run("乐颜秀备案冲刺 · 老板操作手册", { bold: true, size: 32, color: "1F4E79" }), { alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
      gray(T`2026-08-09 整理 ｜ 不懂技术也能照着做，每一步都写了点哪里、填什么。有拿不准的随时问，别硬猜。`),

      h1("〇、先看全局：现在到哪了，还差什么"),
      p(T`咱们的目标是让「乐颜秀」小程序合法上线。一共三条线，进度如下：`),
      tbl([
        row2("① 算法备案（网信办）", T`A（图像视频）、B（语音）两条草稿已全部填好存草稿箱 ✅。就差：主体审核通过 + 一个备案号 + 签名`),
        row2("② 小程序备案（微信/工信部）", T`还没提交 ❌ —— 这是最急的一件事，办下来才有"京ICP备…"备案号，①③都等它`),
        row2("③ 小程序类目资质（微信）", T`材料已备齐：6 张厂商备案证明截图（在"技术主体备案证明"文件夹）+ 4 份合作协议模板。打印盖章后就能传`),
      ]),
      p(T`推荐顺序：先办②（等待期最长），等待期间办③和签名，②一出号，①立刻提交。`),

      h1("一、第一件事：提交小程序备案（最急，今天就办）"),
      p(T`在哪办：电脑打开 mp.weixin.qq.com → 扫码登录小程序后台 → 左侧菜单「设置」→「小程序备案」→ 点「去备案」。`),
      h2("手边先备好这些东西"),
      step(1, T`营业执照：原件拍照（四角完整、清晰、不反光），存在电脑上`),
      step(2, T`法人身份证：正反面拍照`),
      step(3, T`法人本人手机：全程带在身上，要接电话、收短信`),
      h2("照着填"),
      step(1, T`主体信息：公司名称、信用代码照营业执照抄（REDACTED_COMPANY_NAME / REDACTED_COMPANY_REGISTRATION），地址填实际办公地址`),
      step(2, T`主体负责人：填法人，手机保持畅通`),
      step(3, T`小程序信息：名称「乐颜秀」，简介写"AI 照片视频特效与趣味语音工具"，类目按实际业务选`),
      step(4, T`小程序负责人：默认法人就行；如果填别人，要那个人做人脸核验（纯白背景、别挡脸）`),
      step(5, T`前置审批：咱们不涉及新闻/出版/医疗等特殊行业，选「以上都不涉及」`),
      step(6, T`提交，等腾讯初审（1～2 个工作日）。腾讯可能给法人打电话核实公司名，一定接`),
      warn(T`⚠️ 最关键一步：初审过后，法人手机会收到 12381 发来的核验短信，24 小时内必须点短信里的链接完成核验（打开 beian.miit.gov.cn，填手机号+验证码+身份证后六位）。超时会被驳回，得重新提交！收到当天就点。`),
      step(7, T`短信核验完，等省通信管理局终审（1～20 个工作日，一般几天到两周）。通过后下发备案号，格式类似：京ICP备XXXXXXXX号-X。把这个号发我。`),

      h1("二、第二件事：打印盖章（等备案号期间办）"),
      h2("第 1 样：6 张厂商备案证明截图"),
      step(1, T`打开"技术主体备案证明"文件夹，把 01、02、03、04、05、07 这 6 张图各打印 1 份（06 那张不要打，已注销作废）`),
      step(2, T`每张右上角盖公司公章（章要清晰、别压住编号）`),
      step(3, T`用手机把盖好的每张拍照（正对、不歪、不反光），存电脑备用`),
      h2("第 2 样：4 份合作协议"),
      step(1, T`打开"技术服务合作协议模板（4家厂商）.docx"，里面 4 份协议各占一页，4 家都打印`),
      step(2, T`每份甲方处盖公章、授权代表签字、填日期`),
      step(3, T`分别找 4 家厂商盖乙方章：火山引擎找商务经理（没对接人就官网提工单）；阿里云/腾讯云在控制台提工单；MiniMax 找开放平台客服。就说"小程序上架需要合作协议盖章"，他们都熟`),
      warn(T`⚠️ 厂商盖章一般要几天到两周，和第一件事并行去办，别等。`),
      step(4, T`盖好章的协议同样拍照存电脑`),

      h1("三、第三件事：把盖章件传到微信「添加类目」"),
      step(1, T`回到小程序后台 →「设置」→「服务类目」→ 添加类目（深度合成/AI 相关类目）`),
      step(2, T`第一个「资质文件」入口：传 6 张盖好章的备案证明截图（可多张拼图，单张 <10MB）`),
      step(3, T`有效期：选「长期有效」`),
      step(4, T`第二个「资质文件」入口：传盖好章的合作协议（几份拼图也行）`),
      step(5, T`点确定提交，等微信审核（一般 1～7 个工作日）`),

      h1("四、第四件事：报告末页签名"),
      step(1, T`打开"算法安全自评估报告（备案提交版）.pdf"和"算法安全自评估报告B（语音合成·备案提交版）.pdf"，各打印最后一页（有"评估结论"那页）`),
      step(2, T`在"（签名）"处手写负责人签名，签法人或算法安全负责人`),
      step(3, T`签完拍照发我，我重出带签名的正式版替换上传。签完前不点最终提交`),

      h1("五、第五件事：备案号一到，10 分钟提交算法备案（照抄）"),
      p(T`备案号（京ICP备…号-X）下来后，登录 beian.cac.gov.cn（手机号 REDACTED_PHONE 扫码/账号密码），照下面做。A、B 两条各做一遍，内容一样。`),
      step(1, T`右上角账号菜单 →「草稿箱」→ 点草稿右边的「编辑」→「前往填写备案信息」`),
      step(2, T`第 1 步页面：确认两份附件还在（a-report.pdf、a-gongshi.pdf 或 b- 开头）。如果我把签名版发你了，点「上传文件」换成签名版`),
      step(3, T`一路「下一步」到第 3 步「填写产品及功能信息」→ 点「添加产品」：`),
      tbl([
        row2("产品名称", "乐颜秀"),
        row2("产品类型", "小程序"),
        row2("前置许可", T`类型选「电信与信息服务业务经营许可证（ICP）」，编号填小程序备案号（京ICP备XXXXXXXX号-X，一个字母都别错）`),
        row2("用户总量/日活/月活/增长量/在线时长", T`未上线，全部填 0`),
      ]),
      step(4, T`保存后勾选刚添加的产品 → 下一步 →「确认提交」。看到"提交成功"就完事`),
      step(5, T`B（语音）草稿：同样步骤再来一遍（附件是 b- 开头两个）`),
      warn(T`⚠️ 提交前一定确认：① 主体信息已"审核通过"（首页"主体信息"里看状态）② 附件是签名版 ③ 备案号没抄错。`),

      h1("六、如果被打回怎么办"),
      step(1, T`别慌，打回会写明原因，截图发我，我改完你重新传`),
      step(2, T`备案系统官方咨询：电话 (010)82990520 / (010)82990521（工作日 9:00-17:00），邮箱 pingguchu@cac.gov.cn`),
      step(3, T`微信平台问题：小程序后台右下角"客服"直接问`),

      h1("附：材料文件都在哪"),
      tbl([
        row2("6 张备案证明截图", "乐颜秀-换脸App项目/部署/技术主体备案证明/（01-05、07.jpg）"),
        row2("合作协议模板", "乐颜秀-换脸App项目/部署/技术服务合作协议模板（4家厂商）.docx"),
        row2("要签名的两份报告", "部署/算法安全自评估报告（备案提交版）.pdf、算法安全自评估报告B（语音合成·备案提交版）.pdf"),
        row2("小程序备案指引（更细版）", "部署/微信小程序备案办理指引（一页纸）.pdf"),
      ]),
    ],
  }],
});

fs.writeFileSync(outputPath, await Packer.toBuffer(doc));
console.log("OK:", outputPath);
