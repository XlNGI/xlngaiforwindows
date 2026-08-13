# Windows 发布检查清单

日期：2026-08-02  
目标版本：0.1.0

## 1. 版本和仓库

- [ ] 工作区干净，阶段提交已经推送到远端。
- [ ] `package.json`、Tauri `Cargo.toml`、`tauri.conf.json` 版本一致。
- [ ] SQLite `CURRENT_SCHEMA_VERSION` 和迁移测试已更新。
- [ ] `docs/QUALITY-GATES.md` 没有未接受的 P0/P1 问题。
- [ ] 默认测试未配置真实 Provider 密钥，未消耗额度。

## 2. 自动质量门禁

```powershell
pnpm install --frozen-lockfile
node scripts/align-native-node-runtime.mjs
pnpm format:check
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm worker:sidecar
pnpm --filter @ai-video/worker validate:m7-sidecar
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm tauri:build
```

- [ ] 所有命令退出码为 0。
- [ ] GitHub Hosted Windows CI 全部通过且没有错误注解。
- [ ] M7 Sidecar 输出确认损坏 JSON 恢复、离线示例、缓存边界、诊断脱敏和完整性。

## 3. 安装与升级

```powershell
.\scripts\validate-nsis-install.ps1 `
  -InstallerPath "apps\desktop\src-tauri\target\release\bundle\nsis\unicomp_0.1.0_x64-setup.exe"

.\scripts\validate-nsis-upgrade.ps1 `
  -PreviousInstallerPath "D:\Release\previous\unicomp_<old>_x64-setup.exe" `
  -UpgradeInstallerPath "apps\desktop\src-tauri\target\release\bundle\nsis\unicomp_0.1.0_x64-setup.exe"
```

- [ ] 干净安装、桌面启动、Worker 启动、优雅退出和卸载清理通过。
- [ ] CI 同包覆盖基线通过，外部项目身份、文档摘要和完整性保持不变。
- [ ] 使用上一正式版本安装包执行真实跨版本升级脚本并通过。
- [ ] 卸载应用后，用户外部项目仍存在且内容不变。
- [ ] 干净 Windows 虚拟机未预装 Node.js、pnpm、Cargo 或 SQLite，应用仍可创建项目。

## 4. 代码签名

证书和口令不得进入仓库、CI 日志或诊断包。由证书持有人在受控发布环境完成签名和时间戳，然后执行：

```powershell
.\scripts\validate-windows-signature.ps1 `
  -FilePath "apps\desktop\src-tauri\target\release\bundle\nsis\unicomp_0.1.0_x64-setup.exe" `
  -ExpectedPublisher "<正式发布者名称>"
```

- [ ] Authenticode 状态为 `Valid`。
- [ ] 发布者名称、证书指纹和预期一致。
- [ ] 存在可信时间戳。
- [ ] SmartScreen/Windows Defender 人工启动检查通过。

## 5. 人工产品验证

- [ ] 首次启动显示空项目入口，可创建示例项目并浏览 5 份资料、2 个场次和 4 个镜头。
- [ ] 国内站和国际站密钥状态、设置、删除均正常，界面和诊断不显示密钥。
- [ ] UniCompAPI 只需填写 API Key；连接测试、模型搜索、默认关闭和能力标签均正常。
- [ ] 断网启动后，本地项目、素材、备份、恢复、诊断和缓存维护可用。
- [ ] 视频轮询中断网再恢复，不重复提交；系统休眠超过截止时间后进入超时终态。
- [ ] 低空间测试卷明确拒绝媒体写入，不留下临时文件或素材记录。
- [ ] 备份、导出、恢复、诊断包和一键打开位置均可用。
- [ ] 诊断包人工检查未发现凭据、签名 URL、请求/创作正文、SQLite 或绝对项目路径。
- [ ] 至少一条授权的真实 Provider 成功链路通过；明确记录区域、模型、API 版本和任务 ID，不记录密钥。
- [ ] UniCompAPI 至少完成一次聊天、图片和视频代表性调用；视频通过鉴权 content 接口下载，临时文件和完整响应不进入项目快照。

## 6. 发布结论

只有自动门禁、真实跨版本升级、正式签名、干净虚拟机和人工产品验证全部完成后，M7 才能从 `HOLD` 改为 `PASS`。同包覆盖测试不能替代真实旧版本升级，Mock/固定响应不能替代真实 Provider 和安装环境。
