# 素材库优化方案实施文档

> **Agent execution source.** 本文件与同目录 DOCX 方案对应；确认规则变化时必须同步更新两个版本。

## 执行状态

- [x] P0 基线与合同
- [x] P1 别名、查询与回收站
- [x] P2 标签与素材组
- [x] P3 独立素材库 UI
- [x] P4 拖拽与生产目标
- [x] P5 日志联动、性能与发布硬化

> 每完成一个阶段，更新本清单、阶段验收记录及相关测试结果。不得仅因代码已提交而勾选完成。

> 基于现有 Tauri、React、Worker 与 SQLite 架构的落地设计

> **版本：**v1.1　 **状态：**已实施
> **负责人：**研发 / 测试 / 产品　 **适用范围：**E:\xlngai\xlngaiforwindows

> **实施结论** 在现有项目 Schema v7 和 asset.* 能力上增量演进：先分离别名与文件名并建立软删除，再增加项目标签与动态素材组，最后用版本化拖拽载荷接入生产参数区域。所有写入仍由 Worker 串行完成，素材文件继续保存在项目本地目录。

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
- 数据库驱动筛选：搜索、标签 AND、素材组解析和回收站状态均由 Worker 查询，避免桌面端全量过滤。
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
| TagService          | 标签 CRUD、权限校验、批量分配                | 不保存素材组条件            |
| AssetGroupService   | 保存 AND 条件、动态解析、有序快照            | 不复制素材文件              |
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
```

素材组至少包含一个标签。标签被素材组引用时，普通删除操作应返回冲突信息，并要求用户先调整相关素材组或由管理员执行“删除并移除条件”。

### 4.4 动态 AND 查询

```text
SELECT a.*
FROM assets a
JOIN asset_tag_assignments ata ON ata.asset_id = a.id
WHERE a.project_id = ? AND a.deleted_at IS NULL
  AND ata.tag_id IN (?, ...)
GROUP BY a.id
HAVING COUNT(DISTINCT ata.tag_id) = ?
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
| assetGroup.list/create/update/delete | 保存标签组合         | 至少一个标签、同项目             |
| assetGroup.resolve                   | 解析当前动态结果     | 全部标签 AND、稳定升序           |
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

桌面端使用自定义 MIME application/x-ai-video-asset+json，并同时写入 text/plain 作为可调试回退。拖拽开始时，素材组先调用 resolve 得到当前动态结果，再构造静态快照。

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

App 负责素材库工作区路由与 selectedAssetId 深链；用户点击一级菜单“素材库”后直接进入唯一的素材库页面，默认展示全部未删除素材。素材库内部不创建第二层侧边栏。ProductionPanel 只保留当前生成结果预览和“查看素材库”入口，不继续维护完整素材列表。列表查询状态放在 AssetLibraryView，避免 ProductionPanel 继续扩大。

- “全部素材”“图片”“视频”实现为同一工具栏中的单选类型下拉菜单，共用 AssetGrid 和详情面板；用户切换后只刷新同一素材网格，并可继续叠加关键字、素材组、时间和排序条件。
- 顶部不提供单独标签筛选菜单。搜索框同时匹配素材别名、物理文件名和标签名称；标签列表仍用于详情编辑、批量打标签和素材组条件，标签 CRUD 通过详情区域的独立管理入口完成。
- “素材组”保留为筛选菜单；选择素材组后使用其标签 AND 条件刷新同一网格，素材组仍支持拖拽动态快照。
- “回收站”通过工具栏入口切换 deleted 状态，复用单页面结构和类型/时间筛选，不建立独立的素材库内部导航。

- 网格使用稳定的 aspect-ratio 和固定元数据区高度，避免别名和标签导致卡片跳动。
- 图片使用缩略图缓存并以 object-fit: contain 完整显示；视频通过经过 Worker 项目边界校验的本地媒体源，在卡片和详情中使用原生播放器预览，不将大视频编码进 IPC JSON。Tauri 使用本地资源协议，浏览器开发模式使用带会话令牌和 Range 支持的同源媒体流代理。
- 别名最长两行，超出省略并保留 title；标签以有限行展示，剩余数量用 +N 表示。
- 多选支持 Ctrl/Shift、全选当前结果和批量标签操作；拖拽时显示选中数量。
- 所有图标按钮使用现有 lucide-react，并提供 title/aria-label。

## 9. 查询、分页与性能

| 项目       | MVP策略                                            | 扩展条件                           |
| ---------- | -------------------------------------------------- | ---------------------------------- |
| 分页       | 游标分页，默认 60 条；created_at + id 作为游标     | 素材超过 5,000 条后启用虚拟网格    |
| 关键字搜索 | alias、relative_path 与关联标签 name 使用 LIKE；输入 250ms 防抖 | 数据量或语言需求增长后评估 FTS5    |
| 素材组筛选 | 关联表索引 + GROUP BY/HAVING 执行标签 AND 条件     | 使用 EXPLAIN QUERY PLAN 做回归门禁 |
| 缩略图     | cache/thumbnails/{hash}.webp，按需生成             | 容量压力时纳入维护清理             |
| 视频元数据 | 列表不读取完整文件；落盘时记录时长和尺寸可后续补列 | 悬停预览独立迭代                   |

## 10. 分阶段实施

| 阶段                   | 主要任务                                             | 完成门禁                               |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- |
| P0 基线与合同          | 冻结本方案；补充现有素材链路测试；记录大项目查询基线 | 现有生成、素材预览、打开和删除测试通过 |
| P1 v8 与资产服务       | 别名、软删除、恢复、查询分页、兼容旧接口             | 迁移 v7 项目无损；文件与事务故障可回滚 |
| P2 v9-v10 标签与素材组 | 标签 CRUD、批量分配、AND 查询、动态解析              | 权限、唯一性、级联与查询计划测试通过   |
| P3 素材库 UI           | 独立工作区、网格、详情、搜索、筛选、多选、回收站     | 桌面组件测试和 390/1280/1440 布局通过  |
| P4 拖拽接入            | 载荷 v1、单个/多选/素材组拖拽、生产目标适配器、排序  | 跨项目、类型、数量、删除状态校验通过   |
| P5 日志联动与硬化      | 任务双向定位、缩略图、完整性检查、备份恢复           | 端到端、升级、崩溃恢复和发布门禁通过   |

> **建议节奏** 以一名熟悉现有代码的开发者估算，P1-P5 约需 12-18 个有效开发日；视觉细化、真实大素材库验证和 Windows 安装包回归另计。实际排期应按团队并行度和原型确认速度调整。

### 10.1 阶段验收记录（2026-08-12）

| 阶段 | 实施结果 | 验证记录 |
| ---- | -------- | -------- |
| P0 | 冻结合同并保留现有 `asset.*` 兼容面；成功结果继续由 Worker 自动入库 | 现有生成、素材预览、打开、删除及项目完整性测试通过 |
| P1 | Schema v8；别名与物理文件名分离；游标查询、软删除、恢复、引用确认与彻底删除完成 | v7-v10 迁移、稳定排序、分页、路径边界及文件/事务补偿测试通过 |
| P2 | Schema v9-v10；标签 CRUD、批量分配、标签 AND 查询、动态素材组及真实命中数完成 | 唯一性、项目隔离、标签关联、素材组解析与级联约束测试通过 |
| P3 | 单页面素材库 UI 完成；图片/视频类型使用单选下拉菜单，素材组继续筛选同一网格，顶部无标签筛选；搜索支持别名、文件名和标签名，回收站通过工具栏切换；多选、详情与标签管理闭环 | `AssetLibraryView` 4 项、`ProductionPanel` 23 项通过；类型下拉保持 `all/image/video` 查询合同，标签名搜索的项目隔离由持久层测试覆盖，图片完整显示和视频卡片/详情页内播放纳入自动化与浏览器视觉验收 |
| P4 | 版本化 MIME、单个/多选/素材组拖拽、生产目标校验、`asset://` 草稿引用及排序完成 | 跨项目、类型、数量、删除状态、草稿持久化与提交前解析测试通过 |
| P5 | 来源任务联动、哈希缩略图缓存、完整性检查与备份恢复保持完成；浏览器开发模式视频流代理完成 | 全量 TypeScript/JavaScript 222 项与 Rust 38 项通过；类型、Lint、格式、生产构建通过 |

2026-08-13 交互调整验证：素材类型筛选由三段按钮改为单选下拉菜单，默认值与 `all/image/video` 查询合同不变；真实项目中全部 9 项、图片 6 项、视频 3 项切换正确，`AssetLibraryView` 4 项测试通过，1440×900、1280×720 与 390×844 布局无控件越界、重叠或水平溢出。

2026-09-02 图片结果传输硬化验证：原生 Provider 桥在 Sidecar 2 MiB 上限之外接收并逐张外部化受控图片结果，兼容裸 Base64、Data URL、ASCII 空白和省略 padding 的标准 Base64；Worker 对临时路径、数量、大小、MIME 与文件签名进行复核，并将同次生成的全部结果以独立素材原子入库，任一结果失败时回滚文件和数据库写入。大图预览改为本地媒体地址，避免图片正文再次进入 JSONL。全量 TypeScript/JavaScript 524 项与 Rust 70 项通过；类型检查、Lint、格式检查、生产构建、Worker Sidecar 和 Windows NSIS 打包通过。

实施边界：缩略图写入 `cache/thumbnails/{contentHash}.{ext}`，属于可重建缓存；当前仓库没有图片编解码依赖，因此首版保留源尺寸与编码。素材“查看来源”定位到现有制作任务上下文并在可用时选中关联镜头；当前产品没有独立任务日志路由。

## 11. 测试计划

### 11.1 持久化与服务测试

- v7 → v8 → v9 → v10 顺序迁移、重复迁移与新库直建。
- 别名空值、超长、Unicode、同名和文件名不变。
- 标签名称归一化、项目隔离、批量事务、创建者权限。
- 标签名搜索及项目隔离、多标签 AND 查询、0 命中、重复标签、稳定排序和分页边界。
- 素材组动态加入/退出、标签删除冲突和级联清理。
- 回收站移动失败、数据库失败、恢复冲突、彻底删除重试。
- 任务日志与素材来源双向定位。

### 11.2 桌面端测试

- 搜索防抖、标签名搜索、顶部无标签筛选控件、筛选组合、清空筛选和空状态。
- 别名编辑、批量打标签、素材组保存与命中数量。
- 单选、Ctrl/Shift 多选、键盘操作和焦点可见性。
- 拖拽单个、多选和素材组；首尾帧交换与超限提示。
- 回收站确认、恢复和只读项目禁用状态。
- 图片、视频、长别名、多标签与不同窗口尺寸的视觉回归。

### 11.3 端到端与发布门禁

1. 新建项目并生成多张图片和一个视频，确认仅成功结果自动入库。
1. 设置别名和标签，创建包含两个标签的素材组并验证动态更新。
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
| 动态素材组改变已在用内容        | 生产结果不可预测                   | 拖拽时解析，落入后保存静态引用快照                     |
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

> **实施冻结项** 不得将失败任务写入素材库，不得用别名移动物理文件，不得让动态素材组直接驱动已落入生产草稿的内容，不得使用 GitHub 作为运行时素材同步机制。
