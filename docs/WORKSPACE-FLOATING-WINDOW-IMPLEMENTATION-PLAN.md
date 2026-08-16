# IDE 工作区浮窗实施计划

版本：0.2

日期：2026-08-15

状态：实施中（应用内浮窗与 Tauri 独立窗口已落地，待原生交互人工验收）

## 1. 计划目的

将当前固定的文档编辑区与右侧会话栏升级为 IDE 风格工作区。文档和会话既可作为应用内浮窗打开、移动、缩放、最大化、还原、关闭并重新停靠，也可分离为普通 Tauri 操作系统窗口，在主界面之外移动、跨显示器摆放、缩放、最小化和最大化。不实现应用内置顶或操作系统级 `always-on-top`。

本计划只调整 Desktop 的呈现与布局状态，不改变本地优先架构、项目 SQLite 业务数据、会话/LLM IPC 合同或素材库运行时存储边界。

## 2. 已确认的产品决策

| 决策 | 结论 |
|---|---|
| 窗口类型 | 保留应用内普通浮窗，并支持分离为普通 Tauri 操作系统窗口；不使用系统级 `always-on-top` |
| 层级行为 | 点击浮窗后提升到其他普通浮窗上方；没有图钉、置顶或永久最高层 |
| 首批面板 | 文档编辑器、会话面板 |
| 关闭语义 | 关闭只关闭视图；不删除文档或会话，不自动取消后台 generation |
| 布局持久化 | 按项目保存到本地 Desktop 偏好；不写入项目 SQLite，不参与备份或导出 |
| 小屏策略 | 窄屏禁用自由浮窗，退化为单面板/标签式工作区 |
| 交互边界 | 应用内浮窗受主工作区边界约束；独立窗口使用操作系统边界，可离开主界面和跨显示器移动 |
| 状态所有权 | Worker 是唯一持久化写入者；主窗口按窗口实体管理临时编辑缓冲，独立窗口只渲染快照并通过 Tauri 事件转发操作 |
| 单实例 | 同一项目、同一面板实体只允许一个独立系统窗口；重复打开时聚焦现有窗口 |
| 项目切换 | 切换或关闭项目时关闭旧项目独立窗口，并拒绝陈旧窗口事件 |

## 3. 当前基线

当前 Desktop 结构：

- `apps/desktop/src/App.tsx` 统一持有项目、文档、会话、LLM generation 和导航状态；
- `apps/desktop/src/ChatPanel.tsx` 固定渲染为右侧 `aside`；
- 文档编辑器固定渲染在 `App.tsx` 的中心 `main.workspace`；
- `apps/desktop/src/styles.css` 已有三栏布局与窄屏响应式规则，但没有窗口几何、焦点或停靠状态；
- 现有依赖没有拖动、缩放或停靠库。

现有会话状态隔离、generation 重启恢复和请求版本保护见 [SESSION-ENTERPRISE-OPTIMIZATION-PLAN.md](SESSION-ENTERPRISE-OPTIMIZATION-PLAN.md)。工作区改造必须复用这些业务状态，不能复制或绕过它们。

## 4. 目标布局

```text
┌─────────────────────────────────────────────────────────────────┐
│ 应用标题栏与项目操作                                               │
├───────────────┬─────────────────────────────────────────────────┤
│ 项目导航      │ 工作区表面                                        │
│ 文档/场次/镜头│  ┌───────────────┐  ┌─────────────────────────┐ │
│ 素材/生产方式 │  │ 文档浮窗       │  │ 会话浮窗                │ │
│               │  │ 可移动、缩放   │  │ 可移动、缩放            │ │
│               │  └───────────────┘  └─────────────────────────┘ │
│               │  停靠文档标签 / 分栏 / 当前生产工作区             │
├───────────────┴─────────────────────────────────────────────────┤
│ 项目状态、保存状态、后台 generation 状态                           │
└─────────────────────────────────────────────────────────────────┘
```

层级固定为：

```text
工作区内容 < 停靠面板 < 普通浮窗 < 菜单/提示 < 模态对话框
```

不允许业务组件自行声明任意 `z-index`。统一由工作区层级令牌管理，模态对话框必须始终高于浮窗。

## 5. 交互与业务规则

### 5.1 打开与聚焦

- 项目树点击文档：若该文档已打开，聚焦已有标签或浮窗；否则按用户上次模式打开。
- 会话入口点击：显示当前作用域会话；若已有会话浮窗，聚焦并提升层级，不创建重复面板。
- 首次默认值建议：文档在中心停靠标签打开，会话以右侧浮窗打开；用户可通过面板标题栏的停靠/浮动按钮改变，之后记住选择。
- 一个面板在同一项目内只能有一个实例：`document:<documentId>`、`conversation:<scopeType>:<scopeId?>`。

### 5.2 浮窗

- 文档最小尺寸：`560 x 400`；会话最小尺寸：`360 x 420`。
- 最大尺寸不得超出工作区可用区域；最大化仅填满工作区表面，不影响 Tauri 主窗口状态。
- 拖动标题栏移动，拖动八个方向的边缘或角落缩放。
- 新浮窗按 24px 阶梯偏移，避免完全重叠。
- 点击浮窗提升其普通层级；层级值定期归一化，防止长期递增溢出。
- 浏览器缩放、主窗口缩放或显示器变化后，使用最小可见标题栏规则校正位置。

### 5.3 停靠与关闭

- 首期支持“停靠回中心”和“停靠到右侧”；后续增加拖拽到左/右/底部的可视投放区。
- 关闭文档浮窗前，若存在未保存编辑内容，显示保存、放弃、取消三选项。
- 关闭会话浮窗不取消 native/legacy generation；后台状态继续由现有状态栏和会话轮询维护。
- 提供“平铺浮窗”“全部停靠”“恢复默认布局”三个明确命令。

### 5.4 窄屏与无障碍

- 工作区可用宽度小于 `900px` 时，不渲染自由浮窗；已打开面板转换为当前活动标签或全尺寸覆盖面板。
- 所有标题栏图标按钮提供可访问名称和 tooltip；焦点不可被隐藏浮窗截获。
- 拖动与缩放必须支持指针取消、失焦和窗口尺寸变化，不依赖鼠标专有事件。

### 5.5 操作系统独立窗口

- 文档和会话标题栏及工作区命令栏提供“在独立窗口打开”入口。
- 独立窗口使用普通系统窗口装饰，支持移动、缩放、最小化、最大化和跨显示器摆放。
- 创建参数必须显式设置 `alwaysOnTop: false`；不提供置顶、图钉或应用内最高层能力。
- 独立窗口通过稳定 Tauri label 去重；重复请求显示并聚焦已有窗口，不创建重复实例。
- 子窗口不直接调用 Worker、SQLite 或 LLM 服务；主窗口发送业务快照，子窗口只发送用户动作。
- 子窗口关闭只关闭视图，不取消 generation、不删除会话、不丢弃文档状态；关闭后主窗口恢复对应面板入口。
- “附加”操作关闭子窗口、聚焦主窗口并重新打开应用内面板。
- 主窗口仅处理当前登记 label 的事件；项目切换或关闭时清理旧窗口，陈旧窗口不能修改新项目。

## 6. 架构设计

### 6.1 状态模型

新增仅用于 UI 的布局状态，和项目业务数据严格分离：

```ts
type WorkspacePanelKind = 'document' | 'conversation';
type PanelMode = 'docked' | 'floating' | 'maximized';
type DockTarget = 'center' | 'right';

interface FloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorkspacePanelState {
  id: string;
  kind: WorkspacePanelKind;
  mode: PanelMode;
  dockTarget?: DockTarget;
  bounds?: FloatingBounds;
  zOrder: number;
  openedAt: number;
}

interface WorkspaceLayoutState {
  version: 1;
  projectId: string;
  activePanelId?: string;
  panels: WorkspacePanelState[];
  centerTabs: string[];
  rightDockTabs: string[];
}
```

文档内容状态单独建模为 `DocumentEditorState`，按文档 ID 管理草稿、脏状态、保存状态、版本列表和请求版本。不得用多个浮窗各自持有同一文档的内容副本。

### 6.2 建议目录

```text
apps/desktop/src/workspace/
  workspace-types.ts
  workspace-reducer.ts
  workspace-storage.ts
  workspace-geometry.ts
  use-workspace-layout.ts
  WorkspaceSurface.tsx
  DockHost.tsx
  FloatingWindow.tsx
  PanelChrome.tsx
  workspace.css

apps/desktop/src/documents/
  DocumentEditorPanel.tsx
  use-document-editors.ts

apps/desktop/src/conversations/
  ConversationPanel.tsx
```

`ChatPanel` 先迁移为可嵌入的 `ConversationPanel`，保留全部现有回调合同。`App.tsx` 只保留项目级服务编排和工作区装配，不继续承载浮窗几何与文档草稿细节。

### 6.3 拖动与缩放实现决策

阶段 P0 做小型技术验证：优先使用与 React 19 兼容的成熟拖动/缩放组件，仅将几何和焦点状态保存在本地 reducer；不引入完整 IDE 布局框架。验证范围包括触摸板、鼠标、窗口缩放、焦点、测试环境和许可证。

若候选库无法满足可访问性、React 19 兼容性或包体积要求，使用 Pointer Events 实现受限的标题栏拖动和边缘缩放。无论实现路径如何，停靠规则和业务状态均不得绑定到第三方库 API。

### 6.4 持久化与恢复

- 存储键：`ai-video.workspace-layout.v1:<projectId>`。
- 仅保存面板身份、模式、标签顺序、尺寸和位置；不保存文档正文、会话消息、Provider 选择、凭据或 generation 内容。
- 布局写入在拖动/缩放结束后和 200ms 防抖后执行；解析失败、版本不兼容或越界时回退默认布局。
- 项目切换时保存旧项目布局、取消旧布局的动画/拖动状态、加载新项目布局，并复用现有请求版本保护避免旧异步数据渲染到新项目。

## 7. 实施阶段

### P0：工作区状态与技术验证

目标：确认拖动/缩放实现方案，建立独立且可测试的布局状态机。

- 定义面板 ID、布局 state、动作、默认布局和序列化 schema。
- 实现 reducer：打开、关闭、聚焦、浮动、停靠、最大化、还原、移动、缩放、平铺、重置。
- 实现边界裁剪、最小尺寸、层级归一化和重复面板去重。
- 验证候选依赖，记录最终选型和许可证；未通过则使用 Pointer Events 后备方案。

退出门槛：Reducer 单元测试覆盖所有动作、无效 bounds、重复打开、最大化还原和项目切换隔离。

### P1：工作区表面与浮窗容器

目标：在不改变业务功能的前提下，提供通用浮窗基础设施。

- 从 `App.tsx` 抽出 `WorkspaceSurface`，明确标题栏、项目导航、工作区表面和状态栏边界。
- 实现 `FloatingWindow` 与 `PanelChrome`：标题、图标、关闭、浮动/停靠、最大化/还原。
- 接入拖动、八方向缩放、焦点提升、工作区边界约束和主窗口 resize 校正。
- 建立统一 z-index token，删除相关组件的局部浮层硬编码。

退出门槛：示例面板在 1280x720、1440x900、390x844 下无越界、重叠错误或不可点击区域。

### P2：会话浮窗迁移

目标：将固定右栏 `ChatPanel` 转换为可嵌入会话面板。

- 将 `ChatPanel` 重构为无布局假设的 `ConversationPanel`，保持现有会话、上下文、LLM、取消和重试回调。
- 会话入口打开或聚焦当前作用域对应的唯一会话面板。
- 支持会话浮动、停靠右侧、最大化与关闭视图；generation 继续运行。
- 切换项目/场次/镜头/会话时复用现有 request version 和 generation identity 校验。

退出门槛：流式输出、取消、重试、会话切换和关闭浮窗期间不丢消息、不串会话、不重复启动 native stream。

### P3：文档标签与文档浮窗迁移

目标：支持多个文档标签和单实例文档编辑模型。

- 从 `App.tsx` 抽出 `DocumentEditorPanel` 与 `useDocumentEditors`。
- 项目树打开文档时创建或聚焦标签，不重复请求或复制草稿。
- 文档可从中心标签浮动、最大化、停靠；关闭脏文档时执行保存确认。
- 版本历史、Markdown 导入、保存新版本和只读状态保持原有语义。

退出门槛：同时打开多个文档、保存、版本恢复、导入、项目切换和关闭确认均有自动化测试。

### P4：停靠、布局命令与持久化

目标：使浮窗和标签形成可恢复的工作区，而不是一次性弹层。

- 支持中心/右侧停靠、回到浮窗、平铺、全部停靠和恢复默认布局。
- 接入 per-project 布局持久化、schema 版本和损坏恢复。
- 后续增强：拖动到左/右/底部时显示有限投放区；不实现自由嵌套分割树。
- 提供项目关闭、只读项目、窗口尺寸变化和窄屏退化的可靠处理。

退出门槛：重启应用和切换两个项目后布局准确恢复，损坏存储可回退默认值，窄屏不出现浮窗越界。

### P5：性能、可访问性和质量门禁

目标：在多面板和长会话条件下保持稳定。

- 仅渲染可见/活动面板；长消息列表采用虚拟化或等效的有界渲染策略。
- 验证焦点管理、按钮名称、tooltip、键盘焦点可见性和 Pointer Events 取消路径。
- 补充 Desktop 单元、交互和端到端测试；使用 Playwright 截图检查桌面/窄屏布局。
- 更新 [QUALITY-GATES.md](QUALITY-GATES.md)、[M2-DOCUMENTS-CONVERSATIONS.md](M2-DOCUMENTS-CONVERSATIONS.md) 和相关 UI 文档。

退出门槛：全仓测试、类型检查、Lint、Prettier、Desktop 构建和目标视口截图检查全部通过。

### P6：Tauri 操作系统独立窗口

目标：让文档和会话可以脱离主界面，成为普通操作系统窗口，同时保持单一业务状态源。

- 定义独立窗口配置、快照、动作和 Tauri 事件信封协议。
- 使用稳定 label 创建或聚焦 `WebviewWindow`，显式禁用 `alwaysOnTop`。
- 实现文档与会话子窗口视图，以及关闭、附加、保存、发送、取消、重试等动作转发。
- 主窗口维护业务状态并向子窗口推送快照；子窗口不复制 Worker/SQLite/LLM 状态机。
- 文档窗口按 `projectId + documentId + label` 注册，同一文档复用窗口，不同文档允许并行打开；每个保存、审核和发布动作仍通过 Worker 版本 CAS。
- 快照与动作携带项目、实体和递增序号；项目切换时关闭旧项目子窗口，主窗口拒绝未注册、陈旧、跨项目或跨实体动作，子窗口丢弃旧序号快照。
- 补充窗口协议、子窗口渲染和动作转发测试，并通过 Tauri 权限、TypeScript 与 Rust 编译检查。

退出门槛：自动化门禁通过；在真实 Tauri 运行中人工确认文档和会话可离开主界面、移动、缩放、最小化、最大化、聚焦单实例、关闭和重新附加，且关闭会话窗口不取消 generation。

## 8. 验收矩阵

| 场景 | 必须满足的结果 |
|---|---|
| 点击已打开文档/会话 | 聚焦已有实例，不创建重复浮窗或重复加载 |
| 浮窗拖动与缩放 | 尺寸满足最小值，标题栏始终保留在工作区可见范围 |
| 两个浮窗相互点击 | 当前窗口置于其他普通浮窗上方，无置顶语义 |
| 关闭会话浮窗时生成中 | generation 继续，重新打开可得到同一 generation 状态 |
| 关闭脏文档 | 明确保存、放弃、取消；取消不改变布局或文档内容 |
| 文档多标签 | 同一文档只存在一个编辑状态与一条保存链路 |
| 项目切换 | 旧项目布局不影响新项目，旧异步响应不污染当前面板 |
| 分离文档/会话 | 创建普通操作系统窗口，可离开主界面并由系统移动、缩放、最小化和最大化 |
| 重复分离同一面板 | 聚焦现有独立窗口，不创建重复系统窗口 |
| 关闭/附加独立窗口 | 业务状态保留；关闭后主界面可重新打开，附加后主窗口获得焦点 |
| 独立窗口期间切换项目 | 旧窗口关闭，旧 label 发出的动作被主窗口拒绝 |
| 横向停靠多个页面 | 页面顶满可用高度，相邻页面共用一条分隔线，拖动只改变相邻页面宽度 |
| 关闭、浮动或分离停靠页 | 该页退出分栏，左右相邻页立即填充释放的空间 |
| 调整主窗口宽度 | `1150px` 以下生产页优先保留并自动收起会话；`900px` 以下退化为单活动页面 |
| 切换项目后恢复布局 | 项目导航宽度和工作区页面比例按项目从本地偏好恢复 |
| 异常退出/损坏布局 | 启动时恢复可用默认布局，不阻止项目打开 |
| 1280x720 和 390x844 | 无文字溢出、控件重叠、横向滚动或不可操作浮窗 |
| 模态确认框 | 始终显示在普通浮窗之上，背景浮窗不可误操作 |

## 9. 非目标

- 不实现独立窗口的系统级置顶、图钉、窗口分组或自定义任务栏管理。
- 不实现独立窗口之间的自由业务状态同步；主窗口只维护按实体隔离的临时窗口缓冲，Worker 仍是唯一持久化业务状态源。
- 不在本阶段持久化独立窗口的操作系统坐标、尺寸或显示器归属。
- 不实现应用内置顶、系统级置顶、窗口阴影特效或任意 z-index 配置。
- 不在本轮将素材库、生产参数、设置中心全部迁移为浮窗；它们只需保持与新工作区共存。
- 不改变 Worker、SQLite schema、项目备份/导出格式或会话/LLM 业务规则。
- 不实现协作编辑、多个编辑者冲突合并或云端布局同步。

## 10. 审核事项

1. 是否确认首次默认布局为“文档中心标签、会话右侧浮窗”，并允许用户改变后记住？
2. 是否确认布局按项目保存在本机偏好中，而不进入项目备份和导出？
3. 是否确认第一期只支持中心/右侧停靠，左侧和底部拖放作为后续增强？
4. 是否确认窄屏以单面板/标签模式替代自由浮窗？
5. 是否同意先完成文档与会话，素材库和生产参数后续复用同一工作区框架？

## 11. 完成定义

只有以下条件全部满足，才可将本计划标记为完成：

- 文档和会话均可作为普通应用内浮窗使用，并可安全停靠和恢复；
- 文档和会话均可分离为普通 Tauri 操作系统窗口，并可安全关闭和附加；
- 工作区布局按项目持久化，损坏状态可恢复；
- 流式 generation、文档保存、版本恢复和项目切换在多面板下保持既有业务不变量；
- 桌面和窄屏交互无越界、重叠、焦点丢失或数据丢失；
- 新增测试与全仓 `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 全部通过；
- 文档、测试和质量门禁记录同步更新。

## 12. 实施记录

2026-08-15 Workspace interaction follow-up:
- Implemented project-scoped pane ordering for editor, production, and conversation pages.
- Added Pointer Events tab dragging with insertion indicators and localStorage persistence.
- Added edge-zone detection that arms document/conversation system-window detachment; production remains reorderable and cannot detach through this gesture.
- Added cancellation and regression coverage; `WorkspaceSurface.test.tsx` now passes 10 tests.
- The native Tauri window bridge remains the owner of actual system-window creation and is intentionally unchanged in this UI phase.

2026-08-15 Pane-header layout follow-up:
- Replaced the global workspace tab strip with one real page header per docked pane.
- Each pane header now owns its page title, drag handle, and applicable system-window action; no synthetic group labels are rendered.
- Docked content remains full-height beneath its own header and adjacent panes retain a shared resize separator.

2026-08-15 首批实施：

- 已完成 P0 基础状态：新增项目级本地布局状态、边界裁剪、层级归一化、最大化还原和损坏本地偏好回退；布局键为 `ai-video.workspace-layout.v1:<projectId>`，不写入项目 SQLite、备份或导出。
- 已完成 P1 通用容器：`WorkspaceSurface` 以工作区表面为坐标系承载普通浮窗；`FloatingWindow` 使用 Pointer Events 提供标题栏拖动、八方向缩放、聚焦提升、最大化、还原、关闭和停靠。没有 Tauri 子窗口、图钉或 always-on-top。
- 已完成 P2 会话迁移：原固定右栏已移除；同一个 `ChatPanel` 作为会话浮窗或右侧停靠内容渲染。关闭会话只隐藏视图，不触发 generation 取消。
- 已完成 P3 基础文档迁移：当前文档可从中心工作区浮动、停靠、最大化、还原和关闭；关闭脏文档显示“保存并关闭 / 放弃更改 / 取消”。多文档标签和按文档 ID 的草稿模型仍属于后续 P3 工作，未标记完成。
- 已完成 P4 基础持久化与窄屏退化：支持平铺、恢复默认布局、项目级恢复和 `900px` 以下的单活动面板模式；窄屏不保留可拖拽、可缩放自由浮窗。
- 新增 reducer、持久化和浮窗控制测试；本地浏览器预览验证了 `1280x720` 桌面工作区内拖动，以及 `390x844` 下仅渲染当前全屏面板。全仓门禁结果记录在本次实施完成后更新。
- 本轮门禁：`pnpm test`（Desktop 14 个测试文件、72 项；Worker 17 个测试文件、124 项）、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml` 和 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`（41 项 Rust 测试）均通过。

2026-08-15 操作系统独立窗口实施：

- 已完成 P6 代码实现：新增独立窗口协议与稳定 label、文档/会话子窗口入口、快照下发、动作转发、单实例聚焦和重新附加。
- Tauri capability 已允许受控创建、显示、聚焦和关闭工作区子窗口；子窗口显式使用 `alwaysOnTop: false`，没有置顶能力。
- Worker 保持唯一持久化业务状态源，主窗口负责窗口级临时缓冲；子窗口关闭不取消 generation。项目切换会关闭旧项目子窗口，主窗口拒绝非当前登记 label 的陈旧动作。
- 新增 `detached-window` 与 `DetachedPanelApp` 测试；全仓 `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、Rust fmt 和 41 项 Rust 测试均通过。Desktop 当前为 16 个测试文件、75 项测试，Worker 为 17 个测试文件、124 项测试。`tauri build --debug` 也已通过并生成 NSIS 安装包。
- 原生 `cargo run` 已确认应用可启动。当前 Windows Graphics Capture/Computer Use 对该 WebView2 窗口返回 `0x80004002`，无法在本轮自动执行真实鼠标交互，因此“移动、缩放、最小化、最大化、跨主界面、重新附加”的原生人工验收仍保持未完成，不据此宣称总体完成。

2026-08-16 文档独立窗口隔离补强：

- 文档独立窗口改为按项目、文档实体和稳定 label 注册；不同文档可同时打开，主界面切换当前文档不再向其他窗口推送错误正文。
- 子窗口快照和动作事件增加项目、实体和递增序号校验；子窗口忽略旧快照，主窗口拒绝未注册或实体不一致的动作。
- 独立文档窗口使用主窗口持有的每文档临时编辑缓冲，保存、审核、退回修改、恢复和发布均直接经 Worker 与文档行版本 CAS 执行；子窗口不能直接访问 SQLite。
- 新增子窗口旧快照/跨实体快照回归测试；Desktop 当前 17 个测试文件、88 项测试，Worker 18 个测试文件、130 项测试。Windows 原生多窗口人工验收仍未完成。

2026-08-15 IDE 横向分栏实施：

- 主窗口改为两级水平分栏：项目导航与工作台之间可调宽度；工作台内的文档/当前项目页、生产参数和会话页按实际可见状态相邻排列。
- 所有停靠页高度填满工作区，相邻页只保留一条 `1px` 共享分隔线；拖动分隔线仅重新分配相邻面板宽度，不产生卡片间距或重复边框。
- 分栏比例通过 `react-resizable-panels` 按项目保存在本地偏好中；项目导航默认 `208px`，允许在 `180px` 到 `360px` 之间调整并支持收起。
- 文档关闭、应用内浮动或分离为 Tauri 独立窗口后会退出停靠分栏，生产页或会话页自动填充剩余宽度；会话关闭或分离时采用同一规则。
- 响应式优先级已落实：工作区低于 `1150px` 且生产页打开时自动收起停靠会话，并保留可重新打开为浮窗的入口；低于 `900px` 时保持单活动页面模式；低于 `660px` 时项目导航自动收起且不覆盖桌面宽度偏好。
- 新增相邻分隔线、生产页动态加入/移除、文档浮动/分离后邻页填充、紧凑宽度会话自动收起和窄屏单活动页面测试。
- 浏览器验收覆盖 `1440x900`、紧凑工作区、`800x760` 和 `390x844`：三页高度一致；拖动文档/生产分隔线时会话宽度保持不变；项目栏宽度在重载后恢复；各断点无页面级横向滚动、顶栏重叠或重复边框。
- 本轮门禁通过：Desktop 16 个测试文件、80 项测试，Worker 17 个测试文件、124 项测试；全仓 `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、Rust fmt 和 41 项 Rust 测试均通过。
