# M7 稳定性和发布

日期：2026-08-02  
状态：自动化门禁通过，等待人工发布验证（HOLD）

## 1. 阶段目标

将 M0-M6 的技术闭环整理为可安装、可迁移、可诊断、可升级的 Windows 产品。M7 不增加新的生成模型或业务生产方式。

## 2. 用例和输入/输出

| 用例 | 输入 | 成功输出 | 失败输出 |
|---|---|---|---|
| 导出诊断包 | 当前项目、可选目标目录 | 原子生成的诊断目录及脱敏清单 | 明确错误，不留下临时目录 |
| 检查媒体缓存 | 当前项目 | 文件数、总字节数和有界分类摘要 | 明确错误，不修改文件 |
| 清理媒体缓存 | 当前可写项目 | 删除文件数、释放字节数 | 明确错误，不触及缓存目录外内容 |
| 创建示例项目 | 空目标目录、项目名称 | 可打开的项目和一组示例资料 | 清理本次创建的目录，不留下半成品 |
| 升级验证 | 旧安装包、新安装包、测试项目 | 新版本打开后完整性和内容摘要不变 | CI 失败并保留可复核摘要 |

## 3. 领域不变量

1. 诊断包不得包含凭据、Authorization、Token、Cookie、Base64/Data URL、签名 URL、Provider 请求正文、用户创作正文、SQLite 副本或绝对项目路径。
2. 诊断包只包含版本、平台、Schema/完整性结果、数量统计、有界错误事件和项目文件的类型/大小/哈希摘要。
3. 诊断输出使用临时目录构建，成功后原子发布；失败时删除临时目录。
4. 缓存检查和清理只允许访问当前项目根目录下的 `cache/`；不得跟随符号链接或目录联接，不得访问 `assets/`、`exports/`、`backups/` 或 `project.sqlite`。
5. 缓存清理不修改 SQLite，不删除已登记素材，不处理仍由活动任务拥有的文件。
6. 诊断事件仅保存在 Worker 内存中，数量和单条长度均有上限；项目关闭或 Worker 退出后不持久化。
7. 示例项目使用稳定的内容结构和随机持久化 ID；所有资料在一个 SQLite 事务内写入。
8. 示例初始化失败时关闭数据库、释放锁，并只清理本次创建且原先为空的目标目录。
9. 升级安装不得删除或迁移用户项目；首次打开旧项目只能执行已声明的 SQLite 前向迁移。
10. 发布构建必须携带独立 Worker，不依赖用户预装 Node.js、pnpm、Cargo 或 SQLite。

## 4. 状态机和所有权

### 4.1 诊断导出

```text
requested -> collecting -> writing-temp -> complete
                    |             |-> failed -> temp-cleaned
                    `-------------> failed
```

- 所有者：当前 Worker 进程和请求 ID。
- 数据来源：当前打开项目的只读数据库连接、Worker 内存事件和项目文件元数据。
- 终态：`complete` 或请求错误；不向 SQLite 持久化中间状态。

### 4.2 缓存维护

```text
idle -> inspecting -> complete
idle -> clearing -> complete
                  `-> failed
```

- 所有者：当前项目会话令牌。
- `inspect` 允许只读项目使用；`clear` 仅允许可写项目使用。
- 单次调用同步完成，不跨项目会话保留回调。

### 4.3 示例项目

```text
requested -> container-created -> seeding-transaction -> open
                         |                  `-> rollback
                         `--------------------> cleanup -> failed
```

- 所有者：创建请求及其目标绝对目录。
- 示例文档、场次和镜头归属于新项目 ID。

## 5. 故障矩阵

| 场景 | 必须满足的结果 |
|---|---|
| 错误文本含 API Key、Bearer、Data URL 或签名参数 | 诊断事件和导出文件中替换为 `[REDACTED]` |
| 诊断期间数据库完整性检查失败 | 输出失败摘要，不导出数据库或原始异常载荷 |
| 诊断目标已存在或写入中断 | 不覆盖既有目录；清理本次临时目录 |
| 缓存中存在符号链接、目录联接或循环 | 只删除链接本身，不遍历目标 |
| 缓存文件在扫描后被其他进程删除 | 继续有界扫描；结果以实际删除量为准 |
| 清理时项目切换或只读 | 请求失败或使用原会话同步完成，不触及新项目 |
| 示例目标非空 | 拒绝创建，不删除既有内容 |
| 示例事务失败 | 回滚所有示例行并清理本次新建容器 |
| 离线启动 | 本地项目、素材、备份、诊断和缓存维护可用；Provider 请求明确失败 |
| 网络在轮询中切换 | 任务保持可恢复并退避，恢复网络后继续，不重复提交 |
| 系统休眠超过轮询期限 | 根据持久化截止时间进入超时终态，不无限轮询 |
| 磁盘空间不足或文件过大 | 原子写入失败并清理临时文件，不登记素材或成功结果 |
| Worker 收到损坏 JSON | 返回有界协议错误并继续服务后续请求 |
| 新版本覆盖安装 | 应用二进制升级，外部项目内容和摘要保持不变 |

## 6. IPC 契约

| 方法 | 参数 | 返回 |
|---|---|---|
| `maintenance.diagnostics.export` | `{ destinationRoot?: string }` | `{ path, createdAt, manifestVersion, fileCount }` |
| `maintenance.cache.inspect` | `{}` | `{ fileCount, directoryCount, sizeBytes }` |
| `maintenance.cache.clear` | `{}` | `{ removedFiles, removedDirectories, freedBytes }` |
| `project.createSample` | `{ rootPath, name? }` | `ProjectInfo` |

所有字段拒绝错误类型。`destinationRoot` 必须是绝对路径；默认输出到当前项目 `exports/`。导出路径通过 UUID 唯一化，调用方不能指定最终文件名。

## 7. 诊断包格式 v1

```text
diagnostics-<UTC timestamp>-<id>/
|- manifest.json
`- report.json
```

`manifest.json` 只描述格式版本、创建时间和文件清单。`report.json` 包含运行时版本、项目 Schema/打开模式、SQLite 完整性、各业务表数量、项目一级目录文件统计和最多 50 条脱敏错误事件。单条事件消息最多 1 KiB，报告总大小最多 256 KiB。

## 8. 需求追踪

| 不变量 | 实现模块 | 自动化验证 | 人工验证 |
|---|---|---|---|
| 诊断脱敏和有界输出 | Worker Diagnostic Service | secret/path/body redaction、size bound | 打开诊断包检查内容 |
| 诊断原子发布 | Worker Diagnostic Service | existing target/write failure cleanup | 一键打开输出位置 |
| 缓存边界和链接隔离 | Worker Project Service | nested files、symlink/junction、read-only | 清理后素材仍可预览 |
| 示例项目原子初始化 | Worker Sample Project Service | seeded content、non-empty、rollback | 首次启动创建并浏览 |
| 离线/网络/休眠恢复 | Provider、轮询调度器 | offline/backoff/deadline tests | 断网和休眠恢复 |
| 大文件/低磁盘/损坏 JSON | Worker、媒体服务 | upper-bound/write-failure/parser recovery | 低空间测试卷验证 |
| 无 Node 运行时 | Tauri bundle、NSIS | clean install lifecycle | 干净 Windows 虚拟机 |
| 升级不损坏项目 | NSIS upgrade script、SQLite | before/after digest and integrity | 旧版覆盖安装 |
| 签名链可信 | 发布流程 | 签名存在性检查 | 证书持有人签名和 SmartScreen 验证 |

## 9. 发布边界

- 默认 CI 和本地测试不得调用真实 Provider 或消耗额度。
- 代码签名必须使用项目所有者提供的正式证书和受控密钥；仓库不保存证书或口令。
- 当前代理可完成未签名 NSIS、升级脚本和自动化门禁；真实签名、真实 Provider 成功请求、干净虚拟机体验和最终人工发布签收保留为人工门禁。

## 10. 自动化验证结论

- TypeScript 工作区的构建、类型检查、Lint、格式检查和全部自动测试通过。
- Rust/Tauri 的格式检查、编译检查和全部原生测试通过。
- 打包 Worker 已通过损坏 JSON 恢复、离线健康检查、示例项目创建、缓存检查/清理、诊断脱敏和 SQLite 完整性验证。
- NSIS 已通过本机干净安装生命周期，以及同一安装包覆盖安装时外部项目 ID、文档摘要、SQLite 完整性和卸载后项目保留验证。
- 项目维护界面已在 1280x720 和 390x844 视口检查；对话框和交互控件无越界、文本溢出或重叠。
- Hosted Windows CI run `30754118267` 全部通过，包含构建、135 个测试、M7 Sidecar、Tauri/NSIS、干净安装和覆盖安装保留验证。
- 当前安装包未签名；签名校验脚本只接受 Authenticode `Valid`，不会用测试证书替代正式证书。

同一安装包覆盖安装只能证明安装器生命周期和外部项目保留基线，不能替代上一正式版本到当前版本的真实升级验证。

## 11. 待人工发布门禁

1. 使用项目所有者提供的正式 Authenticode 证书签名并加时间戳，验证发布者名称和 SmartScreen 行为。
2. 使用上一正式版本安装包执行真实跨版本覆盖升级，复核项目 ID、内容摘要、SQLite 完整性和卸载后项目保留。
3. 在干净 Windows 虚拟机完成安装、首次启动、示例项目、诊断导出、卸载和无 Node/Cargo 依赖验证。
4. 人工执行断网/联网切换、真实系统休眠恢复和低磁盘空间测试。
5. 经用户授权后执行真实 OpenAI/Vidu 成功请求，确认计费任务、轮询、下载和素材登记。
6. 完成人工发布检查表并签收后，才可将 M7 从 `HOLD` 改为已签收。
