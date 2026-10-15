# 2026-10-11 新固定型号真实交付验收

## 已确认的结果

用户单独授权后执行 `synthetic-generation-v4`，固定型号 `qwen-image-2.0-2026-03-03`。实际一次生成、输入输出各一次图片审核。生成回执、成品下载、中文可见标识及 XMP、私有存储写入与真实字节回读、最终图片审核全部通过。本次成品及两个审核临时对象已观察为不存在，`cleanupPending:false`。未使用用户照片、未创建或扣款微信订单。

图片已实际查看：1024×1024 蓝色渐变，无人物，底部可读“AI编辑”及内容编号。预览保存在 `evidence/mini-photo-synthetic-generation-v4.png`。真实验收报告为 `evidence/mini-photo-synthetic-generation-v4.json`，与独占日志最终报告逐字段一致；原始日志留在受保护的 `data/photo-generation-synthetic-generation-v4/intent.jsonl`，不得删除后重跑。

## 更换型号的依据

10-11 使用现有凭据对官方模型目录执行只读 GET：旧固定型号的精确查询返回 HTTP 200、success=true、total=0；两个北京端点的模糊型号列表均不含旧型号。新固定型号精确查询 total=1，支持 Text/Image 输入、Image 输出，目录价格 0.20 元/张。详见 `evidence/mini-photo-model-catalog-2026-10-11.json`。

这证明旧型号在本次目录查询中不可见，不证明它全球下线，也不倒推三个旧请求的唯一失败原因。旧 v1/v2/v3 记录、旧制品保留原型号，不当作新型号验收。

## 调用与费用边界

限定授权已全部使用：至多 1 次生成、2 次审核，异常不重试。模型和基础审核估算合计 0.203 元，另有 OSS 请求/流量等；最终供应商账单尚未核实。v1/v2/v3 的旧 CLI 执行入口已退役，v4 独占日志禁止重复执行。不得把新的版本号当作新的计费授权。

## 仍未被这次测试证明的事项

- `deployed:false`、`productionApproved:false`：未部署图片候选、未开放正式购买、未提交或发布小程序。
- 无人像合成图证明链路通畅，不证明任何人像效果质量或人脸素材授权。
- 对象不存在是本次观察；不宣称供应商、版本历史或备份永久擦除。
- Windows 上实际 Pillow 与 HTTPS 通过，不代替 Linux 容器字体、依赖安装和启动验证。
- 本地独立 MySQL 的十表迁移、最小权限与备份恢复通过，不代替云端正式账本初始化和恢复能力。

## 本地验收补充

同日后续：云端正式逻辑库已独立初始化并完成 env=0 绑定，新连接完整复核通过；见 `mini-production-database-2026-10-11.md`。正式服务构建上下文已打包，见 `mini-photo-production-package-2026-10-11.md`。这两项后续工作没有再次调用计费生成或审核，不改变本次报告中的未部署、未正式验收边界。

新型号拒绝旧型号请求/回执/验收报告；v4 验证必须绑定三个历史型号与唯一意图，不能重写旧报告。十二套当前适配器、生成、应用、候选宿主/公开接口、构建和原生客户端测试合计 236/236 通过（覆盖集内一次运行，不与历史分组重复累加）。独立 MySQL 8.0.46 schema/权限/备份恢复验收 4/4 另记于 `mini-photo-candidate-schema-acceptance-2026-10-11.md`。

公开资料从永久 pending 改为既有真实配置的严格投影；不公开内部评估引用。能力与购买仍关闭。删除和撤回提示已修正为“访问已撤销，云端和处理方副本删除仍待确认”，不提前宣称物理删除。

来源：[官方编辑接口](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)、[官方模型目录](https://help.aliyun.com/zh/model-studio/list-models)、[官方价目](https://help.aliyun.com/zh/model-studio/model-pricing)。
