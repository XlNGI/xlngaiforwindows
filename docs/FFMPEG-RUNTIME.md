# 共享 FFmpeg 运行时

固定角色配音使用随应用捆绑的 Windows x64 FFmpeg／ffprobe，禁止回退到系统 PATH。第一版捆绑 BtbN 月末保留版 `n8.1.3-9-g29e619e767-20260930` 的 LGPL shared 构建；源地址、归档与各文件 SHA256 存在 `apps/desktop/src-tauri/resources/ffmpeg/manifest.json`。

```powershell
pnpm.cmd media:prepare
pnpm.cmd media:verify
# 离线重建可使用相同 SHA256 的归档：
node scripts/prepare-ffmpeg.mjs --archive C:\cache\ffmpeg-n8.1.3-9-g29e619e767-win64-lgpl-shared-8.1.zip
```

构建脚本只下载固定归档，解包前校验 SHA256，校验所有发布 EXE／DLL，probe 版本，拒绝 GPL／nonfree 构建，检查 OpenH264。二进制不进入 Git；干净检出首次构建会准备资源。月末归档由上游保留两年，正式发布应归档匹配二进制、源码与依赖构建配方，保证后续可复现与源码提供。

Tauri 将整个目录映射为安装目录 `media/ffmpeg/`。Worker 从随包可执行文件旁的该目录解析资源；开发运行可从仓库资源目录读取。测试或显式开发调用可通过 `FfmpegRuntime` 的 `resourceDirectory/ffmpegPath/ffprobePath` 指定工具，不搜索 PATH。文件必须为绝对本地普通文件，拒绝符号链接／联接逃逸和覆盖已有输出。

音频规范化为 48 kHz 双声道 PCM WAV。精确视频区间重编码为 H.264／MP4，使用 LGPL 构建中的 `libopenh264`，不使用 GPL `libx264`。每次输出先写受控独立临时目录，probe 与完整解码通过后才交付。执行使用参数数组、隐藏 Windows 子进程、受限输出、期限和取消；失败清理自身临时文件。最终合成移除源音轨，已确认对白按冻结的绝对毫秒起点放置；口型片段覆盖指定画面区间，其他画面保持场次位置，禁止重叠、对白截尾和最短流截断。旁白仅填 `audioPath`。

安装包随附 LGPLv3、其引用的 GPLv3 许可证、OpenH264 BSD 通知、源码／重建说明和 manifest。FFmpeg DLL 可替换，应用通过独立进程调用。官方源与对应依赖配方见捆绑 `NOTICE.txt`。发布前仍需核验完整第三方依赖源码／通知归档、安装与旧版本升级；本地工程测试不替代这些发布检查，也不代表供应商样片已验收。
