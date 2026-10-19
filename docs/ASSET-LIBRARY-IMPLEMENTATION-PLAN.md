# 素材库优化方案实施文档

> **Agent execution source.** 本文件与同目录 DOCX 方案对应；确认规则变化时必须同步更新两个版本。

## 执行状态

- [x] P0 基线与合同
- [x] P1 别名、查询与回收站
- [x] P2 标签与素材组
- [x] P3 独立素材库 UI
- [x] P4 拖拽与生产目标
- [x] P5 日志联动、性能与发布硬化
- [x] U 场次目录与统一参考资料：功能与质量门禁完成；DOCX 版式待验收（详见 10.5）
- [x] S 场次角色媒体预览：功能与质量门禁完成；DOCX 版式待验收（详见 10.8）
- [x] F 文件参数预览补充：功能与质量门禁完成；DOCX 版式待验收（详见 10.4）
- [x] C 素材预览卡片样式：功能与全仓门禁完成；DOCX 版式待验收（详见 10.7）

> 每完成一个阶段，更新本清单、阶段验收记录及相关测试结果。不得仅因代码已提交而勾选完成。

> 基于现有 Tauri、React、Worker 与 SQLite 架构的落地设计

> **版本：**v1.3　 **状态：**已实施；文档渲染待验收
> **负责人：**研发 / 测试 / 产品　 **适用范围：**E:\xlngai\xlngaiforwindows

> **实施结论** 在现有项目 Schema v7 和 asset.* 能力上增量演进：先分离别名与文件名并建立软删除，再增加项目标签与手动素材组成员关系，最后用版本化拖拽载荷接入生产参数区域。所有写入仍由 Worker 串行完成，素材文件继续保存在项目本地目录。

## 1. 当前基线

| 层级     | 当前实现                                                            | 本次影响                                                        |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| 桌面端   | Tauri 2 + React 19 + TypeScript；素材列表集中在 ProductionPanel     | 新增独立 AssetLibrary 视图和拖拽接收协议                        |
| Worker   | Node/TypeScript Worker 负责生成、素材落盘和 asset.* IPC             | 新增 AssetLibraryService 或拆分现有 ImageGenerationService 职责 |
| 持久化   | better-sqlite3，项目 Schema v7，assets 与 generation_results 已存在 | 新增 v8-v10 迁移、Repository 与索引                             |
| 文件系统 | 项目 assets/ 保存媒体，cache/deleted-assets/ 暂存删除文件           | 让回收站保留数据库记录并支持恢复、清空                          |
| 生成链路 | 图片可选择是否保存；视频成功后落盘并登记素材                        | 统一为成功落盘后自动入库                                        |

现有关键约束：项目数据库由 Worker 作为唯一写入者；SQLite 开启 WAL、外键、busy timeout；素材路径必须保持为项目内相对路径；generation_results 已提供任务到素材的关联。新实现应延续这些边界。

## 2. 实施原则

- 兼容优先：保留现有 asset.list、asset.preview、asset.open 与 asset.reveal，在新 UI 稳定前不删除旧调用。
- 别名不改文件：现有 asset.rename 会移动磁盘文件，应改名为文件级操作或停止从素材库暴露；新增 alias 更新接口。
- 数据库驱动筛选：搜索、标签查询、素材组成员解析和回收站状态均由 Worker 查询，避免桌面端全量过滤。
- 文件与记录补偿：涉及移动文件和数据库事务的操作必须支持失败回滚与完整性检查。
- 拖拽载荷版本化：桌面端只传素材 ID 和稳定元数据，生产目标在落地时重新校验。
- 增量交付：先可查询和整理，再接拖拽；每阶段保留独立测试门禁。

## 3. 目标架构与职责

```text
AssetLibraryView / AssetCard / AssetDetails / TagPanel / AssetGroupPanel
                         │ Worker IPC contracts
                         ▼
AssetLibraryService ── TagService ── AssetGroupService
        │                  │                  │
        └──────── Project repositories ───────┘
                         │
                 SQLite Schema v8-v10
                         │
          assets/ media + cache/deleted-assets/
```

| 模块                | 职责                                         | 不承担                      |
| ------------------- | -------------------------------------------- | --------------------------- |
| AssetLibraryView    | 浏览、筛选状态、选择、拖拽、详情编辑         | 不直接访问文件系统或 SQLite |
| AssetLibraryService | 查询、别名、软删除、恢复、来源定位、文件校验 | 不管理任务轮询              |
| TagService          | 标签 CRUD、权限校验、批量分配                | 不保存素材组成员            |
| AssetGroupService   | 保存素材成员、有序解析与快照                 | 不复制素材文件              |
| 生产目标适配器      | 校验拖拽类型和数量、写入参数草稿、排序       | 不修改素材标签              |

## 4. 数据模型与迁移

建议将项目 Schema 从 v7 分三次迁移，便于独立回滚和测试。所有新时间字段使用 ISO 8601 UTC 字符串；所有 ID 使用 UUID。

### 4.1 Schema v8：别名与回收站

```text
ALTER TABLE assets ADD COLUMN alias TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN updated_at TEXT;
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
ALTER TABLE assets ADD COLUMN trash_relative_path TEXT;
UPDATE assets SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX idx_assets_library
  ON assets(project_id, deleted_at, created_at, id);
```

约束通过 Service 层与迁移测试保证：alias 去除首尾空格后最长 120 个 Unicode 字符；deleted_at 为空时 trash_relative_path 必须为空；进入回收站后保留原 relative_path，实际暂存路径写入 trash_relative_path。

### 4.2 Schema v9：项目标签

```text
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);
CREATE TABLE asset_tag_assignments (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY(asset_id, tag_id)
);
```

normalized_name 用于项目内去重，建议规则为 Unicode NFKC、trim、连续空白折叠和不区分大小写。显示名称保留用户输入。当前单用户版本 created_by 固定为 local-user；接入成员系统时迁移为稳定 principal ID。

### 4.3 Schema v10：素材组

```text
CREATE TABLE asset_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);
CREATE TABLE asset_group_tags (
  group_id TEXT NOT NULL REFERENCES asset_groups(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  PRIMARY KEY(group_id, tag_id)
);
CREATE TABLE asset_group_assets (
  group_id TEXT NOT NULL REFERENCES asset_groups(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, asset_id)
);
```

素材组至少包含一个素材成员；成员通过拖放或多选加入，移除成员不修改素材本身。

### 4.4 手动素材成员查询

```text
SELECT a.*
FROM assets a
JOIN asset_group_assets aga ON aga.asset_id = a.id
WHERE aga.group_id = ? AND a.deleted_at IS NULL
ORDER BY a.created_at ASC, a.id ASC;
```

最后使用 id 作为稳定次级排序，避免多个素材拥有相同创建时间时拖拽顺序漂移。

## 5. 领域类型与 IPC 合同

在 @ai-video/domain 定义持久化记录，在 @ai-video/contracts 定义桌面端可见 DTO。建议扩展 AssetInfo，并新增以下核心合同：

```text
AssetInfo { id, projectId, kind, alias, relativePath, sizeBytes,
            createdAt, updatedAt, deletedAt?, tags[], sourceJobId? }
AssetLibraryQuery { keyword?, kinds?, tagIds?, createdFrom?, createdTo?,
                    deleted?: 'active'|'trash', sort?: 'created-asc'|'created-desc',
                    cursor?, limit? }
AssetDragPayloadV1 { version: 1, projectId, sourceType, sourceId?,
                     snapshotAt, assets: [{ id, kind, createdAt }] }
```

| 方法                                 | 用途                 | 关键校验                         |
| ------------------------------------ | -------------------- | -------------------------------- |
| asset.library.query                  | 分页查询与筛选素材   | 项目作用域、limit 上限、日期格式 |
| asset.alias.update                   | 更新素材别名         | 可写、素材未删除、长度限制       |
| tag.list/create/update/delete        | 项目标签管理         | 名称唯一、创建者或管理员权限     |
| asset.tags.add/remove/replace        | 单个或批量分配标签   | 同项目、批量上限、事务原子性     |
| assetGroup.list/create/update/delete | 保存素材成员         | 至少一个素材、同项目             |
| assetGroup.resolve                   | 解析当前集合成员     | 成员存在、稳定升序               |
| asset.trash/restore/purge            | 回收站生命周期       | 引用提示、路径边界、补偿回滚     |
| asset.source.locate                  | 返回来源任务定位信息 | generation_results 关联存在      |

## 6. 服务层实现

### 6.1 自动入库

1. 生成适配器返回成功结果后，先下载或解码到项目内临时文件。
1. 校验 MIME、扩展名、大小、内容哈希与项目路径边界。
1. 使用原子重命名将临时文件移动到 assets/ 正式路径。
1. 在同一数据库事务中写入 assets 和 generation_results。
1. 事务失败时删除正式文件或回滚到临时文件；不得留下无记录资产。

> **行为变更** 产品合同要求成功素材自动入库。图片生成界面的“自动保存到本地素材库”开关应移除；若仍需要试生成能力，应作为独立的“仅预览”模式设计，不能复用素材库入库规则。

### 6.2 别名

新增 alias 字段后，素材库不再调用现有 asset.rename。磁盘文件名保持由系统生成，避免引用断裂、冲突和高成本文件移动。现有 asset.rename 可保留给兼容路径，但应从普通素材库界面移除，并在接口命名中明确为 fileRename。

### 6.3 回收站

1. 检查素材是否存在生产草稿引用；存在时返回引用数量并要求 confirm=true。
1. 将文件移动到 cache/deleted-assets/{assetId}{原扩展名}。
1. 更新 deleted_at 与 trash_relative_path，保留原 relative_path 和所有标签。
1. 恢复时校验原路径是否冲突；冲突时生成安全的新物理文件名，但别名不变。
1. 彻底删除时先删除文件，再清理素材记录；失败时保留记录并标记可重试。

### 6.4 来源定位

素材到任务的查询通过 generation_results.asset_id 反查 generation_jobs。任务日志打开素材时向桌面端传入 selectedAssetId；素材详情打开来源时传入 jobId 并切换到任务日志。失败任务没有 asset_id，因此不会进入素材库。

## 7. 拖拽协议

桌面端使用自定义 MIME application/x-ai-video-asset+json，并同时写入 text/plain 作为可调试回退。拖拽开始时，素材组先调用 resolve 得到当前成员，再构造静态快照。

```text
{
  "version": 1,
  "projectId": "project-uuid",
  "sourceType": "asset-group",
  "sourceId": "group-uuid",
  "snapshotAt": "2026-08-10T12:00:00.000Z",
  "assets": [
    { "id": "asset-a", "kind": "generated-image",
      "createdAt": "2026-08-10T10:00:00.000Z" }
  ]
}
```

| 落点         | 接收规则                                       | 落入后的处理                                 |
| ------------ | ---------------------------------------------- | -------------------------------------------- |
| 首尾帧生视频 | 仅图片；最多两项；同项目；素材未删除           | 依次填首帧和尾帧，允许交换、移除和替换       |
| 参考生视频   | 图片；数量遵循模型 Schema 上限                 | 按快照顺序加入参考列表，超限前提示           |
| 图片编辑     | 图片；数量遵循适配器要求                       | 填入 image/image_urls 等目标字段             |
| 通用素材槽   | 由字段 uiSchema 声明 acceptedKinds 与 maxItems | 写入 GenerationDraft 参数并保持 assetId 引用 |

- drop 时重新通过 Worker 校验素材存在、项目一致、未删除和文件可读。
- 拖入生产区域后只保存 assetId 与用户顺序；发送供应商前再解析为安全本地路径或上传输入。
- 重新排序只修改生产草稿，不修改素材组和素材创建时间。
- 素材随后进入回收站时，生产草稿保留引用但显示“素材不可用”，并提供恢复入口。

## 8. 桌面端组件计划

```text
apps/desktop/src/assets/
├─ AssetLibraryView.tsx
├─ AssetToolbar.tsx
├─ AssetGrid.tsx
├─ AssetCard.tsx
├─ AssetDetailsPanel.tsx
├─ TagManager.tsx
├─ AssetGroupList.tsx
├─ TrashView.tsx
├─ asset-drag.ts
└─ asset-library-client.ts
```

App 负责素材库工作区面板与 selectedAssetId 深链；用户点击一级菜单“素材库”后打开或激活唯一的素材库面板，保留当前已打开的其他项目资料页面，默认展示全部未删除素材。素材库使用统一工作区面板的停靠、拖拽排序、浮动、关闭和重新打开能力。素材库内部不创建第二层侧边栏。ProductionPanel 只保留当前生成结果预览和“查看素材库”入口，不继续维护完整素材列表。列表查询状态放在 AssetLibraryView，避免 ProductionPanel 继续扩大。

素材库面板布局按项目在本地保存，并兼容没有素材库面板字段的旧布局记录。切换项目时恢复目标项目布局，同时重置 AssetLibraryView 的搜索、筛选、选中项、详情与临时编辑状态；界面状态不得跨项目沿用。素材与项目数据继续保存在本地，GitHub 不承担运行时素材库或项目数据同步。

- “全部素材”“图片”“视频”实现为同一工具栏中的单选类型下拉菜单，共用 AssetGrid 和详情面板；用户切换后只刷新同一素材网格，并可继续叠加关键字、素材组、时间和排序条件。
- 顶部不提供单独标签筛选菜单。搜索框同时匹配素材别名、物理文件名和标签名称；标签列表仍用于详情编辑和批量打标签，标签 CRUD 通过详情区域的独立管理入口完成。
- “素材组”保留为筛选菜单；选择素材组后加载其明确保存的成员，素材组仍支持拖拽静态快照。
- “回收站”通过工具栏入口切换 deleted 状态，复用单页面结构和类型/时间筛选，不建立独立的素材库内部导航。

- 网格使用稳定的 1:1 预览区，图片和视频完整显示；卡片信息区紧凑排列，仅在有别名或标签时创建对应的信息行，底部保留日期与文件大小。
- 图片使用缩略图缓存并以 object-fit: contain 完整显示；视频通过经过 Worker 项目边界校验的本地媒体源，在卡片和详情中使用原生播放器预览，不将大视频编码进 IPC JSON。Tauri 使用本地资源协议，浏览器开发模式使用带会话令牌和 Range 支持的同源媒体流代理。
- 生成图片直接显示预览；角色/场景图片、镜头图片及参考图、生成结果和素材详情中的预览均完整显示画面。点击图片在当前页面放大查看，可通过关闭按钮、点击遮罩或 Esc 返回；一次生成多张图片时逐张预览。
- ProductionPanel 的图片文件参数对本地上传图片和 `asset://` 素材引用均使用 contain 完整缩略预览，并复用 ImagePreview 点击页内放大；保留文件名、文件大小，排序、替换、移除和清空后预览对应当前输入，继续保存原输入值与素材引用。
- 卡片不显示物理文件名；仅显示已设置的别名，单行超出省略并保留 title；标签以有限行展示，剩余数量用 +N 表示。无别名时卡片提供“图片素材/视频素材 + 当前序号”的无障碍名称；文件名继续用于搜索与详情路径。
- 多选支持 Ctrl/Shift、全选当前结果和批量标签操作；拖拽时显示选中数量。
- 所有图标按钮使用现有 lucide-react，并提供 title/aria-label。

## 9. 查询、分页与性能

| 项目       | MVP策略                                            | 扩展条件                           |
| ---------- | -------------------------------------------------- | ---------------------------------- |
| 分页       | 游标分页，默认 60 条；created_at + id 作为游标     | 素材超过 5,000 条后启用虚拟网格    |
| 关键字搜索 | alias、relative_path 与关联标签 name 使用 LIKE；输入 250ms 防抖 | 数据量或语言需求增长后评估 FTS5    |
| 素材组筛选 | 成员关联表索引直接解析素材 ID 集合                 | 使用 EXPLAIN QUERY PLAN 做回归门禁 |
| 缩略图     | cache/thumbnails/{hash}.webp，按需生成             | 容量压力时纳入维护清理             |
| 视频元数据 | 列表不读取完整文件；落盘时记录时长和尺寸可后续补列 | 悬停预览独立迭代                   |

## 10. 分阶段实施

| 阶段                   | 主要任务                                             | 完成门禁                               |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- |
| P0 基线与合同          | 冻结本方案；补充现有素材链路测试；记录大项目查询基线 | 现有生成、素材预览、打开和删除测试通过 |
| P1 v8 与资产服务       | 别名、软删除、恢复、查询分页、兼容旧接口             | 迁移 v7 项目无损；文件与事务故障可回滚 |
| P2 v9-v10/v40 标签与素材组 | 标签 CRUD、批量分配、成员维护和稳定解析           | 权限、唯一性、级联与查询计划测试通过   |
| P3 素材库 UI           | 独立工作区、网格、详情、搜索、筛选、多选、回收站     | 桌面组件测试和 390/1280/1440 布局通过  |
| P4 拖拽接入            | 载荷 v1、单个/多选/素材组拖拽、生产目标适配器、排序  | 跨项目、类型、数量、删除状态校验通过   |
| P5 日志联动与硬化      | 任务双向定位、缩略图、完整性检查、备份恢复           | 端到端、升级、崩溃恢复和发布门禁通过   |

> **建议节奏** 以一名熟悉现有代码的开发者估算，P1-P5 约需 12-18 个有效开发日；视觉细化、真实大素材库验证和 Windows 安装包回归另计。实际排期应按团队并行度和原型确认速度调整。

### 10.1 阶段验收记录（2026-08-12）

| 阶段 | 实施结果 | 验证记录 |
| ---- | -------- | -------- |
| P0 | 冻结合同并保留现有 `asset.*` 兼容面；成功结果继续由 Worker 自动入库 | 现有生成、素材预览、打开、删除及项目完整性测试通过 |
| P1 | Schema v8；别名与物理文件名分离；游标查询、软删除、恢复、引用确认与彻底删除完成 | v7-v10 迁移、稳定排序、分页、路径边界及文件/事务补偿测试通过 |
| P2 | Schema v9-v10/v40；标签 CRUD、批量分配、手动素材组成员关系及真实成员数完成 | 唯一性、项目隔离、标签关联、素材组成员解析与级联约束测试通过 |
| P3 | 单页面素材库 UI 完成；图片/视频类型使用单选下拉菜单，素材组继续筛选同一网格，顶部无标签筛选；搜索支持别名、文件名和标签名，回收站通过工具栏切换；多选、详情与标签管理闭环 | `AssetLibraryView` 6 项、`ProductionPanel` 23 项通过；类型下拉保持 `all/image/video` 查询合同，标签名搜索的项目隔离由持久层测试覆盖，图片完整显示和视频卡片/详情页内播放纳入自动化与浏览器视觉验收 |
| P4 | 版本化 MIME、单个/多选/素材组拖拽、生产目标校验、`asset://` 草稿引用及排序完成 | 跨项目、类型、数量、删除状态、草稿持久化与提交前解析测试通过 |
| P5 | 来源任务联动、哈希缩略图缓存、完整性检查与备份恢复保持完成；浏览器开发模式视频流代理完成 | 全量 TypeScript/JavaScript 222 项与 Rust 38 项通过；类型、Lint、格式、生产构建通过 |

2026-08-13 交互调整验证：素材类型筛选由三段按钮改为单选下拉菜单，默认值与 `all/image/video` 查询合同不变；真实项目中全部 9 项、图片 6 项、视频 3 项切换正确，`AssetLibraryView` 4 项测试通过，1440×900、1280×720 与 390×844 布局无控件越界、重叠或水平溢出。

2026-09-28 素材组语义调整验证：Schema v40 新增 `asset_group_assets`，素材组改为手动素材集合；支持 Pointer Events 拖入、将当前多选素材加入、编辑成员和稳定解析。数据库迁移 20 项、Worker 项目与素材服务 47 项、`AssetLibraryView` 7 项测试通过；同时保留 Windows WebView 原生拖放的 `text/plain` 回退路径。

2026-09-02 图片结果传输硬化验证：原生 Provider 桥在 Sidecar 2 MiB 上限之外接收并逐张外部化受控图片结果，兼容裸 Base64、Data URL、ASCII 空白和省略 padding 的标准 Base64；Worker 对临时路径、数量、大小、MIME 与文件签名进行复核，并将同次生成的全部结果以独立素材原子入库，任一结果失败时回滚文件和数据库写入。大图预览改为本地媒体地址，避免图片正文再次进入 JSONL。全量 TypeScript/JavaScript 524 项与 Rust 70 项通过；类型检查、Lint、格式检查、生产构建、Worker Sidecar 和 Windows NSIS 打包通过。

实施边界：缩略图写入 `cache/thumbnails/{contentHash}.{ext}`，属于可重建缓存；当前仓库没有图片编解码依赖，因此首版保留源尺寸与编码。素材“查看来源”定位到现有制作任务上下文并在可用时选中关联镜头；当前产品没有独立任务日志路由。

### 10.2 生成图片完整预览与页内放大（2026-10-12）

用户确认生成图片应直接显示预览，点击可放大，预览完整显示画面。继续沿用本地媒体源、原素材引用和既有入库规则。

- [x] V1 角色/场景图片与镜头参考图改为 contain 完整显示；镜头工作区按 shotId 显示已生成图片；一次生成多张时逐张预览。
- [x] V2 生成结果、角色/场景画廊、镜头图片/参考图和素材详情使用同一页内查看器，支持关闭按钮、遮罩、Esc、键盘焦点与返回；查看图片无需跳转素材库，也不要求项目可写。
- [x] V3 Desktop 聚焦 111 项、全仓 1010 项、Rust 129 项通过（1 项既有忽略）；typecheck、lint、format:check、git diff --check 及 tauri:build 通过。Edge 浏览器 1440×900、390×844 验证横/竖图 contain、放大窗口边界与零横向溢出；未发起付费 Provider 请求。详情见 [预览验证](./code-traces/2026-10-12-full-image-previews.md)。
- [x] V4 Markdown 与两份 DOCX 的交互要求同步，内容一致性检查通过。
- [ ] V5 文档版式验收：Windows 随附运行时没有 LibreOffice，render_docx.py 无法生成 PNG；DOCX 的渲染复核待可用渲染器。

### 10.3 素材库与项目资料并行打开 2026-10-13

用户确认素材库页面应能与其他项目资料页面同时打开。本次在 P0-P5 已完成基础上依次实施工作区面板接入、布局与项目隔离、回归验证，不改变素材库入库、手动素材组或拖拽快照规则。

- [x] W1 工作区面板接入：打开素材库时保留当前小说、剧本、角色与场景、场次与镜头、任务日志；支持并排停靠、拖拽排序、浮动、关闭和重新打开，并避免重复面板。
- [x] W2 布局与项目隔离：面板布局按项目本地保存，兼容旧布局记录；切换项目后重置素材搜索、筛选、选择、详情与临时编辑状态。
- [x] W3 回归验证：面板并行打开、停靠/浮动/关闭恢复、旧布局兼容与项目切换测试通过；素材组筛选启用时的素材深链加载回归、全仓测试与最终桌面构建通过，已执行检查及限制见下方记录。
- [x] W4 文档同步：两份 Markdown 与对应 DOCX 的确认要求一致；保留既有版式，已通过内容一致性、ZIP 完整性与 OOXML XML 结构检查。
- [ ] W5 文档版式验收：已尝试 render_docx.py；Windows 随附运行时未提供 LibreOffice，无法生成页面 PNG，视觉渲染复核待可用渲染器。

自动化验证：首次聚焦 8 个文件共 135 项测试通过；最终 `pnpm test` 全仓 1041 项通过（Desktop 337、Worker 563、persistence 52、generation 25、llm 32、contracts 24、context 8），包含素材组筛选启用时的素材深链加载回归；Rust `cargo test` 129 项通过、1 项既有忽略。全仓 `typecheck`、`format:check`、`pnpm build`、新增回归后的最终桌面端 `tsc -b` 与 Vite 构建、变更源码 ESLint 及 `git diff --check` 通过。

浏览器验证：使用真实 App 与隔离的内存示例数据，在 1440 和 1280 宽度下验证项目资料与素材库并排、页面及素材网格无水平溢出；390 宽度下通过工作区页签切换。窄屏切换时隐藏而不卸载面板，以保留未保存输入；同时修正窄素材卡片元数据、项目工具栏排版和镜头网格区块重叠。

验证边界：默认 `pnpm lint` 被既有且已忽略的临时目录 `.m2-ui-novel-open-goal/validate.cjs` 中 9 个 `no-undef` 错误阻塞；排除此目录后的 `pnpm exec eslint . --ignore-pattern '.m2-ui-novel-open-goal/**'` 通过。未执行原生窗口或付费生成端到端冒烟。IAB 中尝试素材卡片拖入镜头未触发 drop，因此未宣称该手工项通过；本次未修改素材拖放协议，沿用既有自动化测试。

### 10.4 文件参数预览 2026-10-15

用户确认素材库相关的上传文件参数应支持预览。本次在既有阶段完成的基础上，依次补齐生产区域本地图片和素材引用图片的完整缩略预览、页内放大与回归验证；沿用既有自动入库、拖拽快照、参数存储和本地优先边界。

- [x] F1 本地图片参数：保留文件名与文件大小，完整显示缩略图，点击复用 ImagePreview 页内放大，支持关闭按钮、遮罩与 Esc 返回。
- [x] F2 素材引用参数：`asset://` 图片引用直接显示完整缩略图并可放大；多项排序、替换、移除和清空后预览对应当前输入，保留原参数值与引用。
- [x] F3 回归验证：文件参数预览聚焦测试、390/320 宽度面板浏览器验收、全仓 TypeScript/JavaScript 与 Rust 测试、静态检查、生产构建和 Windows Tauri NSIS 打包通过，结果与边界见下方记录。
- [x] F4 文档同步：两份 Markdown 与对应 DOCX 的确认要求一致，保留既有版式并完成内容一致性、ZIP 完整性与 OOXML XML 结构检查。
- [ ] F5 文档版式验收：两份 DOCX 均已尝试 render_docx.py；随附运行时未提供 LibreOffice，诊断为找不到 soffice.exe，未生成页面 PNG；视觉渲染复核待可用渲染器。

自动化验证：`ProductionPanel` 34 项与 `ImagePreview` 2 项，共 36 项聚焦测试通过，另有素材库 10 项测试通过；`pnpm test` 全仓 1212 项通过（Desktop 355、Worker 679、persistence 60、generation 54、llm 32、contracts 24、context 8）；Rust 155 项通过、1 项既有忽略。全仓 `typecheck`、`lint`、`format:check`、`pnpm build` 与 `pnpm tauri:build` 通过，后者完成 Worker Sidecar、桌面生产构建与 Windows NSIS 安装包 `unicomp_0.1.0_x64-setup.exe`。

浏览器验证：使用真实 `ProductionPanel` 与隔离示例数据，在 390 与 320 宽度面板验证 960×360 横图与 360×960 竖图，64 px 缩略区域完整 contain 显示、点击页内放大与关闭均通过；输入行 `scrollWidth = clientWidth`，无水平溢出。已修正竖图固有高度撑出缩略区域的问题并复核。未发起付费请求，未修改真实项目数据。

### 10.5 场次目录与统一参考资料 2026-10-17

用户确认按场次组织镜头，并将角色与声音、场景参考和镜头参考统一为参考图卡片交互。本次在 P0-P5 已完成基础上依次实施目录、共享卡片与关联数据、回归验证和文档同步。

U1 已完成：目录按场次展开所属镜头，目录内移除场景绑定控件，选择场次或镜头分别显示对应编辑内容。

U2 已完成：场次和镜头共用参考卡片，场景在内容区选择与解除关联；镜头显示所属场次全部角色默认图和声音，保存角色修改回写所属场次，镜头图片覆盖与首帧保留。生成时使用全部已解析的角色图片，继承不会写成镜头覆盖。

U3 已完成：聚焦 109 项、全仓 1421 项 TypeScript/JavaScript 测试与 Rust 158 项通过（1 项既有忽略）；typecheck、lint、format:check、git diff --check、生产构建和 Windows NSIS 打包通过。浏览器使用隔离示例数据验证 1440、1280、390 宽度，无横向溢出，图片完整显示，多角色图片实际传入生成，场次和镜头拥有独立滚动区。

U4 已完成：本节及产品方案 4.3 已同步至对应 DOCX，内容一致性、ZIP 完整性与 OOXML XML 结构检查通过。实现和验证记录见 docs/code-traces/2026-10-17-unified-scene-shot-references.md。

- [ ] U5 文档版式待验收：两份 DOCX 已尝试 render_docx.py；环境缺少 LibreOffice soffice.exe，无法生成页面 PNG，尚未完成视觉渲染验收。

- [x] U6 首帧样式收敛（2026-10-18）：修正 U2 统一参考卡片的视觉差异。角色、场景、首帧与其他参考图共用标题、方形预览和紧随其后的图片选择控件，统一虚线边框；场景关联和声音选项排在图片选择下方。既有 26 项聚焦测试、40 项真实浏览器布局检查、Desktop 类型检查、变更源码 ESLint、格式检查、git diff --check 与生产构建通过。未变更已确认产品规则；详见 [验证记录](./code-traces/2026-10-18-reference-card-style.md)。

### 10.6 镜头衔接抽帧 2026-10-18

在既有 P0–P5 完成基础上，按 C0 合同、C1 本地选帧、C2 项目持久化与制作绑定、C3 人工交互与 LLM、C4 回归顺序实施。逐项状态及验收证据见 docs/SHOT-CONTINUITY-IMPLEMENTATION-PLAN.md。

预览候选帧完成读取即清理，不进入素材库。人工确认的原尺寸帧通过本地成功任务、图片素材及结果记录原子入库；失败清理文件并回滚记录，源视频保持不变。记录真实来源视频、哈希、人工时间点和基准帧；SQLite 保存衔接及可编辑提示词，沿用版本冲突与提交前来源复验。

确认画面后才允许 LLM 生成提示词。同机位直接绑定基准帧；换机位先参考生图并人工确认新构图，再生成视频。多张选帧用于 LLM 理解，实际视频输入仍按已确认首帧和所选模型 Schema 映射；缺少严格首帧能力时明确阻止本流程提交，不静默降级为普通参考。

衔接引用计入回收站确认及彻底删除保护。Markdown 与 DOCX 同步新增规则；版式验收结果单独记录，自动化测试不能替代真实付费视频的连贯质量验收。

### 10.7 素材预览卡片样式 2026-10-16

用户确认调整素材网格的预览卡片样式，不显示文件名。本次在既有阶段完成基础上，依次调整卡片展示、回归验证与文档同步。

- [x] C1 卡片展示：方形完整预览，移除物理文件名回退；仅显示已设置的单行别名和标签，底部保留创建日期与大小；保留选择、多选、拖拽和文件名搜索。
- [x] C2 聚焦验收：素材库 10 项测试通过；Edge 浏览器 1440、1280、800、390、320 宽度与浅色主题共 6 种布局通过，覆盖横图、竖图、方图、长别名、标签、选择、多选、键盘选择、改别名和文件名搜索，无横向溢出或浏览器错误。
- [x] C3 文档同步：两份 Markdown 与对应 DOCX 的确认要求同步，完成内容一致性、ZIP 完整性与 OOXML XML 结构检查。
- [x] C4 全仓门禁：2026-10-19 合并后按包顺序运行的 1566 项 JavaScript/TypeScript 测试、Rust 158 项测试（1 项既有忽略）、typecheck、lint、format:check、生产构建与 diff 检查通过；打包 Worker 冒烟通过。首次并行执行的既有大检索用例超时与本次合并验证详见文末记录；下方首次实施记录作为历史证据保留。
- [ ] C5 文档版式验收：两份 DOCX 已尝试随附 render_docx.py；运行时缺少 LibreOffice soffice.exe，无法生成页面 PNG，保留内容与结构已同步的源文档，版式待可用渲染器复核。

验证记录：首次全仓测试受大检索数据测试 5 秒超时阻塞；顺序执行 `pnpm -r --no-bail --workspace-concurrency=1 --if-present test` 后该项通过，累计 1281 项通过、3 项失败。失败为 `ProductionPanel` 两项与 `ShotWorkspace` 一项图片预览测试，均涉及当前工作区另行修改中的缩略图链路；素材库 10 项均通过。全仓 lint 另报 `AssetImagePreview.test.tsx`、`SceneWorkspace.test.tsx` 与 `scene-media.ts` 共 7 个错误；format:check 报本次范围外 16 个文件的格式问题。本次未改动这些其他工作，也未发起付费请求或修改真实项目数据。详见 [卡片验证](./code-traces/2026-10-16-asset-preview-cards.md)。

### 10.8 场次角色媒体预览 2026-10-16

- [x] S1 持久化与查询：Schema v48 独立保存图片／声音禁用标志，旧明确引用保留；场次批量查询最多 30 位角色、60 个已绑定图片 ID、30 个声音版本，并为每个角色返回默认图及至多 8 张近期候选图。来源查询使用项目及来源文档表达式索引，读取不改写场次。
- [x] S2 场次与生成输入：默认资源后补可见、本场覆盖与不使用、历史声音试听、按项目／角色过滤事件和迟到响应隔离；进入制作页解析有效图片，默认声音在制作页解析为实际版本，既有任务快照与提交校验继续有效。
- [x] S3 媒体开销：图片可见时请求最长边 320 像素的真实缩略图，相同内容合并并发请求并复用本地缓存；单服务保留两个排队通道，生产环境统一受进程共享 FFmpeg 并发上限 1 约束。放大才请求原图，角色图片页复用同一预览组件，声音点击后才请求文件。请求固定所属项目与会话，显式卸载时取消该项目缩略图处理。
- [x] S4 最终验收：全仓 1298 项 JavaScript/TypeScript 测试、Rust 155 项测试（1 项既有忽略）、typecheck、lint、format:check、diff 检查、生产构建及 Windows NSIS 打包通过；Edge 1440/390/320 宽度验收和打包 Worker 冒烟通过。两份 Markdown 与对应 DOCX 的内容、ZIP 完整性和 OOXML 结构已同步验证；详见 [实施记录](./code-traces/2026-10-16-scene-media-preview.md)。
- [ ] S5 文档版式验收：两份 DOCX 已尝试 render_docx.py，运行时缺少 LibreOffice soffice.exe，未生成页面 PNG；保留同步后的源文档，版式待可用渲染器复核。

验证记录：首次全仓并行测试触发既有大检索用例 5 秒超时；按包顺序执行 `pnpm -r --no-bail --workspace-concurrency=1 --if-present test` 后 1298 项全部通过，未调整测试阈值。浏览器验证初始仅请求缩略图、放大后才请求原图、点击后才读取音频，三个宽度均无页面／卡片横向溢出或浏览器错误。打包 Worker 验证 Schema v48、默认声音解析、明确禁用持久化、项目导出与完整性检查；生产依赖安全审计无已知漏洞，35 个包许可证检查通过。未发起付费请求，未修改真实项目数据。

兼容说明：旧版空媒体字段未记录“从未选择”与“主动清空”的区别，升级后统一解释为使用角色默认；本版明确选择“不使用”会单独持久化，重开后保持。

## 11. 测试计划

### 11.1 持久化与服务测试

- v7 → v8 → v9 → v10 顺序迁移、重复迁移与新库直建。
- 别名空值、超长、Unicode、同名和文件名不变。
- 标签名称归一化、项目隔离、批量事务、创建者权限。
- 标签名搜索及项目隔离、多标签 AND 查询、0 命中、重复标签、稳定排序和分页边界。
- 素材组成员加入/移除、素材删除和级联清理。
- 回收站移动失败、数据库失败、恢复冲突、彻底删除重试。
- 任务日志与素材来源双向定位。

### 11.2 桌面端测试

- 搜索防抖、标签名搜索、顶部无标签筛选控件、筛选组合、清空筛选和空状态。
- 别名编辑、批量打标签、素材组保存与命中数量。
- 单选、Ctrl/Shift 多选、键盘操作和焦点可见性。
- 拖拽单个、多选和素材组；首尾帧交换与超限提示。
- 回收站确认、恢复和只读项目禁用状态。
- 图片、视频、长别名、多标签与不同窗口尺寸的视觉回归。
- 素材库与各项目资料面板同时打开，停靠并排、拖拽排序、浮动、关闭和重新打开。
- 按项目保存与恢复素材库面板布局、旧布局兼容、同一面板重复点击，以及切换项目后素材界面状态清空。
- 图片文件参数的本地上传和素材引用均完整显示缩略图并支持页内放大；关闭按钮、遮罩、Esc、文件信息和排序、替换、移除、清空后的预览一致性。

### 11.3 端到端与发布门禁

1. 新建项目并生成多张图片和一个视频，确认仅成功结果自动入库。
1. 设置别名和标签，多选或拖入素材创建素材组并验证成员更新。
1. 将素材组拖入首尾帧或参考输入，调整顺序并保存草稿。
1. 从任务日志打开素材，再从素材详情返回来源任务。
1. 删除、恢复、备份项目、迁移目录并重新打开，确认标签与引用完整。
1. 运行 typecheck、lint、format:check、全量测试、Rust 测试和生产构建。

## 12. 风险与缓解

| 风险                            | 影响                               | 缓解措施                                               |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| 把别名继续当文件名              | 引用断裂、冲突、频繁移动大文件     | 新增 alias；素材库不调用物理重命名                     |
| SQLite 项目放入 GitHub 多人同步 | 数据库与二进制文件产生不可合并冲突 | GitHub仅管理代码；项目协作需独立同步协议               |
| 文件移动与事务不一致            | 产生孤儿文件或空记录               | 临时文件、原子移动、补偿回滚、完整性扫描               |
| 素材组成员被误改                | 生产结果不可预测                   | 拖拽时解析，落入后保存静态引用快照                     |
| 大素材库全量加载                | 启动慢、内存高、缩略图卡顿         | Worker分页、索引、缩略图缓存、后续虚拟网格             |
| 当前无成员身份                  | 无法真实执行创建者/管理员权限      | 第一版本地用户视为管理员；为未来 principal ID 预留字段 |
| WebView 拖拽差异                | Windows 上落点或 MIME 行为不稳定   | 封装 asset-drag、自动化测试加真实 Tauri 手工门禁       |

## 13. 发布与回滚

- 数据库迁移前执行项目 checkpoint 和备份；迁移失败保持原项目可恢复。
- 新素材库 UI 在内部版本先启用，旧 asset.list 保留一个发布周期。
- Schema 升级不可直接降级；回滚应用时应使用升级前备份，不尝试让旧版本打开新 Schema。
- 项目导出必须包含 project.sqlite、assets/ 和必要的回收站元数据；cache/thumbnails 可重建，不要求导出。
- 诊断包只包含脱敏元数据，不包含媒体内容、别名全文或标签名称，除非用户显式选择。

## 14. 完成定义

- 产品方案中的全部验收标准有自动化测试或明确人工验证步骤。
- 现有 v7 项目升级后素材文件、来源任务和生成结果不丢失。
- 别名、标签、素材组、拖拽、回收站和任务联动形成完整闭环。
- Worker 是唯一持久化写入者，桌面端不绕过路径和权限校验。
- 全量质量门禁通过，Windows Tauri 实机完成至少一次端到端冒烟。
- 更新项目实施文档、用户帮助和发布检查清单。

## 15. 推荐执行顺序

```text
P0 基线与合同
  → P1 别名 / 查询 / 回收站
  → P2 标签 / 素材组
  → P3 独立素材库 UI
  → P4 拖拽与生产目标
  → P5 日志联动 / 性能 / 发布硬化
```

> **实施冻结项** 不得将失败任务写入素材库，不得用别名移动物理文件，不得让素材组直接驱动已落入生产草稿的内容，不得使用 GitHub 作为运行时素材同步机制。

2026-10-17 统一并发 P5b 验证：图片/视频的提交与下载增加进程共享限额，多结果仍全部验收后原子入库，失败/取消/未知提交不进入素材库。别名、标签、手动组和静态拖拽引用的确认规则未改变。证据：[P5b 记录](./code-traces/2026-10-17-concurrency-p5b.md)。

## 并发任务实现更新

2026-10-17。统一并发计划已接入多项目运行上下文和按任务观察。激活另一项目或切换会话只改变界面订阅；显式卸载项目会停止该项目本地运行。任务和索引继续存储在本地项目 SQLite，GitHub 只管理源码和评审。

## 本地与远端合并验证

2026-10-19：保留本地素材卡片、场次媒体预览及其验证脚本，并与远端多项目运行上下文、统一参考卡片及镜头衔接功能合并。缩略图按项目和会话隔离、进入共享 FFmpeg 限额，项目卸载先取消处理再释放服务；重新打开同一项目不复用旧会话请求。相关自动化回归通过。

全仓按包顺序运行 1566 项 JavaScript/TypeScript 测试通过，Rust 158 项通过（1 项既有忽略）；typecheck、lint、format:check、Rust 格式、生产构建与 diff 检查通过。打包 Worker 在 Schema v56 验证角色声音、场次绑定、明确禁用、导出和完整性检查，未发起付费请求。首次 pnpm test 并行运行在既有 5000 条以上检索数据用例触发 5 秒超时；按包顺序执行全部通过，未放宽阈值。

两份 DOCX 保留双方新增章节、统一编号并同步检查项；ZIP、XML 与内容保留检查通过。当前运行时缺少 LibreOffice soffice.exe，版式渲染待验收，C5、S5 与 U5 保持未完成。详情见 [合并验证记录](./code-traces/2026-10-19-local-remote-reconciliation.md)。

图片、视频、配音、章节和文件任务拥有独立身份，并按依赖、目标锁、版本 CAS 和共享容量执行。人工确认按项目、任务和令牌排队；取消一项任务不否决其他任务。素材库仍仅展示成功且已落盘的图片或视频，失败和排队过程留在任务日志。

普通发送采用有序跟进，独立任务可显式并行，补充输入须指定目标任务并在轮次边界消费。历史和检索遵守已冻结的任务边界；正文按需读取，草稿、正式版本与未知提交状态明确区分。审核、发布、费用确认、声音版本、采用 take 和引用快照的原有规则保持有效。

阶段验证与尚待执行的发布验收以 docs/UNIFIED-TASK-CONCURRENCY-IMPLEMENTATION-PLAN.md 及 docs/code-traces/2026-10-17-concurrency-p3.md 至 concurrency-p5d.md 为准。模拟 Provider 测试不替代真实账号质量、Windows 休眠、旧版本升级或签名验收。
