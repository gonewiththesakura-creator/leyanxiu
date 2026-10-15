import fs from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImportedXmlComponent,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip,
} from "docx";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node make_all_docs.js /abs/path/深度合成备案材料A（图像视频）.docx");
const outDir = path.dirname(outputPath);
fs.mkdirSync(outDir, { recursive: true });
const pathA = outputPath;
const pathB = path.join(outDir, "深度合成备案材料B（语音合成）.docx");
const pathPrivacy = path.join(outDir, "隐私政策模板.docx");

const T = String.raw;
const palette = { dark: "263238", primary: "37474F", light: "78909C", fill: "EEF3F6", quoteFill: "F5F7F8" };
const font = { ascii: "Times New Roman", hAnsi: "Times New Roman", cs: "Times New Roman", eastAsia: "SimSun" };

const run = (text, options = {}) => new TextRun({ text, font, size: 24, ...options });
const para = (children, options = {}) =>
  new Paragraph({
    spacing: { after: 160, line: 300 },
    ...options,
    children: Array.isArray(children) ? children : [children],
  });
const quotePara = (text) =>
  para(run(text), {
    indent: { left: convertInchesToTwip(0.25) },
    shading: { type: ShadingType.CLEAR, fill: palette.quoteFill },
    border: { left: { style: BorderStyle.SINGLE, size: 12, color: palette.light } },
    spacing: { after: 120, line: 300 },
  });
const h1 = (text, opts = {}) =>
  para(run(text, { bold: true, size: 30, color: palette.dark }), {
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    ...opts,
  });
const h2 = (text) =>
  para(run(text, { bold: true, size: 26, color: palette.dark }), {
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
  });
const bulletPara = (text) => para(run(text), { bullet: { level: 0 }, spacing: { after: 80, line: 300 } });
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

const xmlEscape = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const toc = (entries) => {
  const cached = entries
    .map(({ title, level, page }) => {
      const indent = Math.max(0, level - 1) * 360;
      return `<w:p>
        <w:pPr>
          <w:pStyle w:val="TOC${level}"/>
          <w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs>
          <w:ind w:left="${indent}"/>
        </w:pPr>
        <w:r><w:t>${xmlEscape(title)}</w:t></w:r>
        <w:r><w:tab/></w:r>
        <w:r><w:t>${xmlEscape(page)}</w:t></w:r>
      </w:p>`;
    })
    .join("");
  return ImportedXmlComponent.fromXmlString(`<w:sdt xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:sdtPr><w:alias w:val="目录"/></w:sdtPr>
    <w:sdtContent>
      <w:p>
        <w:r>
          <w:fldChar w:fldCharType="begin" w:dirty="true"/>
          <w:instrText xml:space="preserve"> TOC \\o &quot;1-2&quot; \\h \\z \\u </w:instrText>
          <w:fldChar w:fldCharType="separate"/>
        </w:r>
      </w:p>
      ${cached}
      <w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    </w:sdtContent>
  </w:sdt>`).root[0];
};

const makeDoc = (docTitle, children) =>
  new Document({
    features: { updateFields: true },
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

// ================= 备案 A/B 数据 =================
const subjectSection = [
  h1(T`1. 主体信息（公司侧填写）`),
  bulletPara(T`主体名称：【公司全称，与营业执照一致】`),
  bulletPara(T`统一社会信用代码：【执照上的 18 位代码】`),
  bulletPara(T`法定代表人：【姓名】`),
  bulletPara(T`注册地址：【营业执照地址】`),
  bulletPara(T`联系人 / 手机 / 邮箱：【备案联络人】`),
  bulletPara(T`主体证件：营业执照扫描件`),
  bulletPara(T`真实性承诺书：备案系统页面下载模板，盖公章后上传`),
];

const filings = [
  {
    path: pathA,
    docTitle: T`深度合成服务备案 · 填报材料包 A（图像视频生成合成算法）`,
    pairNote: T`本包为 A 备案（图像视频类）；另有 B 备案（语音合成类）材料包，建议同日提交，风险隔离、互不拖累。`,
    algoName: T`乐颜秀人像图像视频生成合成算法`,
    principle: [
      T`本算法应用于图像、视频生成场景，包含三条技术路线：`,
      T`① 人脸融合：用户上传本人人脸照片，经内容安全审核与人脸质量检测后，系统将人脸图像与经审核的预设模板（视频模板、合照模板）进行特征提取与面部融合，生成融合后的图像或视频；`,
      T`② 人脸驱动：以用户本人人脸照片为驱动对象，结合音频或动作参数生成口型同步、表情动作自然的说话、唱歌、动态化视频；`,
      T`③ 风格化生成：以用户本人人脸照片为基础，按选定风格（写真、动漫、艺术绘画、发型、服饰、年龄等）生成风格化人像图像；并支持文本生成图像、图像元素智能消除等图像生成编辑能力。`,
      T`算法本身不自研，编排调用下列已备案第三方深度合成算法（备案编号见下表）。`,
      T`系统对生成结果强制附加「由 AI 生成」显式标识后向用户展示，不提供标识关闭选项。`,
    ],
    modality: T`输入——用户人脸图像（必选）、文本提示与模板/风格/年龄参数（可选）；输出——合成图像、合成视频。`,
    purpose: T`应用于图像、视频生成场景：将用户上传的人脸照片与预设模板进行面部融合，生成融合后的人脸图像、视频；对用户本人照片进行表情驱动与口型同步，生成说话、唱歌、动态化视频；对用户本人照片进行写真、动漫、艺术风格、发型、服饰、年龄等风格化生成；并提供文本生成图像、图像元素智能消除、老照片修复增强、证件照换底排版、图像/视频人像背景替换（场景重绘）等图像视频生成编辑功能。`,
    thirdParty: [
      [T`算法`, T`技术支持者`, T`备案编号（均已查证）`, T`覆盖功能`],
      [T`达摩院人脸融合合成算法`, T`阿里巴巴达摩院（杭州）科技有限公司`, T`网信算备330110507206401230043号（第二批公示清单）`, T`视频/照片换脸（主）`],
      [T`腾讯云人脸融合算法`, T`深圳市腾讯计算机系统有限公司`, T`网信算备440305295988701230013号（腾讯云官方文档公示）`, T`换脸（备）`],
      [T`火山引擎人脸融合算法`, T`北京抖音信息服务有限公司`, T`网信算备110108823483901230073号（第三批公示清单）`, T`换脸（备）`],
      [T`腾讯云 AI 绘画算法`, T`深圳市腾讯计算机系统有限公司`, T`网信算备440305295988701230063号（腾讯云官方文档公示）`, T`写真/动漫化/发型/换装/文生图/智能消除`],
      [T`腾讯数字人视频合成算法`, T`深圳市腾讯计算机系统有限公司`, T`网信算备440305295988701240147号（第四批公示清单）`, T`照片唱歌/说话/口播（主）`],
      [T`火山引擎虚拟数字人算法`, T`北京抖音信息服务有限公司`, T`网信算备110108823483901230049号（第二批公示清单）`, T`人脸驱动（备）`],
      [T`达摩院图像合成算法`, T`阿里巴巴达摩院（杭州）科技有限公司`, T`网信算备330110507206401230027号（阿里云官方文档公示）`, T`老照片修复增强/上色`],
      [T`火山引擎文本转语音算法`, T`北京抖音信息服务有限公司`, T`网信算备110108823483901230057号（第三批公示清单）`, T`照片唱歌预设音色歌声合成`],
      [T`腾讯云人像变换（年龄变化）算法`, T`深圳市腾讯计算机系统有限公司`, T`【提交前按算法名称「人像变换」检索确认编号；若无法确认，减龄/变老改走腾讯云 AI 绘画算法（063号）图像编辑能力】`, T`减龄/变老`],
      [T`火山方舟豆包图像生成与编辑算法（Doubao-Seedream 豆包图像生成模型）`, T`北京抖音信息服务有限公司`, T`【提交前按「豆包大模型」/「图像生成」检索确认编号；火山方舟为字节跳动官方大模型服务平台，所用模型均已通过生成式人工智能服务备案】`, T`动漫化/风格化、照片换背景（场景重绘）、AI 换装（主）`],
    ],
    thirdPartyWidths: [1900, 2100, 3200, 1800],
    thirdPartyNote: T`注：证件照、视频抠像换背景使用人体分割能力，属图像/视频编辑类处理，不涉及生成合成算法来源填报。`,
    features: [
      [T`功能`, T`调用算法`, T`输出标识`],
      [T`视频换脸`, T`达摩院人脸融合（主）/ 腾讯云、火山引擎人脸融合（备）`, T`画面角标「视频由 AI 生成」`],
      [T`照片换脸（模板合照）`, T`达摩院人脸融合（图片）`, T`「图片由 AI 生成」水印（参数强制开启中文水印）`],
      [T`AI 写真（形象照/古装/婚纱/职场等）`, T`腾讯云 AI 绘画算法`, T`「图片由 AI 生成」水印`],
      [T`照片动漫化 / 艺术风格化`, T`火山方舟豆包图像生成与编辑算法（主）/ 腾讯云 AI 绘画算法（备）`, T`「图片由 AI 生成」水印`],
      [T`照片换背景（人像场景重绘）`, T`火山方舟豆包图像生成与编辑算法（主）/ 人体分割 + 本地合成（编辑类，备）`, T`「图片由 AI 生成」水印`],
      [T`百变发型 / AI 换装`, T`腾讯云 AI 绘画算法（模特换装）`, T`「图片由 AI 生成」水印`],
      [T`照片唱歌`, T`腾讯数字人视频合成 + 火山引擎文本转语音（预设音色）`, T`画面角标「视频由 AI 生成」`],
      [T`照片说话 / 数字人口播`, T`腾讯数字人视频合成（备：火山虚拟数字人）`, T`画面角标「视频由 AI 生成」`],
      [T`老照片动起来`, T`腾讯数字人视频合成（备：火山虚拟数字人）`, T`画面角标「视频由 AI 生成」`],
      [T`AI 绘画（文生图）`, T`腾讯云 AI 绘画算法（智能文生图）`, T`「图片由 AI 生成」水印`],
      [T`智能消除（去路人/去杂物）`, T`腾讯云 AI 绘画算法（图像编辑工具）`, T`工具类输出，结果页保留来源说明`],
      [T`老照片修复`, T`达摩院图像合成算法（修复增强/上色）`, T`结果页标注「AI 修复生成」`],
      [T`证件照`, T`人体分割 + 本地规格化合成（编辑类）`, T`工具类输出，结果页保留来源说明`],
      [T`减龄/变老`, T`腾讯云人像变换 / 腾讯云 AI 绘画算法`, T`「AI 生成」角标`],
      [T`视频抠像换背景`, T`视频人体分割 + 本地合成（编辑类）`, T`成片叠加「视频由 AI 生成」角标（上线前由开发侧补齐）`],
    ],
    featureNote: T`注：文本类功能调用已备案大语言模型 API（腾讯混元大模型算法 网信算备440305295988701230071号 / DeepSeek 大语言模型算法 网信算备110108970550101240011号），按《生成式人工智能服务管理暂行办法》走服务登记，不在本备案范围内。`,
    auditQuotes: [
      T`① 机审前置：用户上传的图像、视频及文本输入在生成前调用微信官方内容安全接口（imgSecCheck / mediaCheckAsync / msgSecCheck）进行涉黄、涉政、涉暴恐、违法违规检测，不通过即拒绝生成并提示；`,
      T`② 模板侧控：全部模板与风格由运营方人工审核后预置，用户不可上传模板，生成自由度限于「本人照片 × 官方模板」；`,
      T`③ 结果抽检：运营人员按不低于 5% 比例对生成结果人工抽检；`,
      T`④ 违规处置：命中违规的用户限制使用，情节严重封禁并留存记录；审核日志留存不少于 6 个月。`,
    ],
    markQuotes: [
      T`显式标识：所有生成图像/视频画面显著位置附加「由 AI 生成」文字标识，标识由服务端在生成环节强制添加，用户无法关闭或去除；`,
      T`隐式标识：生成结果文件元数据中写入生成来源信息（厂商接口自带）；`,
      T`提示义务：生成功能入口页展示「本功能由人工智能生成，仅供娱乐，禁止用于冒充他人」提示文案。`,
    ],
    privacyTitle: T`4.4 个人信息与人脸信息保护`,
    privacyQuotes: [
      T`① 人脸照片属敏感个人信息（生物识别信息），上传时弹窗单独取得用户同意（单独勾选《人脸信息处理规则》，不与隐私政策捆绑）；`,
      T`② 最小化收集：仅收集生成所需的一张人脸照片，不收集通讯录、位置等无关信息；`,
      T`③ 存储与删除：用户原始照片在生成完成后 24 小时内自动删除，生成结果保留不超过 30 天，用户可在「我的作品」中随时手动删除；`,
      T`④ 不对外提供：人脸数据不向任何第三方共享、不用于模板训练、不用于其他用途；`,
      T`⑤ 传输与存储全程加密（HTTPS + 对象存储服务端加密）。`,
    ],
    complaintQuotes: [
      T`小程序内设置「投诉举报」入口（我的 → 帮助与反馈），涉肖像权投诉 24 小时内响应、核实后 48 小时内下架相关内容；`,
      T`建立辟谣与澄清机制：发现利用本服务生成内容冒充他人、造谣传谣的，立即停止该用户服务并保留证据上报；`,
      T`安全事件应急预案：接口异常、数据泄露等事件 2 小时内响应，按规定向监管部门报告。`,
    ],
    evalQuotes: [
      T`本服务上线前已开展安全评估：评估范围覆盖信息内容安全（审核机制有效性）、技术安全（接口鉴权、限流、防爬）、数据安全（人脸信息全生命周期保护）、算法滥用风险（仅限本人照片×官方模板，无法合成他人形象）；`,
      T`评估结论：风险可控，具备上线条件。【公司侧盖章确认，如有需要可按属地网信要求提交书面评估报告】`,
    ],
    matrixFull: true,
  },
  {
    path: pathB,
    docTitle: T`深度合成服务备案 · 填报材料包 B（语音合成算法）`,
    pairNote: T`本包为 B 备案（语音合成类）；另有 A 备案（图像视频类）材料包，建议同日提交，风险隔离、互不拖累。`,
    algoName: T`乐颜秀语音合成算法`,
    principle: [
      T`本算法应用于语音生成场景，包含两条技术路线：`,
      T`① 预设音色文本转语音：将用户输入的文本经内容安全审核后，转换为官方预置音色的语音音频；`,
      T`② 本人声音复刻：用户本人按页面提示朗读录制指定验证文本，系统完成活体检测与声纹一致性校验，确认录制者为本人后克隆其音色，用于将该用户的文本转换为本人音色的语音音频；克隆音色仅绑定本人账号使用，不支持导出原始声纹数据，不支持克隆他人声音。`,
      T`算法本身不自研，编排调用下列已备案第三方深度合成算法（备案编号见下表）。`,
      T`系统对生成音频强制附加 AI 生成显式标识（音频开头语音提示 + 文件元数据标识）后向用户展示，不提供标识关闭选项。`,
    ],
    modality: T`输入——文本（必选）、用户本人朗读音频（可选，仅声音复刻场景）；输出——合成语音音频。`,
    purpose: T`应用于语音生成场景，将用户输入的文本合成为预设音色或经本人授权克隆音色的语音音频，用于 AI 配音、本人声音克隆等趣味语音功能；并为小程序内照片唱歌等视频功能提供预设音色歌声合成能力。`,
    thirdParty: [
      [T`算法`, T`技术支持者`, T`备案编号（均已查证）`, T`覆盖功能`],
      [T`火山引擎文本转语音算法`, T`北京抖音信息服务有限公司`, T`网信算备110108823483901230057号（第三批公示清单）`, T`文本转语音、声音复刻（主）`],
      [T`豆包企业版实时语音模型算法`, T`北京抖音信息服务有限公司`, T`网信算备110108823483901250177号（火山引擎官方文档公示）`, T`声音复刻 2.0（如启用，提交前与火山商务确认）`],
      [T`腾讯云语音合成算法`, T`深圳市腾讯计算机系统有限公司`, T`网信算备440305295988701230039号（第一批公示清单）`, T`文本转语音（备）`],
    ],
    thirdPartyWidths: [2200, 2300, 3000, 1500],
    thirdPartyNote: null,
    features: [
      [T`功能`, T`调用算法`, T`输出标识`],
      [T`声音克隆（本人音色）`, T`火山引擎文本转语音算法（声音复刻，本人活体录制校验）`, T`音频开头语音提示「本音频由 AI 生成」+ 元数据标识`],
      [T`AI 配音（预设音色）`, T`火山引擎文本转语音算法（备：腾讯云语音合成算法）`, T`音频开头语音提示 + 元数据标识`],
      [T`照片唱歌歌声合成（预设音色）`, T`火山引擎文本转语音算法`, T`视频成品角标（成品视频在 A 备案覆盖）`],
    ],
    featureNote: null,
    auditQuotes: [
      T`① 机审前置：用户输入的文本在合成前调用微信官方内容安全接口（msgSecCheck）进行涉黄、涉政、涉暴恐、违法违规检测，不通过即拒绝合成并提示；用户上传的音频经安全检测后方可用于声音复刻；`,
      T`② 文案侧控：配音文案长度与用途场景受限（趣味配音、祝福语录等），不提供新闻播报、公告声明等易被误用为权威发布的场景模板；`,
      T`③ 结果抽检：运营人员按不低于 5% 比例对生成音频人工抽检；`,
      T`④ 违规处置：命中违规的用户限制使用，情节严重封禁并留存记录；审核日志留存不少于 6 个月。`,
    ],
    markQuotes: [
      T`显式标识：所有生成音频开头附加「本音频由 AI 生成」语音提示，下载页面与播放页面同步展示文字标识，标识由服务端在生成环节强制添加，用户无法关闭或去除；`,
      T`隐式标识：生成音频文件元数据中写入生成来源信息；`,
      T`提示义务：功能入口页展示「本功能由人工智能生成，声音克隆仅限本人使用，禁止用于冒充他人」提示文案。`,
    ],
    privacyTitle: T`4.4 个人信息与声纹信息保护（本备案重点）`,
    privacyQuotes: [
      T`① 声纹属敏感个人信息（生物识别信息）：声音复刻前弹窗单独取得用户同意（单独勾选《声纹信息处理规则》，不与隐私政策捆绑）；`,
      T`② 防冒用三重校验：仅支持克隆本人声音——用户须朗读系统随机生成的指定验证文本，系统完成活体检测 + 声纹一致性校验 + 本人声明确认后方可克隆；无法上传现成音频文件克隆他人声音；`,
      T`③ 最小化收集：仅收集克隆所需的验证文本录音，不收集通讯录、位置等无关信息；`,
      T`④ 存储与删除：原始录音在音色克隆完成后 24 小时内自动删除；克隆音色仅绑定本人账号，用户可随时在「我的」中删除音色，删除后不可恢复；`,
      T`⑤ 不对外提供：声纹数据与克隆音色不向任何第三方共享、不用于模型训练、不用于其他用途；`,
      T`⑥ 传输与存储全程加密（HTTPS + 对象存储服务端加密）。`,
    ],
    complaintQuotes: [
      T`小程序内设置「投诉举报」入口（我的 → 帮助与反馈），涉声音权益投诉 24 小时内响应、核实后 48 小时内下架相关内容并删除涉事音色；`,
      T`发现利用本服务合成音频冒充他人、造谣传谣、实施诈骗的，立即停止该用户服务，保留证据并按规定上报；`,
      T`安全事件应急预案：接口异常、数据泄露等事件 2 小时内响应，按规定向监管部门报告。`,
    ],
    evalQuotes: [
      T`本服务上线前已开展安全评估：评估范围覆盖信息内容安全（审核机制有效性）、技术安全（接口鉴权、限流、防爬）、数据安全（声纹信息全生命周期保护）、算法滥用风险（声音复刻需本人活体朗读验证文本，无法克隆他人声音；合成音频强制 AI 标识，无法去除）；`,
      T`评估结论：风险可控，具备上线条件。【公司侧盖章确认，如有需要可按属地网信要求提交书面评估报告】`,
    ],
    matrixFull: false,
  },
];

function buildFiling(f) {
  const tocEntries = [
    { title: T`0. 填报总览`, level: 1, page: 2 },
    { title: T`1. 主体信息（公司侧填写）`, level: 1, page: 2 },
    { title: T`2. 算法信息（复制粘贴区）`, level: 1, page: 3 },
    { title: T`3. 功能与算法映射`, level: 1, page: 5 },
    { title: T`4. 安全管理机制`, level: 1, page: 6 },
    { title: T`4.1 内容安全审核机制`, level: 2, page: 6 },
    { title: T`4.2 标识方案`, level: 2, page: 6 },
    { title: T`4.3 用户实名与权限`, level: 2, page: 6 },
    { title: f.privacyTitle.replace(/^4\.4 /, "4.4 "), level: 2, page: 7 },
    { title: T`4.5 投诉举报与应急处置`, level: 2, page: 7 },
    { title: T`4.6 安全评估说明`, level: 2, page: 7 },
    { title: T`5. 备案系统操作步骤（公司侧）`, level: 1, page: 8 },
    { title: T`6. 公司侧 vs 开发侧分工`, level: 1, page: 8 },
    { title: f.matrixFull ? T`7. 矩阵运营（多产品）备案策略` : T`7. 矩阵运营（多产品）说明`, level: 1, page: 9 },
  ];

  const children = [
    // 封面
    para(run(f.docTitle, { bold: true, size: 40, color: palette.dark }), {
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 2200, after: 480 },
    }),
    para(run(T`产品：乐颜秀（微信小程序）`, { size: 28, color: palette.primary }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    para(run(T`填报系统：https://beian.cac.gov.cn`, { size: 24, color: palette.light }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    para(run(f.pairNote, { size: 20, color: "8A4B08" }), { alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    para(run(T`依据：《互联网信息服务深度合成管理规定》《互联网信息服务算法推荐管理规定》《人工智能生成合成内容标识办法》`, { size: 20, color: palette.light }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    para(run(T`用法：公司侧登录备案系统，按本文档复制粘贴填报；【】内为公司侧需补充的信息。第三方算法备案编号均已逐一查证，提交前在备案系统按编号检索截图附证即可。`, { size: 20, color: palette.light }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    // 目录
    para(run(T`目录`, { bold: true, size: 30, color: palette.dark }), {
      alignment: AlignmentType.CENTER,
      pageBreakBefore: true,
      spacing: { before: 240, after: 200 },
    }),
    para(run(T`在 Word 中右键目录选择"更新域"可刷新页码。`, { italics: true, size: 20, color: palette.light })),
    toc(tocEntries),
    // 0 总览
    para(run(T`0. 填报总览`, { bold: true, size: 30, color: palette.dark }), {
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { before: 320, after: 160 },
    }),
    makeTable([2200, 6800], [
      [T`项`, T`填什么`],
      [T`算法类型`, T`生成合成（深度合成）`],
      [T`填报角色`, T`服务提供者（我们是小程序运营方；技术支持者均已各自备案）`],
      [T`审核流程`, T`省级网信办初审（5~10 工作日）→ 国家网信办复审（1~2 个月）→ 公示（约 7 个工作日）→ 发备案编号`],
      [T`总周期`, T`材料一次过约 2~3 个月；每次补正重新排队 +1~4 周，建议一次填全`],
      [T`备案后义务`, T`小程序「关于」页公示备案编号 + 备案系统公示链接`],
    ]),
    // 1 主体
    ...subjectSection,
    // 2 算法信息
    h1(T`2. 算法信息（复制粘贴区）`),
    para([run(T`算法名称：`, { bold: true }), run(f.algoName)]),
    para([run(T`算法类型：`, { bold: true }), run(T`生成合成（深度合成）`)]),
    para([run(T`填报角色：`, { bold: true }), run(T`服务提供者`)]),
    para([run(T`应用产品：`, { bold: true }), run(T`乐颜秀（微信小程序）`)]),
    para(run(T`算法基本原理（技术路线描述）：`, { bold: true })),
    ...f.principle.map(quotePara),
    para([run(T`输入输出模态：`, { bold: true }), run(f.modality)]),
    para(run(T`主要用途（仿公示清单句式）：`, { bold: true })),
    quotePara(f.purpose),
    para(run(T`第三方算法备案编号（备案系统「算法来源」处填写）：`, { bold: true })),
    makeTable(f.thirdPartyWidths, f.thirdParty),
    ...(f.thirdPartyNote
      ? [para(run(f.thirdPartyNote, { size: 20, color: palette.light }), { spacing: { before: 120 } })]
      : []),
    // 3 功能映射
    h1(T`3. 功能与算法映射（填「功能说明」附件用）`),
    makeTable([2400, 3400, 3200], f.features),
    ...(f.featureNote
      ? [para(run(f.featureNote, { size: 20, color: palette.light }), { spacing: { before: 120 } })]
      : []),
    // 4 安全机制
    h1(T`4. 安全管理机制（备案系统「安全保障措施」逐条对应）`),
    h2(T`4.1 内容安全审核机制`),
    ...f.auditQuotes.map(quotePara),
    h2(T`4.2 标识方案（对应《标识办法》）`),
    ...f.markQuotes.map(quotePara),
    h2(T`4.3 用户实名与权限`),
    quotePara(T`用户须授权微信绑定手机号后方可使用生成功能（微信手机号已完成运营商实名认证）；未授权用户仅可浏览模板。`),
    quotePara(T`按《深度合成管理规定》第十四条，对用户真实身份信息进行认证日志留存。`),
    h2(f.privacyTitle),
    ...f.privacyQuotes.map(quotePara),
    h2(T`4.5 投诉举报与应急处置`),
    ...f.complaintQuotes.map(quotePara),
    h2(T`4.6 安全评估说明（对应规定第二十条 / 第十一条）`),
    ...f.evalQuotes.map(quotePara),
    // 5 操作步骤
    h1(T`5. 备案系统操作步骤（公司侧）`),
    ...[
      T`注册登录 https://beian.cac.gov.cn（企业账号，需法人或负责人人脸核验）`,
      T`「备案信息填报 → 算法备案」→ 类型选「生成合成（深度合成）」→ 角色选「服务提供者」`,
      T`按本文档第 1~4 节逐项填写，承诺书/公函类模板在系统页面下载、盖章、扫描上传`,
      T`第 2 节第三方备案编号：在备案系统搜索栏选「备案编号」逐个检索，截图附证`,
      T`提交 → 省网信办初审（被退回就按意见补正重提）`,
      T`国家网信办复审 → 公示 → 获得备案编号（格式：网信算备XXXXXXXXXXXXXXX号）`,
      T`把编号发给开发侧，配置到小程序「关于」页公示（附备案系统查询链接）`,
    ].map((s, i) =>
      para([run(`${i + 1}. `, { bold: true }), run(s)], {
        indent: { left: convertInchesToTwip(0.25) },
        spacing: { after: 100, line: 300 },
      }),
    ),
    // 6 分工
    h1(T`6. 公司侧 vs 开发侧分工`),
    makeTable([3800, 2400, 2800], [
      [T`事项`, T`公司侧`, T`开发侧`],
      [T`主体信息、承诺书盖章、系统填报`, T`✔ 负责`, T`提供本文档`],
      [T`第三方算法备案编号检索截图`, T`✔ 检索截图`, T`编号已全部查证填好，提供检索指引`],
      [T`内容审核机制、标识、实名、隐私制度`, T`确认执行`, T`✔ 已实现/上线前实现`],
      [T`备案编号公示`, T`—`, T`✔ 配置到小程序`],
    ]),
  ];

  // 7 矩阵
  if (f.matrixFull) {
    children.push(
      h1(T`7. 矩阵运营（多产品）备案策略`),
      quotePara(T`同一主体下运营多个小程序/App（矩阵号）：备案系统「应用产品」栏可逐个添加多个产品，备案编号全矩阵共用，无需重复备案；备案主体必须与小程序注册主体一致（微信提审时核对），矩阵号统一注册在本公司名下；每个小程序各自完成微信小程序备案及类目提审，提审时出示共用的算法备案编号。`),
      makeTable([2600, 2200, 2800, 1400], [
        [T`产品名称`, T`类型`, T`AppID / 包名`, T`状态`],
        [T`乐颜秀`, T`微信小程序`, T`【小程序 AppID】`, T`首发`],
        [T`【矩阵产品 2 名称】`, T`微信小程序`, T`【AppID】`, T`规划中`],
        [T`【矩阵产品 3 名称】`, T`微信小程序`, T`【AppID】`, T`规划中`],
      ]),
      para(run(T`注：AppID 需先在微信公众平台注册小程序后获得（仅需注册，无需完成开发）。建议提交备案前把矩阵规划的小程序全部注册取得 AppID，一次挂满；后续新增产品走变更备案（预留 2~4 周）。`, { size: 20, color: palette.light }), {
        spacing: { before: 160 },
      }),
    );
  } else {
    children.push(
      h1(T`7. 矩阵运营（多产品）说明`),
      quotePara(T`与 A 备案相同：同一主体下多个小程序/App 在「应用产品」栏逐个添加，备案编号全矩阵共用；备案主体须与小程序注册主体一致。建议与 A 备案保持产品清单一致、同日提交。`),
    );
  }

  children.push(
    para(
      run(T`提醒：规定要求「提供服务之日起十个工作日内」完成备案，但微信小程序提审时即要求出示备案编号，实际是先备案后上线。本文档已按一次通过准备，建议尽快提交。`, { bold: true, color: "8A4B08" }),
      { spacing: { before: 240 } },
    ),
  );

  return makeDoc(f.docTitle, children);
}

// ================= 隐私政策 =================
function buildPrivacy() {
  const docTitle = T`乐颜秀隐私政策（模板）`;
  const children = [
    para(run(docTitle, { bold: true, size: 40, color: palette.dark }), {
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 360 },
    }),
    para(run(T`使用说明：本模板与《深度合成备案材料》口径一致，【】内由公司侧补充后发布。发布位置：小程序「我的 → 设置 → 隐私政策」全文展示；微信小程序后台「用户隐私保护指引」按第 1 条勾选填写。附件一/二在对应功能首次使用时单独弹窗取得同意。`, { size: 20, color: palette.light }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    para(run(T`更新日期：【2026 年  月  日】｜生效日期：【2026 年  月  日】`, { size: 20, color: palette.light }), {
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
    }),
    para(
      run(T`【公司全称】（以下简称"我们"）是微信小程序"乐颜秀"的运营者。我们深知个人信息的重要性，将按照《中华人民共和国个人信息保护法》《中华人民共和国网络安全法》《互联网信息服务深度合成管理规定》等法律法规要求保护您的个人信息。请您在使用本小程序前仔细阅读本政策。`),
      { indent: { firstLine: convertInchesToTwip(0.33) } },
    ),
    h1(T`1. 我们收集的信息及用途（最小化原则）`),
    makeTable([2000, 2600, 2600, 1800], [
      [T`场景`, T`收集的信息`, T`用途`, T`是否必须`],
      [T`登录`, T`微信头像、昵称、openid`, T`账号标识`, T`必须`],
      [T`实名认证`, T`微信绑定手机号`, T`按法规要求完成生成类功能实名认证`, T`使用生成功能时必须`],
      [T`换脸/写真/修复等图像功能`, T`您主动上传的 1 张人脸照片`, T`生成合成图像/视频`, T`使用对应功能时必须`],
      [T`视频功能`, T`您主动上传的视频`, T`视频换脸、抠像换背景`, T`使用对应功能时必须`],
      [T`声音克隆`, T`您本人朗读指定验证文本的录音`, T`活体校验与音色克隆`, T`使用声音克隆时必须`],
      [T`配音功能`, T`您输入的文本`, T`语音合成`, T`使用对应功能时必须`],
      [T`客服与投诉`, T`您主动提供的联系方式与反馈内容`, T`处理投诉举报`, T`自愿`],
    ]),
    para([run(T`我们不会收集：`, { bold: true }), run(T`通讯录、精确位置、相册批量照片、剪切板等与本服务无关的信息。`)]),
    h1(T`2. 敏感个人信息特别说明`),
    para(run(T`人脸照片、声纹属于敏感个人信息（生物识别信息）。我们仅在您使用对应功能、单独勾选同意《人脸信息处理规则》《声纹信息处理规则》后收集，且：`), { indent: { firstLine: convertInchesToTwip(0.33) } }),
    bulletPara(T`仅用于您当前发起的生成任务，不用于身份识别之外的用途；`),
    bulletPara(T`不用于任何模型训练，不向任何第三方共享、转让、公开披露；`),
    bulletPara(T`原始照片/录音在生成完成后 24 小时内自动删除；生成结果保留不超过 30 天，您可随时在「我的作品」中手动删除；`),
    bulletPara(T`克隆音色仅绑定您本人账号，可随时删除，删除后不可恢复。`),
    h1(T`3. 第三方服务说明`),
    para(run(T`本服务的 AI 生成能力由下列持牌第三方提供接口支持。您的照片/文本仅作为接口入参实时处理，处理后不留存于第三方（依据各厂商服务协议）：`), { indent: { firstLine: convertInchesToTwip(0.33) } }),
    bulletPara(T`阿里云视觉智能开放平台（人脸融合、图像增强、分割）`),
    bulletPara(T`腾讯云（人脸融合、AI 绘画、数字人、语音合成、人像变换）`),
    bulletPara(T`火山引擎（文本转语音、人脸融合、虚拟数字人、火山方舟豆包图像生成与编辑）`),
    bulletPara(T`大语言模型服务（腾讯混元 / DeepSeek，用于文本类功能）`),
    bulletPara(T`微信官方内容安全接口（上传内容的违法违规检测）`),
    h1(T`4. 信息的存储与保护`),
    bulletPara(T`存储地点：中华人民共和国境内（腾讯云/阿里云对象存储）；`),
    bulletPara(T`保护措施：HTTPS 传输加密、服务端存储加密、访问权限最小化控制；`),
    bulletPara(T`保存期限：见第 2 条；账号注销后，我们将在 15 个工作日内删除您的全部个人信息。`),
    h1(T`5. 您的权利`),
    bulletPara(T`查询/复制：在「我的 → 个人信息」中查询您的信息；`),
    bulletPara(T`删除：随时删除「我的作品」、克隆音色；`),
    bulletPara(T`撤回同意：在「我的 → 设置 → 授权管理」中撤回人脸/声纹处理同意（撤回后对应功能不可用）；`),
    bulletPara(T`注销账号：「我的 → 设置 → 注销账号」，注销后信息全部删除；`),
    bulletPara(T`投诉举报：「我的 → 帮助与反馈」，涉肖像权/声音权益投诉 24 小时内响应。`),
    h1(T`6. 未成年人保护`),
    para(run(T`本服务不面向未满 14 周岁的未成年人。若您为 14~18 周岁的未成年人，请在监护人陪同下阅读本政策并取得监护人同意后使用。`), { indent: { firstLine: convertInchesToTwip(0.33) } }),
    h1(T`7. 政策的更新`),
    para(run(T`本政策更新时，我们将在小程序内公告并以弹窗方式提示您。涉及敏感个人信息处理的重大变更，将重新取得您的同意。`), { indent: { firstLine: convertInchesToTwip(0.33) } }),
    h1(T`8. 联系我们`),
    bulletPara(T`个人信息保护负责人：【姓名/部门】`),
    bulletPara(T`联系邮箱：【邮箱】｜联系电话：【电话】`),
    bulletPara(T`注册地址：【公司注册地址】`),
    // 附件一
    para(run(T`附件一：人脸信息处理规则（单独同意弹窗文本）`, { bold: true, size: 30, color: palette.dark }), {
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      spacing: { before: 320, after: 160 },
    }),
    para(run(T`在您首次使用换脸、写真、修复等涉及人脸照片的功能时，本规则以单独弹窗展示，须您主动勾选"同意"后方可继续，不与隐私政策捆绑。`, { italics: true, size: 20, color: palette.light })),
    ...[
      T`1. 我们收集的信息：您主动上传的 1 张人脸照片（人脸信息属敏感个人信息）。`,
      T`2. 使用目的：仅用于您本次发起的图像/视频生成任务。`,
      T`3. 处理方式：传输至持牌第三方算法接口（阿里云/腾讯云/火山引擎）实时处理。`,
      T`4. 保存期限：原始照片在生成完成后 24 小时内自动删除；生成结果保留不超过 30 天，可随时手动删除。`,
      T`5. 我们承诺：不将您的人脸信息用于模型训练；不向任何第三方共享；不用于本规则约定外的任何用途。`,
      T`6. 您的权利：可随时在「我的 → 设置 → 授权管理」撤回同意；撤回后相关功能不可用，已收集信息将删除。`,
      T`7. 请您确认：上传的照片为您本人或已取得本人合法授权。禁止上传他人照片冒充他人。`,
    ].map((s) => para(run(s), { spacing: { after: 100, line: 300 } })),
    // 附件二
    h1(T`附件二：声纹信息处理规则（单独同意弹窗文本）`),
    para(run(T`在您首次使用声音克隆功能时，本规则以单独弹窗展示，须您主动勾选"同意"后方可继续。`, { italics: true, size: 20, color: palette.light })),
    ...[
      T`1. 我们收集的信息：您本人按页面提示朗读指定验证文本的录音（声纹属敏感个人信息）。`,
      T`2. 使用目的：仅用于验证录制者为您本人，并克隆您的音色用于语音合成功能。`,
      T`3. 防冒用机制：仅支持克隆您本人的声音——须朗读系统随机生成的验证文本，通过活体检测与声纹一致性校验后方可克隆；无法上传他人音频进行克隆。`,
      T`4. 保存期限：原始录音在音色克隆完成后 24 小时内自动删除；克隆音色仅绑定您本人账号，您可随时删除，删除后不可恢复。`,
      T`5. 我们承诺：不将您的声纹信息用于模型训练；不向任何第三方共享；克隆音色不支持导出。`,
      T`6. 您的权利：可随时在「我的 → 设置 → 授权管理」撤回同意。`,
      T`7. 请您确认：克隆的声音为您本人的声音。利用合成音频冒充他人、实施诈骗将承担法律责任，我们将保留证据并上报。`,
    ].map((s) => para(run(s), { spacing: { after: 100, line: 300 } })),
  ];
  return makeDoc(docTitle, children);
}

// ================= 生成 =================
for (const f of filings) {
  const doc = buildFiling(f);
  fs.writeFileSync(f.path, await Packer.toBuffer(doc));
  console.log("written:", f.path);
}
fs.writeFileSync(pathPrivacy, await Packer.toBuffer(buildPrivacy()));
console.log("written:", pathPrivacy);
