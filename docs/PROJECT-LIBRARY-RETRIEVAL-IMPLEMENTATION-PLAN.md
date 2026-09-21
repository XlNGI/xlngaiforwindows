# 项目级检索与按需召回实施计划

版本：1.0
日期：2026-09-19
状态：已实施（P0–P6 核心功能及测试门禁已全部完成）
适用范围：Desktop、Worker、Contracts、Domain、Persistence、Context、Pi Runtime。Native Research Bridge 不在本计划范围内。

> 本文档是后续项目检索与召回改造的单一事实来源。确认规则变化时，先改本文，再改代码；若后续增加 DOCX 版本，必须与本 Markdown 同步。

## 1. 文档目的

当前召回方式是 Worker 在模型调用前编译上下文：已发布文档、项目记忆、生产约束、最近会话，以及小说 RAG 切片。项目变大后，模型只能看见被选中的一小截，表现为“上下文太局限”。

本计划把召回从**自动灌全文**改成**整库可检索、按需 search/read**。会话定位是整个软件的助理，不限于写小说、做短剧或生图；生产约束、项目记忆、已发布角色/场景都是项目产出，由模型按当前需求检索，而不是每轮自动注入正文。

## 2. 已确认的产品决策

| 主题 | 决策 |
|---|---|
| 会话定位 | 会话是整个软件的助理，可查询和操作项目资料、任务、素材，以及部分系统设置 |
| 选章 | 作为“加入助手上下文”多余，取消。本集范围改为对话指定或检索确认后冻结；小说页多选只是可选快捷入口 |
| 提示词与素材 | 角色/场景提示词只用于文生图，产出可复用角色图、场景图素材。视频用这些图片做参考生视频/图生视频，不把角色/场景正文拼进文生视频。镜头提示词用于该镜画面；大纲/计划/本集把控仍是项目文档 |
| 召回方式 | 目录可进上下文，正文靠检索。LLM 主动调用 `library.search` / `library.read` |
| 检索范围 | 当前项目内用户能看见的文本对象默认可检索，不把整库塞进 prompt |
| 草稿与正式文档 | 同一套 `documents` / `document_versions`，差别是状态，不另开仓库 |
| 草稿可见性 | 搜索默认包含草稿；结果必须标注 `draft` 或 `published`。草稿是用户当前想法，不能冒充已发布权威 |
| 上传入库 | 导入或保存自动成为可编辑草稿，并在同一事务重建索引。Agent 与用户共用 CRUD |
| 聊天附件 | 只服务当前轮。要进检索库必须走导入或保存草稿 |
| 系统宪法 | 不做“软件中心思想”系统级创作约束。只保留很短的助理身份和工具权限 |
| 项目产出 | 生产约束、项目记忆、已发布角色/场景均为项目产出，按需检索，不每轮自动灌正文 |
| 硬限制 | 密钥、连接配置、本地路径选择和高风险删除仍走 Worker 权限与受保护 UI |
| 历史版本 | 默认只索引当前工作版本和已发布版本，不默认索引全部历史版本 |
| 会话消息 | 默认可检索，结果标注为会话记录，不是正式文档 |
| 向量检索 | 首期不做 embedding。中文用 SQLite FTS5 trigram，失败时回退现有字 bigram / 词项评分 |
| 界面同步 | 不新建资料库页面。文档/小说/素材/任务日志仍是人操作界面；会话只展示资料目录和检索引用，点击打开同一对象 |
| 本地优先 | 索引只存在当前项目 SQLite。GitHub 不保存运行时资料库 |

## 3. 目标流程

```text
用户在统一会话中提出需求
        |
        v
Worker 只注入：短助理身份 + 有界资料目录（标题/类型/状态）
        |
        v
模型按需调用 library.search
        |
        +--> 返回句柄、摘要、sourceType、status、kind、作用域
        |
        v
模型对相关句柄调用 library.read
        |
        +--> 返回有界正文，并保留 draft | published | conversation 等来源标记
        |
        v
模型继续调用业务工具（写草稿、整理素材、查询设置、准备媒体任务等）
        |
        v
写操作仍走现有审核、确认和受保护 UI，不因检索到草稿而自动发布
```

外部事实核验仍使用现有 `research.search` / `research.fetch`，与项目检索分开。

## 4. 当前基线与问题

当前项目 Schema 为 v38。已有能力：

- 文档工作指针 `current_version_id` 与权威指针 `published_version_id`
- 小说保存/导入时重建 `novel_rag_chunks`
- Agent 文档工具：`document.list/read/create_draft/update_draft/archive/restore`
- 外网研究：`research.search/fetch`，句柄 TTL、公网 HTTPS 边界、引用标签
- 局部搜索：`conversation.search`（标题）、`asset.search`（别名/路径/标签）
- 统一 Agent Registry/Policy、64 KiB Tool Result、Pi Runtime 业务工具授权
- 默认提示词仍是“AI 短剧项目的导演与创作助手”
- 上下文编译默认预算约 24,000 token，上限 200,000

| 问题 | 现状 | 本计划处理 |
|---|---|---|
| 召回方式 | Worker 先猜再灌全文 | 改为模型按需 search/read |
| 检索范围 | 小说切片自动入上下文；普通文档无内容检索 | 统一项目索引，覆盖文档、小说、会话、记忆、约束、场次/镜头、素材元数据 |
| 草稿 | 普通草稿不进权威上下文；小说草稿被自动挑选切片 | 默认可搜，必须标注草稿；正文不再自动灌入 |
| 工具缺口 | `document.list` 只列元数据；`document.read` 依赖 Worker 预授权目标 | 新增 `library.search/read`，句柄由本次搜索签发 |
| 身份 | 导演/短剧助手 | 改为软件助理 |
| 附件 | 当前轮可抽取文本 | 不自动入库、不进项目索引 |

## 5. 与现有计划的关系

### 5.1 直接复用

- 统一 Agent Registry、R0-R3 策略、一次性确认、受保护 UI 交接
- 文档草稿 CRUD、审核、发布、CAS、审计
- 小说章节保存时重建切片的事务边界
- `research.search/fetch` 的先搜后读、句柄、TTL、预算和 Tool Result 有界序列化
- Pi Runtime：只调用 Worker 授权工具，不自带文件/网络检索
- 素材库 `asset.search`、会话 `conversation.search` 仍用于各自管理工作区

### 5.2 覆盖的旧表述

实施后，以下旧表述以本计划为准：

- [M3 上下文与 LLM](./M3-CONTEXT-LLM.md) 中“未发布草稿默认不进入其他会话的 LLM 上下文”：继续适用于**自动注入权威上下文**；不阻止检索工具返回带 `draft` 标记的当前工作版本。
- [小说 Agent 工具实施计划](./NOVEL-AGENT-TOOL-IMPLEMENTATION-PLAN.md) 中“后续 Agent 检索已保存小说草稿切片”：改为通过 `library.search/read` 按需检索，不再由 `NovelContextService` 在普通会话里自动挑选正文切片。
- [项目文档工作流](./AGENT-PROJECT-DOCUMENT-WORKFLOW-IMPLEMENTATION-PLAN.md) 中“需要项目内资料时默认由 Worker 编译上下文”：普通助理会话改为按需检索；`document.list/read` 仍保留给显式文档工作流。
- `packages/context` 默认系统提示“只使用本次上下文中明确列出的正式资料”：改为允许通过项目检索工具取用当前项目资料，并区分草稿与已发布。

### 5.3 短剧源材料边界

短剧派生文档仍需要可追溯的源章节，但这不再等于“先勾选再灌上下文”。

```text
普通会话：不选章，不灌全文，一律 library.search/read
本集生成：对话指定或检索确认章节 -> Worker 冻结本章节 ID+当前版本
小说页多选：可选快捷入口，只作用于本次请求，不改变之后所有聊天的召回
```

角色/场景提示词、本集整体把控等派生文档的审阅、发布和参考链规则不变：检索可以读到草稿，但不能把草稿写成后续正式参考链的权威来源。

## 6. 目标架构

```text
用户消息 / 资料目录
        |
        v
Pi / Agent loop  ---- library.search ----+
        |                                 |
        |                                 v
        |                    LibrarySearchService
        |                                 |
        |                                 +--> project_library_chunks
        |                                 +--> project_library_fts (FTS5)
        |                                 +--> 任务内 sourceHandle
        |
        +------ library.read -------------+
                                          |
                                          v
                               有界正文 + 来源标记
                                          |
                                          v
                               现有业务工具（文档/小说/素材/设置/媒体）
```

| 模块 | 职责 | 不承担 |
|---|---|---|
| LibraryIndexService | 保存/导入/发布/归档后重建切片和 FTS；升级回填 | 不调用 LLM，不写业务正文 |
| LibrarySearchService | 校验查询、检索、签发句柄、有界 read | 不访问密钥，不抓外网 |
| ContextService / NovelContextService | 普通会话只提供身份和有界目录；短剧结构化生成仍冻结用户所选章节 | 不再向普通会话注入大段项目正文 |
| Agent Registry | 注册 `library.search/read` 为 R0 只读并行工具 | 不把检索结果写入文档 |
| Pi Runtime | 按需调用检索工具 | 不维护第二套索引或会话数据库 |

## 7. 检索语料

### 7.1 默认可检索

| 来源 | sourceType | 索引内容 | status |
|---|---|---|---|
| 项目文档当前工作版本 | `document` | 标题 + Markdown 切片 | `draft`（当前版本尚未发布或不同于已发布版本时）或 `published` |
| 项目文档已发布版本 | `document` | 若与当前版本不同，另建已发布切片 | `published` |
| 小说章节 | `novel-chapter` | 复用/迁移现有章节切片 | 与文档版本指针一致 |
| 小说参考资料 | `novel-reference` | 标题 + 正文切片 | `draft` / `published` |
| 项目记忆 | `memory` | 记忆正文 | `memory` |
| 生产约束 | `constraint` | 约束正文 | `constraint` |
| 会话消息 | `conversation` | 标题 + 已完成消息正文 | `conversation` |
| 场次 / 镜头 / 分镜 | `scene` / `shot` / `storyboard` | 标题 + 分镜正文 | 对应实体状态 |
| 素材 | `asset` | 别名、相对路径、标签，不索引像素 | `active` / `trash` |
| 变更集 / 改编提案 / 媒体任务 | `change-set` / `adaptation` / `media-task` | 标题、状态、有界摘要 | 任务状态 |

同一文档若当前草稿与已发布版本不同，两条切片都可命中，必须带不同 `status` 和 `versionId`。

### 7.2 默认不进检索库

- 密钥、Authorization、Provider Base URL、自定义请求头
- 聊天附件二进制及未保存为草稿的附件摘录
- 外网研究缓存全文（`cache/research/`）
- 图片、视频、音频二进制
- 全部历史文档版本（除当前工作版本与已发布版本）
- 工具授权 handle、凭据句柄、本地绝对路径
- 应用级诊断导出包

设置状态继续走现有 `settings.get`（脱敏能力目录），不进入 FTS。高风险设置变更仍走受保护 UI。

## 8. 数据模型

当前 Schema v38。本计划从 **v39** 开始。所有 ID 使用 UUID，时间使用 ISO 8601 UTC。

### 8.1 Schema v39：统一切片

```text
CREATE TABLE project_library_chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT,
  version_id TEXT,
  status TEXT NOT NULL,
  kind TEXT,
  scope_type TEXT,
  scope_id TEXT,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  content_text TEXT NOT NULL CHECK (length(content_text) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  character_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, source_type, source_id, version_id, ordinal)
);

CREATE INDEX idx_library_chunks_project_type
  ON project_library_chunks(project_id, source_type, status, updated_at, id);
CREATE INDEX idx_library_chunks_source
  ON project_library_chunks(project_id, source_id, version_id, ordinal);
```

切片规则与现有小说 RAG 对齐：目标约 1600 字，最小 800，最大 2200，重叠 160，优先按段落/句号切。素材、任务等短记录可不切，整条作为 `ordinal = 0`。

### 8.2 Schema v39：FTS

```text
CREATE VIRTUAL TABLE project_library_fts USING fts5(
  title,
  content_text,
  tokenize = 'trigram',
  content = 'project_library_chunks',
  content_rowid = 'rowid'
);
```

若当前 sidecar SQLite 不支持 trigram，Worker 必须在迁移测试中失败并改用显式 n-gram 评分（复用 `novelChunkScore` / 中文 bigram），不得静默退回空格分词。

### 8.3 索引维护

以下动作必须在同一 Worker 事务内替换对应切片：

- `document.draft.save` / Agent `create_draft` / `update_draft`
- `document.publish` / `selfPublish`
- `novel.chapter.save` / `novel.import` / 章节恢复
- 记忆、约束的保存与删除
- 会话消息进入 `complete`；流式中的不完整消息不进索引
- 场次/镜头/分镜保存
- 素材别名、标签、软删除、恢复
- 变更集/媒体任务状态变化时更新摘要切片

归档或软删除的对象：从默认检索中排除，可用 `includeArchived=true` 或 `deleted=trash` 显式打开。

升级迁移：回填当前工作版本、已发布版本、现有 `novel_rag_chunks`、记忆、约束、已完成会话消息和素材元数据。`novel_rag_chunks` 首期可继续写，作为小说切片来源；P3 完成后由 `project_library_chunks` 成为唯一检索源，再在后续小版本删除双写。

## 9. 工具合同

新增只读工具，加入 `ALL_AGENT_TOOL_DEFINITIONS` 与统一 Registry，策略为 R0、`parallel-readonly`。默认在普通助理会话、文档、小说、短剧和研究任务中可用。

### 9.1 `library.search`

```text
library.search
  query            string  1..200   必填
  sourceTypes?     string[]         document, novel-chapter, novel-reference,
                                    memory, constraint, conversation,
                                    scene, shot, storyboard, asset,
                                    change-set, adaptation, media-task
  status?          string           draft | published | conversation |
                                    memory | constraint | active | trash | any
                                    默认 any（不含 trash/archived）
  kind?            string           文档 kind 或素材 kind
  scopeType?       string           project | scene | shot
  scopeId?         string
  includeArchived? boolean          默认 false
  limit?           integer          1..20，默认 8
```

成功结果：

```text
{
  status: "searched",
  queryHash,
  resultCount,
  truncated,
  sources: [{
    sourceHandle,          // 任务内短期不透明句柄
    sourceType,
    sourceId,
    versionId?,
    status,                // draft | published | ...
    kind?,
    title,
    snippet,               // <= 400 字
    citationLabel,         // L1, L2, ...
    updatedAt
  }]
}
```

规则：

- 只搜索当前打开项目。
- 句柄绑定 `taskId + attemptId`，TTL 10 分钟，过期后必须重新 search。
- 结果按相关性排序，稳定二次键为 `updatedAt DESC, id`。
- 草稿命中必须 `status=draft`，不得省略。
- 不返回完整正文、绝对路径、密钥或授权字段。
- 单任务预算：最多 8 次 search。

### 9.2 `library.read`

```text
library.read
  sourceHandle     string  必填
  maxChars?        integer 1..20000，默认 4000
```

成功结果：

```text
{
  status: "read",
  sourceHandle,
  sourceType,
  sourceId,
  versionId?,
  status,
  kind?,
  title,
  content,                 // 有界正文
  characterCount,
  truncated,
  citationLabel,
  untrusted: false         // 项目内资料；外网研究仍走 research.fetch
}
```

规则：

- 只能读取本次任务 search 返回且未过期的句柄。
- 默认读单个切片；不得一次把整本小说或全部会话打包返回。
- 单任务预算：最多 16 次 read。
- Tool Result 仍受 64 KiB 限制；超限截断并设 `truncated=true`。
- 读取草稿时，序列化结果必须包含“未审核候选资料，不能当作已发布权威”的固定提示字段或 status。

### 9.3 与现有工具的分工

| 需求 | 使用 |
|---|---|
| 按内容找项目里的任何资料 | `library.search` / `library.read` |
| 管理某个文档（更新/归档） | 先 library 定位，再走现有 `document.*` / `novel.*` 授权写工具 |
| 管理会话本身 | `conversation.search/create/rename/archive` |
| 管理素材库 | `asset.search/get` 及标签/组工具 |
| 外网事实 | `research.search/fetch` |
| 模型/能力目录 | `settings.get` |

禁止用 `library.read` 写回文档，禁止用检索结果覆盖 `published_version_id`。

## 10. 召回策略变更

### 10.1 普通助理会话

模型调用前只注入：

1. 短助理身份（替换现有导演提示词）。
2. 有界资料目录：按类型最多各 20 条，字段限于 `title`、`sourceType`、`status`、`kind`、`updatedAt`。无正文。
3. 当前用户消息、最近有界会话摘要（现有最近消息可保留，但不再附带整库文档）。

不注入：

- 已发布文档全文
- 小说 RAG 切片正文
- 项目记忆全文
- 生产约束全文
- 角色/场景提示词全文

模型需要这些内容时，必须 search/read。

建议身份文本：

```text
你是本软件的工作助理。你可以查询和操作当前项目中的资料、会话、任务、素材，以及部分系统设置。
项目内容不会自动全部进入上下文；需要时调用 library.search / library.read。
草稿和已发布文档是同一对象的不同状态。草稿代表用户当前想法，引用时必须保持草稿标记，不能当作已发布权威。
密钥、连接配置和高风险设置必须交给受保护界面，不能在对话中接收或回传。
不要替用户填写或提交生产 API 参数。
```

### 10.2 短剧结构化生成与选章

普通会话里的选章是旧召回补丁，**作为“加入助手上下文”多余，应取消**。整库可检索后，用户不必先到小说页勾选章节才能说话。

本集生成仍然需要**范围**，但范围不是上下文，而是任务源材料：

- 用户直接说“用卷三第 3–5 章做一集”，或 Agent 检索后列出候选章节请用户确认。
- Worker 把确认后的章节 ID 与当前已保存版本冻结进本次 Agent 任务。
- 冻结用于派生文档的来源追溯和一致性，不把这些章节全文变成之后所有聊天的自动上下文。
- 小说工作区多选 + “生成短剧内容”可以保留为快捷入口，等价于把这些章节写进当前请求，不灌全文、不切换成全局短剧上下文模式。

没有本集生成任务时，小说问答一律走 `library.search/read`，不要求选章。

### 10.3 提示词、素材与项目文档

角色、场景提示词和镜头提示词都是给生成模型的文本，但**不是文生视频的同一条 prompt**。角色/场景提示词的产物是可复用图片素材；视频阶段吃的是这些图片，不是把角色/场景正文拼进文生视频。

```text
角色提示词 --文生图--> 角色图片素材 ──┐
场景提示词 --文生图--> 场景图片素材 ──┼── 参考图/首帧
镜头提示词 --文生图--> 本镜画面/首帧 ─┘
        |
        v
参考生视频 / 图生视频（可另附镜头运动描述）
```

禁止：`角色提示词文本 + 场景提示词文本 + 镜头提示词` 直接文生视频。

| 对象 | 类型 | 用来做什么 | 发给谁 |
|---|---|---|---|
| 角色提示词 | 生图提示词 | 生成可复用角色图（立绘/三视图等） | 文生图适配器的 `prompt` |
| 场景提示词 | 生图提示词 | 生成可复用场景图 | 文生图适配器的 `prompt` |
| 角色/场景图片 | 素材 | 后续镜头和视频的参考图 | 参考生图/参考生视频的图片输入 |
| 镜头提示词 | 本镜生图提示词 | 生成这一镜画面或首帧 | 文生图适配器的 `prompt`，可引用角色/场景**素材** |
| 镜头运动/视频描述 | 可选短文本 | 描述这一镜怎么动 | 图生视频/参考生视频的文本字段，不是角色设定全文 |
| 大纲 / 计划 / 本集把控 | 项目文档 | 给人看、给 Agent 检索 | 默认不进任何生产 API |
| 分镜文档 | 可选叙事 | 写镜头叙事 | 不是厂商 prompt |

`[角色:林澈]` / `[场景:旧码头]` 在生产请求里应解析为**已入库的参考图素材**，而不是把对应提示词文档正文拼进视频 prompt。提示词文档只在“生成该角色/场景素材”时作为文生图输入。

首期存储仍可：角色/场景用 `documents.kind=character/scene`，镜头用 `shots.prompt`，图片进素材库。检索把提示词和素材分开：提示词是文本配方，素材是可拖进生产参数的图片。

### 10.4 冲突处理


- 同时命中草稿与已发布版本：两条都返回，由模型判断；写派生资料时只能把已发布版本当参考链权威。
- 用户当前指令与已发布设定冲突：以用户当前请求为主生成草稿，并在回复中标明冲突来源。
- 检索为空：允许基于用户当前消息继续，但不得假装已经读过项目资料。

## 11. 界面同步

界面跟的是**同一批项目对象**，不是检索工具自己的第二套页面。人继续在文档、小说、素材、设置里增删改查；助手在会话里 search/read。两边看到的标题、草稿/已发布状态和打开目标必须是同一个 ID。

### 11.1 原则

- 不新增“知识库/检索工作区”。用户没有先选检索范围的步骤。
- 文档工作区、小说工作区、素材库、任务日志保持现有 CRUD 和筛选；它们的保存/导入/发布就是索引更新入口。
- 会话不展示切片正文，只展示资料目录和本次检索引用。
- 助手**写入**草稿后，继续自动打开对应编辑器；助手**只读**检索时，不抢焦点。
- 独立窗口与主窗口共用 Worker 数据。保存后必须同时刷新列表和会话资料目录。

### 11.2 现有界面怎么改

| 界面 | 现在 | 同步后 |
|---|---|---|
| 会话上下文条 | `上下文 N 项 · 约 X tokens`，列出自动灌入的来源全文标签 | 改为 `资料目录 N 项`。只显示标题、类型、`草稿`/`已发布`，不显示正文和大正文 token 数 |
| 会话空状态 | “助手会结合项目资料自动判断并执行” | “需要时会检索项目里的草稿和已发布资料” |
| 工具时间线 | 只显示已调用工具名 | `library.search/read` 显示 citationLabel、标题、草稿/已发布；点击打开同一文档/章节/素材 |
| 短剧选章 | 小说页多选后“加入助手上下文”，后续消息都按短剧任务灌切片 | 普通会话不再选章。本集范围由用户在对话中指定，或 Agent 检索后确认，再由 Worker 冻结章节 ID+版本。小说页多选只作为可选快捷入口，效果等于把这些章节说给助手，不灌全文 |
| 小说“生成短剧内容”按钮 | 把所选章节塞进当前会话上下文 | 可保留为快捷入口：打开会话并带上“请基于这些章节生成本集”。不改变普通聊天的召回方式 |
| 文档/小说/素材列表 | 已有草稿、已发布、标题搜索 | 保持。保存、导入、发布成功后刷新列表，并刷新当前会话资料目录 |
| 任务日志 | 已有外网研究来源 | 增加“项目检索来源”：L1/L2、标题、status、打开对象。不展示全文 |
| 生成完成后打开编辑器 | Agent 创建草稿后自动打开 | 保留。仅对本次写入的文档/章节；read 命中不打开 |

### 11.3 保存后的刷新顺序

```text
用户或 Agent 保存/导入/发布
        |
        v
Worker 同一事务：写 document_versions + 重建 project_library_chunks
        |
        v
Desktop 刷新对应工作区列表
        |
        +--> 文档列表 / 小说列表 / 素材库
        +--> 当前会话 context.preview（资料目录，不含正文）
        +--> 已分离的会话窗口使用同一预览结果
```

规则：

- 索引对用户静默。普通保存不弹“正在建立检索索引”。
- 超大导入可在现有导入进度里带一句“正在建立检索切片”，完成后才允许该批章节被 search 命中。
- `context.preview` 改为返回资料目录，不再返回已注入正文的 sources。旧 UI 的 token 大数不再作为产品信息展示。
- 附件未保存为草稿时，会话附件条可以在，资料目录和 library.search 都看不见它。

### 11.4 检索引用怎么落到编辑器

会话工具时间线和任务日志中的项目检索结果必须能打开源对象：

| sourceType | 点击后 |
|---|---|
| document / novel-reference / storyboard | 打开文档工作区到该 documentId，定位当前或已发布版本 |
| novel-chapter | 打开小说工作区到该章节 |
| asset | 打开素材库并选中该素材 |
| conversation | 打开对应会话（只读跳转，不切换当前正在跑的任务） |
| scene / shot | 打开镜头/场次工作区 |
| memory / constraint / media-task / change-set | 打开任务日志或对应详情，不新造页面 |

打开的是工作区里的对象，不是搜索结果副本。草稿标记必须与编辑器顶栏一致：未发布显示“项目文档草稿”，已发布显示“已发布项目资料”。

### 11.5 不在界面上做的事

- 不让用户为普通聊天手工勾选“本轮上下文文档”。
- 不在聊天里展开 library.read 的全文。
- 不把 FTS 命中列表做成第三套全局搜索页。文档/小说/素材各自的标题搜索保留给人工浏览。
- 不在设置页展示原始索引表。

### 11.6 推荐信息架构

左导航按生产链路排，不按存储表排。角色/场景从“项目文档”里拆出去，避免和大纲、计划混在一起。

```text
左导航                         中间工作区                      会话
小说                           章节列表/编辑                   软件助理
剧本                           大纲 / 计划 / 本集把控         资料目录（无正文）
角色与场景                     提示词 + 已生成图片             检索引用可点回对象
场次与镜头                     镜头提示词 + 参考图 + 生成
素材库                         全部媒体的检索与整理
任务日志                       生成/检索/审核记录
```

**剧本**
只放给人看的资料：大纲、计划、本集整体把控、笔记。不做生图入口。

**角色与场景**
每个角色/场景一页，上下两块，不要做成普通文档列表：

1. 提示词：草稿/已发布，按钮是“生成角色图/场景图”（文生图）。
2. 素材：这个对象生成过的图。选中后可作为后续镜头和视频的参考图。

一人一档、一场景一档。生成结果写入素材库，并挂回这个角色/场景。

**场次与镜头**
镜头页不再暗示“把角色设定正文拼进视频”。

1. 镜头提示词：只用于生成本镜画面/首帧。
2. 参考图槽：从角色/场景素材拖入，或把 `[角色:林澈]` 解析成该角色的默认图。
3. 两个生成动作：生成本镜画面（文生图/参考生图）；用参考图生成视频（参考生视频/图生视频）。
4. 分镜说明：可选长文，不发给厂商。

**会话**
不承担选资料、选章、拼 prompt。用户直接说目标。助手检索后点引用打开上面这些页。小说页“生成短剧内容”只是把章节范围写进当前这句话，不切换全局上下文模式。

**生产参数栏**
跟当前工作区对象走：在角色页打开时带上该角色提示词；在镜头页打开时带上镜头提示词和已选参考图。用户仍可改供应商和模型，但不从文档库临时拼一条文生视频 prompt。

## 12. 权限、隐私与预算


- `library.search/read` 均为 R0 只读，可并行。
- 只读打开的项目允许检索，不允许经检索路径写入。
- 检索审计写入 `agent_tool_calls` 脱敏摘要：query hash、sourceType 计数、句柄数、citationLabel；不写全文。
- 普通聊天仍不能隐式修改文档、记忆或约束。
- 附件不进索引。
- 预算耗尽返回稳定错误 `LIBRARY_BUDGET_EXCEEDED`，不得改走自动灌全文作为降级。

## 13. 实施阶段

### P0 合同冻结

- [x] 本计划成为检索/召回改造的单一事实来源
- [x] 更新 AGENTS.md，要求后续检索工作先读本计划
- [x] 界面同步规则写入本计划：不新建资料库页，会话展示目录和引用，工作区仍是对象编辑入口
- [x] Contracts 增加 `library.search` / `library.read` 类型、错误码和 Agent 工具名
- [x] 明确短剧结构化生成与普通会话召回的分流

完成标准：决策表与第 11 节界面规则无未决项；不改业务行为代码。

### P1 统一索引

- [x] Schema v39：`project_library_chunks` + FTS
- [x] 文档/小说保存与导入事务内重建切片
- [x] 旧项目回填；迁移测试覆盖空项目、已有小说切片、草稿与已发布并存
- [x] 中文查询回归：至少覆盖双字词、角色名、场景名

完成标准：Persistence 迁移测试通过；保存章节后检索源可见新切片。

### P2 检索工具

- [x] `LibrarySearchService` 实现 search/read、句柄、TTL、预算
- [x] 注册到统一 Registry 与 Pi 授权集
- [x] Worker 测试：项目隔离、草稿标记、过期句柄、预算、64 KiB 截断
- [x] 与 `research.*` 并存，互不混用句柄

完成标准：Worker 定向测试通过；模型可见工具定义含 `library.search/read`。

### P3 普通会话召回收缩

- [x] 普通助理会话停止注入文档/记忆/约束/小说切片正文
- [x] 注入有界资料目录和新助理身份
- [x] `context.preview` 改为资料目录；会话上下文条改为“资料目录 N 项”
- [x] 会话空状态改为按需检索，去掉“加入助手上下文”
- [x] 取消普通会话因选章而切换成短剧上下文模式；本集范围改为任务级冻结
- [x] 小说页多选若保留，只作为本次请求的快捷入口，不灌全文
- [x] 生成/上下文测试更新，旧“必须包含已发布正文”断言改为目录+工具

完成标准：未调用检索工具时，prompt 和上下文条都不再出现小说章节或角色设定全文。

### P4 语料扩展

- [x] 索引会话消息、记忆、约束、场次/镜头/分镜、素材元数据、任务摘要
- [x] `sourceTypes` / `status` 过滤
- [x] 归档/回收站默认排除

完成标准：对角色名、约束原文、会话里提过的设定、素材别名均可 search 命中。

### P5 可观测性与桌面

- [x] 会话工具时间线展示 `library.search/read` 的 citationLabel、标题、草稿/已发布，点击打开源对象
- [x] 任务日志增加“项目检索来源”区块，结构对齐外网研究来源，不展示全文
- [x] 保存/导入/发布后刷新工作区列表、当前会话资料目录和已分离会话窗口
- [x] Agent 写入草稿仍自动打开编辑器；仅 read 不抢焦点
- [x] 确认附件未保存为草稿时，不出现在资料目录和检索结果中

完成标准：一次真实会话可从聊天时间线和任务日志看出 search -> read -> 写草稿，并能点回同一文档。

### P6 对齐与门禁

- [x] 回写 M3、小说计划、文档工作流计划中被覆盖的旧表述
- [x] `pnpm test`、`typecheck`、`lint`、`format:check` 及本计划相关聚焦测试
- [x] 不把 embedding、跨项目检索、视觉相似搜图纳入本阶段

完成标准：质量门禁通过；发布状态仍遵循现有 `HOLD` 边界，本计划不单独宣称可发布。

## 14. 验收标准

功能：

- 用户导入小说或 Markdown 后，无需发布即可被 `library.search` 命中，且 `status=draft`
- 发布后同一内容可按 `published` 命中；若草稿继续修改，两条版本都能区分
- 普通会话不再自动携带整章小说或全部角色设定正文
- 模型不调用检索也能根据资料目录知道有哪些对象，但读不到正文
- 短剧勾选章节生成仍能读到所选章节已保存切片
- 聊天附件不出现在检索结果中，除非已保存为草稿
- 会话上下文条只显示资料目录，不显示自动灌入的正文来源
- 点击检索引用会打开文档/小说/素材等现有工作区中的同一对象
- 普通会话不需要先选章；本集生成的章节范围来自对话指定或检索确认，并冻结在任务上

安全：

- 跨项目句柄无效
- 过期句柄无效
- 结果不含密钥、绝对路径、authorization
- 只读项目可搜不可写

性能（本机、单项目）：

- 100 万汉字级小说索引重建可在保存事务内完成，或对超大导入采用同一事务分批写入但对外仍原子
- `library.search` 在 1 万切片内通常 100ms 级（开发机，作为回归观察值而非发布门禁）

## 15. 非目标

- 不做第二套草稿数据库或独立资料库应用
- 不新增用户侧全局检索工作区，不让用户为普通聊天手工勾选上下文文档
- 首期不做向量/embedding 召回
- 不做以图搜图、音视频内容识别
- 不把聊天附件自动转成项目文档
- 不让 Agent 经检索路径发布文档或提交生产 API
- 不检索其他项目，不做云端同步索引
- 不替换 `research.search/fetch`

## 16. 主要代码入口

- `apps/worker/src/agent-tool-definitions.ts`
- `apps/worker/src/agent-tool-registry.ts`
- `apps/worker/src/agent-provider-loop-service.ts`
- `apps/worker/src/pi-conversation-runtime.ts`
- `apps/worker/src/context-service.ts`
- `apps/worker/src/novel-context-service.ts`
- `apps/worker/src/research-service.ts`（句柄/预算模式参考，不改外网行为）
- `packages/context/src/index.ts`
- `packages/persistence/src/schema.ts`
- `packages/persistence/src/novel-rag-chunks.ts`
- `packages/contracts/src/index.ts`
- `apps/desktop/src/ChatPanel.tsx`
- `apps/desktop/src/TaskLogView.tsx`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/NovelWorkspace.tsx`
- `apps/desktop/src/use-conversation-workspace.ts`

## 17. 变更记录

### 2026-09-21 章节位置检索

- [x] 小说切片与资料目录标题改为「显示标签 + 章节名」，导入后可用地点/章名检索，不再只索引「第 N 章」。
- [x] 点击 `library.search` 小说章节引用会打开对应章节，而不只是小说页。
- [x] Schema v40 回填已有文档切片标题。验证：persistence 章节检索测试、Worker library.search 导入检索测试、NovelWorkspace 定位测试。

### 2026-09-20 会话续轮历史修复

- [x] Chat Completions 按顺序回传本次 Pi 任务之前的助手文本、工具调用和工具结果，避免续轮只保留最近一次 read/search。
- [x] Native 桥接使用 Pi 当前系统提示词，同时保留 Worker 检索规则；冻结目录只传一次，仍不自动注入资料正文。
- [x] 回归覆盖真实 GenerationService → Pi → NativeProviderBridge、多轮工具结果、同轮多个工具、工具失败、缺少 Chat 响应 ID，以及 Responses 原有续轮协议。
- [x] 验证：Worker 会话/生成服务/桥接定向测试 50 项通过；Rust `llm_stream::tests` 28 项通过，包含历史顺序、结果配对校验和授权句柄不外传。

本次不调整 24 轮停止保护、不改变检索预算，也不增加持久化会话数据库。

| 日期 | 说明 |
|---|---|
| 2026-09-19 | 初稿。锁定整库按需检索、草稿可搜但须标注、附件不入库、不做系统创作宪法、项目产出一律按需检索、普通会话停止自动灌全文。 |
| 2026-09-21 | 修复章节位置检索：索引显示标签与章名，点击引用打开同一章节。 |
| 2026-09-19 | 补充界面同步：不新建资料库页；会话展示资料目录和检索引用；保存后刷新列表与目录；点击引用打开现有工作区同一对象。 |
| 2026-09-19 | 选章不再作为加入助手上下文的步骤。普通会话不选章；本集范围改为对话指定或检索确认后冻结。 |
| 2026-09-19 | 再纠正：角色/场景提示词只用于文生图产出可复用素材；视频走参考图/图生视频，不把角色场景正文拼进文生视频。 |
| 2026-09-19 | 补充 UI 信息架构：剧本与角色/场景拆分；角色页=提示词+图；镜头页=提示词+参考图+生图/生视频。 |
