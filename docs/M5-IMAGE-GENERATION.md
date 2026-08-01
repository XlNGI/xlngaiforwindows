# M5 生图闭环

状态：代码与自动化验证 `PASS`；真实 Vidu 成功请求和人工测试尚未执行，阶段签收保持 `HOLD`。

## 范围

M5 首批支持已有 Vidu 同步图片适配器（文生图和参考生图）。桌面端从生产参数栏提交请求，Rust 只按完整 `adapterKey` 注入 Windows Credential Manager 中的对应凭据；Worker 保存脱敏参数快照、任务状态和结果 manifest。

## Worker 合同

- `image.generate.prepare`：校验适配器、参数和镜头归属，创建 `running` 任务。
- `image.generate.complete`：接收原生层的 HTTP 状态和 JSON 响应，解析 URL 或 `data:image/...;base64,...`，下载/解码并限制 25 MiB。
- `image.generate.get` / `image.generate.cancel`：查询或取消任务。
- `asset.list` / `asset.rename` / `asset.delete`：管理项目资产。

完成时先写临时文件，校验图片 MIME、大小和 SHA-256 后原子重命名；资产、结果和任务成功状态在同一 SQLite 事务中提交。Provider 非 2xx、超时、非法响应、下载失败和取消都不会产生资产记录。

## 数据与安全

Schema v4 为 `generation_results(job_id, created_at)` 增加索引。请求快照只包含经过适配器 Schema 校验的参数，不包含 API Key。二进制文件存于 `assets/images/`，数据库只存相对路径、Hash、大小、类型和来源 URL。

## 自动化验证

- Worker 图片服务：Base64 成功落盘、非法响应回滚、HTTP 403 失败映射。
- Worker 全量测试：34 tests passed。
- Desktop 全量测试：6 tests passed；生成成功后可选择角色、场景、首帧、尾帧或普通图片，并在面板内重命名/删除资产。
- Persistence 全量测试：7 tests passed，Schema v4 迁移通过。

## 人工测试入口

1. 在 Windows 桌面端打开或创建项目，选择镜头。
2. 在生产参数栏选择 `TEXT_TO_IMAGE`、Vidu 和模型，输入提示词、比例、分辨率。
3. 在凭据区域保存 Vidu API Key，确认只显示“已配置”，不复制或记录密钥。
4. 点击“生成图片”，确认任务成功、`assets/images/` 出现图片，资产列表可见来源 URL、Hash 和大小。
5. 使用“重命名”和“删除”验证文件与 manifest 同步；重新打开项目确认数据仍在。
6. 使用无效/过期凭据、非法参考 URL 或断网重试，确认界面显示错误且资产列表不增加残缺记录。

真实 Provider 成功请求、Windows 原生网络、凭据读取和人工 UI 签收必须由人工执行并记录结果；自动 Mock 不能替代这些步骤。
