# Agent 按需媒体关联读取

日期：2026-10-23

## 审计与边界

角色默认图片已由 `resolveSceneMedia` 根据生成任务 `sourceDocumentId`、生成结果与素材关系解析；场景和道具由 `resolveIRMaterialBindings` 在制作时补齐默认图片。`materialBindings: []` 不能单独证明默认图片不存在，素材别名也不是身份依据。

当前 Agent 的制作读取视图不返回解析后的媒体，`asset.get` 仅返回素材摘要。缺口是按需读取能力，而非要求用户重建文档与图片关系。

本轮只改开发代码与文档，使用临时测试项目和模拟 Provider，不读写真实项目数据库，不发起付费生成。不向创作 IR 的 references 加入 assetId；不自动重写既有提示词、绑定或用户会话模板。

## 实施顺序

- [x] R1 审计现有默认图片、手动覆盖、禁用、来源记录与 Agent 读取边界。
- [x] R2 复用制作解析逻辑，增加独立按需媒体视图；区分候选、选用、禁用、不可用及模型适配前的输入顺序。
- [x] R3 扩展素材详情的只读来源信息；只返回当前项目允许的文档、任务与输入素材 ID，排除路径及 Provider 私密字段。
- [x] R4 最终质量门禁：Worker 全量 966 项通过；`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过。
- [ ] R5 DOCX 页面渲染：两份文档文字同步、原段落／表格保留、ZIP 与 XML 结构检查通过；渲染器因缺少 LibreOffice `soffice.exe` 未生成页面 PNG，版式验收待有渲染器时复核。

## 验证记录

## 验证结果

- 临时 SQLite 项目验证：角色来源图在空 alias 下仍按 `sourceDocumentId` 找到；一个角色有多张图时分别返回候选和当前选中图；场景/道具图由 `references.sceneDocumentIds` 解析，即使场景 `materialBindings` 原本为空；手动选择及明确禁用分别返回，禁用后不将默认图带入输入；不存在的文件报告不可用。
- `asset.get` 来源验证：只返回当前项目内可查到的来源文档、任务 ID 及已记录的输入 asset ID，不返回提示词、路径或 Provider 私密字段；素材别名为空不影响来源关系。`inputAssetIds` 只描述快照中真实记录的输入；未记录与空输入以状态字段区分。
- Agent 工具入口验证：`scene.read view=media` 经现有授权及范围入口实际返回解析后的媒体视图；版本与分页沿用制作读取机制。IR `references` 仍仅含文档 ID。
- Worker 全量 966 项通过；`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过。
- 两份 DOCX 的新段落与 Markdown 对应，原有段落、表格、ZIP 和 XML 检查通过。页面渲染因运行环境缺少 LibreOffice `soffice.exe` 未能完成。
- 所有数据均来自临时测试项目；未读取或写入真实项目数据库，未发起付费媒体请求。

