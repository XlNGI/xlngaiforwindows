# 场次与可复用场景绑定

日期：2026-10-12（America/New_York）

## 产品关系

用户确认场次应绑定场景，并询问如何决定对应关系。场次是一次剧情发生单元，场景是「角色与场景」中的可复用制作场景文档。一个场次保存一个 `sceneDocumentId`，多个场次可复用同一场景。LLM 按需读取剧情和场景资料，选择真实 ID；地点不明或多个候选时澄清，没有场景时先创建场景提示词文档。Worker 校验 ID/项目/类型/有效状态；剧情语义是否符合由模型和用户审核，不能由标题关键词硬编码决定。

## 保存与界面

Schema v42 在 scenes 与 agent_change_set_items 增加 scene_document_id，并保留外键和同项目/有效制作场景校验。升级后旧场次仍未绑定，不按名称迁移。场次保存事务支持省略保留、null 清除、行版本冲突和同项目制作场景类型校验。小说资料、章节、错误类型、缺失、归档或跨项目目标失败。

普通 `scene.submit_structure` 要求每场提供 `sceneDocumentId`；既有显式工具的旧无绑定参数保持兼容。结构目录向模型给出场次及镜头所属场景，正文继续检索。方案列表显示绑定场景名称，批准前再次检查目标。镜头页增加「场次绑定场景」选择及打开资料入口。

镜头默认按场景文档 ID 查询其已有图片，排除删除、跨项目和视频素材；不依赖同名标题，继承图不保存成单镜头覆盖。手动镜头图优先，可清除默认继承或恢复。生成时重新取实际参考图 ID，沿用既有生产草稿快照；之后场次绑定变化不会改写已保存的草稿。参考图加载和生成准备排除旧项目/镜头/绑定请求。场景正文不拼入视频提示词。

## 验证

- Persistence 52 项：旧结构升级、重复迁移、故障整体回滚、保留场次和镜头提示词。
- Worker Content/ChangeSet 26 项聚焦；结构/Provider/Gateway 117 项聚焦：绑定复用、保留/清除、CAS、错误目标、审核前场景归档冲突、普通模型工具先创建场景资料再提交结构、结果和实际关系一致。
- Desktop 70 项聚焦：方案显示和批准刷新、绑定选择和清除、默认图按文档 ID 继承、同名隔离、手动覆盖、清除/恢复以及过期异步图片排除。
- 全仓 1005 项通过：Worker 563、Desktop 301、Persistence 52、Contracts 24、Context 8、LLM 32、Generation Adapters 25。typecheck、lint、format:check、git diff --check、tauri:build 通过；Vite 包体积提示及 Rust 3 个既有警告保留。
- 最终生产 sidecar 8 组：两协议 × 两普通入口 × 有/无 hint。创建两份场景提示词资料、真实 ID 绑定两场三镜、批准前后状态和实体关系检查全部通过。Provider 请求数为 0；未实测真实模型语义选择。

日志：`.scene-binding-tests.log`、`.scene-binding-lint.log`、`.scene-binding-package.log`、`.scene-binding-sidecar.log`（仓库忽略文件）。隔离报告：`C:/Users/10698/AppData/Local/Temp/unicomp-llm-intent-6pZEgo/report.json`。

安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`；SHA-256：`FCD178334A361ECECBA50C5F04EF3678A941DF5478347A8067FEAAC663622666`。包内 Worker 源 SHA-256：`B35D00D8A1C7A5694830F5B60E0D762B3C371CA60CEC512E417B79E68C7E4837`。

未安装或替换用户运行实例，未修改用户项目数据库。安装后项目升级为 v42，旧版回滚须使用升级前项目备份。素材库原有入库、别名、手动素材组、回收站及生成草稿引用快照合同保持不变。
