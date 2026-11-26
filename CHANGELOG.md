# Changelog

本文档记录 Visual Studio 2015 MCP 的版本变更与 Release Notes；更细粒度的开发与实机验证日志见 [`walkthrough.md`](walkthrough.md)。

## v0.5.0 (2026-11-26)

`v0.5.0` 将工具总数扩展至 **94 项**（保留 **6 份**内置 `vs2015://*` 文档资源），重点补齐 Windows 10 Mobile Device Portal 在线采集与下载、PerfView 客体 ETL 事件汇总及包绑定原生 CPU 热点归因（`appCpu`），并强化桥接断连、采样截止点、热点单位与源码归档安装体验。本版本同时作为 `A-BenLi06/VS2015-MCP` 仓库的首个 GitHub Release 发布。

### 新增功能

#### 1. Windows 10 Mobile Device Portal 与在线 WPR（6 项新工具）

在已绑定 CoreCon 的持久 `PhoneSession` 上新增以下 `phone_session_portal_*` 工具：

- `phone_session_portal_connect`：连接已在设备启用并监听的 Device Portal（显式 HTTP/HTTPS origin，HTTP 需 `allowInsecureHttp:true`）。
  - 支持环境变量 Basic 凭据（`usernameEnv` / `passwordEnv`），或通过 `pairingPinEnv` 在 HTTPS 上执行一次非持久配对（`persistent=0`），认证 Cookie 仅驻留内存并在关闭时清除，不写入返回结果与 history。
  - 支持常规 CA/主机名校验、每连接 `caPath`，以及面向旧 Win10M 证书（缺少现代 CA/SAN 扩展）的显式叶证书指纹固定（`certificateSha256`，TLS 握手阶段校验指纹与有效期后才发送任何 HTTP 请求或凭据）。
  - 固定目标 OS 身份，拒绝跨源/认证重定向（未配对 307 重定向分类为 `PORTAL_AUTH_REQUIRED`），不自动重试变更请求。
- `phone_session_portal_read`：读取 `os`、`packages`、`processes`、`systemPerformance`、`etwProviders`、`profiles`、`traceFiles` 并落盘 history artifact；兼容 Win10M 14393 `systemPerformance` 的 `json-in-reason` 响应格式并保留 `rawData`。
- `phone_session_portal_wpr_status` / `phone_session_portal_wpr_start` / `phone_session_portal_wpr_stop` / `phone_session_portal_wpr_download`：
  - 兼容 Win10M 14393 实际的 `State`/`SessionType` 字段安排与公开参考格式。
  - 通过显式 JSON Pointer 选择设备实际 profile 字段值（如 Mobile 14393 使用 `/Profiles/0/FileName` 对应 `GeneralProfile.wprp`）。
  - `stop` 仅分发一次、保留原始 `stopResponseEvidence`（含空响应路径、大小与 SHA-256），并在 Stop 时冻结下载候选列表。
  - 兼容设备采集前 `/api/wpr/tracefiles` 仅返回状态对象、Stop 后目录存在时返回 `Items` 的行为：结合两次 HTTP `Date` 校验与文件 `DateCreated`（Windows FILETIME）时间窗筛选唯一或明确选择的候选 ETL，通过 HTTPS 下载至历史目录并校验字节数与 SHA-256；下载失败可单独重试 `download`，禁止重放 `stop`。
- 新增交互式配对验证辅助脚本 `visual-studio-2015-mcp/scripts/Test-MobilePortal.ps1`，在提示输入 6 位配对码前先核对当前进程/VM/IP/TLS 与配对端点状态。

#### 2. PerfView 客体 ETL 分析与 `appCpu` 原生热点归因

- `vs2015_perfview_report` 新增 `analysis:"eventsXml"`：
  - 在独立目录复制原始 ETL（受 `maxTraceBytes` 约束），通过 PerfView `DumpEventsAsXml` 与流式 `XmlReader`（禁止 DTD 与外部实体）返回事件总数、CPU sample 事件数、未解码事件数（`unresolvedEventCount`）、原样 `traceHeaders`（含 `EventsLost`/`BuffersLost`）及进程生命周期线索。
- `vs2015_perfview_report` 新增 `analysis:"appCpu"`（[`AppCpuAnalyzer.cs`](visual-studio-2015-mcp/scripts/AppCpuAnalyzer.cs)）：
  - 使用 PerfView 随附的 `TraceEvent` 与 x64 .NET Framework 4.8，按 ETL 进程事件的 `packageFullName`（可选 `processId` 与消除歧义的 `processIndex`）绑定唯一应用进程实例。
  - 统计归因 CPU 采样数、带调用栈样本数与栈覆盖率；在提供本地原生 PDB（`pdbPaths`）且与加载模块 GUID/age 一致时，按采样指令地址解析原生函数热点并报告 `unresolvedSamples` 与连续可解析原生栈。

#### 3. 安装入口、文档与工程健壮性

- 完善仓库根目录 [`README.md`](README.md) 与 [`visual-studio-2015-mcp/README.md`](visual-studio-2015-mcp/README.md)，提供 GitHub Releases 源码压缩包安装步骤（`npm ci --omit=dev` + `scripts/Print-McpConfig.ps1`）及完整 94 项工具清单。
- 强化桥接断连状态追踪：IDE 与手机桥接按请求记录写入状态，断连时分别标记已确认、已写入和排队中的请求；手机 WPR 历史沿用该状态。
- 改进进程采样截止点语义（`vs2015_profile_sample`）：在测量截止点采样最后一次计数，无有效区间时 CPU 总量返回 `null` 并保留单点内存与数据不足标记。
- 热点比较（`vs2015_hotspots_compare`）同时返回原始 `sourceUnit` 与归一化结果 `unit`。
- ETL 校验拒绝长度不足首个完整 buffer 的截断文件。
- 约束 Windows CI 单元测试文件并发（`--test-concurrency=2`）并补充子进程分阶段诊断，增加手动触发的自托管 VS2015 `ide-cache` 回归工作流。

### 已验证范围

- **Win10M 14393 实机 Portal 与 `appCpu` 归因**：
  - 通过公开 MCP 完成非持久 Portal 配对、进程/包/性能读数、`GeneralProfile.wprp` 采集与 HTTPS 在线下载 ETL（11 MiB 与 24 MiB 两次实测，`EventsLost=0`、`BuffersLost=0`）。
  - 在 14393 模拟器部署 UWP x86 测试应用 `McpCpu14393`（PID 3120），公开 stdio MCP `appCpu` 回归复现 23,996 个应用 CPU 采样、14,167 个带栈样本，并用匹配 PDB 解析出 `FixtureHotMix` 23,536 个采样（98.08%）。
- **WP8.1 ETL 事件检查**：公开 MCP `eventsXml` 回归解析真实 WP8.1 WPR trace，返回 10,941 个事件、145 个 CPU sample 事件、17 个未解码事件与 39 条进程生命周期观察，结果与 history 一致。
- **单元测试与安装包验证**：
  - 发布前本机 Windows 10（Node.js v24.16.0）运行 `node --test --test-concurrency=2 test/*.test.mjs` 通过 **133 项**（3 项依赖本机 VS2015/SDK 的测试用例在未设置 `VS2015_TEST_INSTALLED_SDK=1` 时按配置跳过）；此前启用 `VS2015_TEST_INSTALLED_SDK=1` 的完整 SDK 单元套件 136/136 通过（见 [`walkthrough.md`](walkthrough.md)）。
  - GitHub Actions 矩阵（Ubuntu / Windows，Node 22 / 24）单元测试通过，并实测从源码归档执行 `npm ci --omit=dev` 后在 Node 20.0.0 下握手 `0.5.0`、枚举 94 工具、读取 6 资源与调用 `vs2015_discover`。

### 已知边界与未验证范围

- 管理员权限下的 `vs2015_profiler_capture`（VSPerf 实时 ETW 采集与 detach）仍待提权环境验证。
- 通用 Windows 10 Mobile 模拟器 shell 触摸滑动手势未通过本轮验证。
- 手机客体的托管堆 / CLR / JIT 分析以及手机系统二进制符号完整覆盖尚未验证。
- 仅安装独立 Build Tools 2015 而无完整 VS2015 的环境目前不在工具发现范围内。

---

## 早期版本里程碑（v0.2.0 – v0.4.0）

- **v0.4.0**：将工具扩展至 88 项，引入持久 `PhoneSession`（绑定 XDE PID、启动时间、Hyper-V VM GUID 与 CoreCon 双端点）、受保护的 WinRT XAML 视觉树查询与控件操作、暂停客体 SDK 包身份核对，以及 WP8.1 Guest WPR CPU 采集与 ETL 下载校验。
- **v0.3.0**：将工具扩展至 65 项，新增基于常驻 x86 .NET Framework STA 桥接的 VS2015 IDE 自动化（ROT 租约、配置/项目属性、文本缓冲与增量编辑、事件驱动构建、断点所有权隔离、线程/栈帧导航与表达式求值）及跨平台 CI 单元测试。
- **v0.2.1**：新增官方签名 PerfView 4.0.0 与便携式 x64 CDB 获取脚本（哈希与微软签名校验），完成真实 CDB 快照/SOS 堆统计与 PerfView 离线 CPU/GC 报告闭环。
- **v0.2.0**：新增 MSBuild 14 `ILogger` 结构化编译诊断、进程 CPU/内存/CLR 采样、不可变运行历史与热点比较、CDB 命令行调试入口及离线 trace 提取。
