# Visual Studio 2015 MCP

面向 Windows 的本地 stdio MCP 服务，提供 VS2015 构建、测试、SDK CLI、编译诊断、调试、性能采样与历史比较，以及 Windows Phone 8.1 / Windows 10 Mobile 模拟器操控。

**v0.5.0 — Device Portal 与客体事件报告** 提供 94 项工具，新增绑定 PhoneSession 的 Portal 连接、进程/性能读取、WPR 采集与独立下载，以及 PerfView 客体 ETL 事件汇总。Win10M 14393 已验证真实配对、读数、WPR 启停和 Portal 在线 ETL 下载。WP8.1 已验证采集、下载和离线解析。详见 [IDE 指南](docs/ide-guide.md)、[手机模拟器指南](docs/phone-guide.md) 和[手机客体性能接入现状](docs/mobile-performance.md)。

协议层使用官方 MCP SDK；原生命令由 PowerShell 7 执行。XDE 的 x86 .NET Framework 程序集通过独立的 32 位 Windows PowerShell 5.1 进程调用。无需 VS 扩展，不下载 SDK、镜像或模型，也不调用 AI API。

## 安装与接入

需要 Windows、Node.js 20+、PowerShell 7，以及实际使用的 VS2015 / 手机 SDK。手机模拟器还需要可运行的 Hyper-V、已安装镜像及相应权限。独立 Build Tools 2015 而没有完整 VS 安装目前不在发现范围内。

在本目录执行：

```powershell
npm ci
pwsh -NoProfile -File .\scripts\Print-McpConfig.ps1
```

脚本输出使用本机实际路径的 `mcpServers` JSON 配置，可合并到支持该格式的 MCP 客户端。其他客户端使用相同的 `command`、`args`、`env` 字段配置 stdio 服务。脚本只输出配置，不修改任何客户端设置。

客户端应直接运行 `node` 和 `src/server.mjs` 的绝对路径，避免包管理器的启动日志进入协议 stdout。手动运行 `npm start` 后等待 stdin 是正常行为。每个客户端连接使用独立服务进程。

可选环境变量：

| 变量 | 用途 |
|---|---|
| `VS2015_MCP_PWSH` | PowerShell 7 可执行文件路径 |
| `VS2015_MCP_ROOT` | VS2015 安装根目录；工具请求的 `vsRoot` 优先 |
| `VS2015_MCP_HISTORY` | 历史目录；默认服务工作目录下 `.vs2015-mcp/runs` |
| `VS2015_MCP_LOGGER_CACHE` | MSBuild 诊断 Logger 缓存的父目录 |
| `VS2015_MCP_PERFVIEW` | 可选的本机 PerfView.exe 路径，仅用于离线报告 |
| `VS2015_MCP_DEBUGGER_ROOT` | CDB 所在目录或 Windows Debuggers 根目录 |
| `VS2015_MCP_IDE_BRIDGE` | 可选的已编译 IDE 桥接 EXE；省略时用本机 Framework／VS interop 编译 |

可选工具可独立取得：`scripts/Get-PerfView.ps1 -Version 4.0.0` 校验官方 release 哈希和微软签名；`scripts/Get-WindowsDebugger.ps1` 按需提取已验证版本的微软 x64 CDB。两者只写独立用户目录，不修改 PATH。将返回路径传给 `Print-McpConfig.ps1 -PerfViewPath <exe> -DebuggerRoot <目录>`，也可加 `-HistoryRoot <目录>`。配置脚本仍只输出配置。

从普通 PowerShell 环境启动，避免继承其他 VS 版本 Developer Prompt 的 INCLUDE/LIB/PATH。开发环境只装入本次子进程。脚本启动使用进程范围的 `-ExecutionPolicy Bypass`，不修改机器或用户执行策略；组织强制策略仍可能阻止运行。

## 工具

| 工具 | 用途 |
|---|---|
| `vs2015_instances` / `vs2015_attach` / `vs2015_detach` | 运行中 IDE 发现、指定身份连接、释放自动化会话 |
| `vs2015_solution_status` / `vs2015_open_solution` | IDE 中真实解决方案、活动配置／平台；在空 IDE 打开解决方案 |
| `vs2015_build_active` / `vs2015_build_status` / `vs2015_ide_events` | IDE 构建、完成事件与调试事件游标 |
| `vs2015_documents` / `vs2015_document_open` / `vs2015_document_read` / `vs2015_document_replace` / `vs2015_document_save` | 文本缓冲、未保存编辑、冲突检查与显式保存 |
| `vs2015_ide_errors_output` | 当前 Error List 与按 GUID 选择的 Output 文本 |
| `vs2015_ide_debug_state` / `vs2015_ide_debug_breakpoints` / `vs2015_ide_debug_control` / `vs2015_ide_debug_wait` | 持续 IDE 调试、断点、单步及状态等待 |
| `vs2015_ide_debug_inspect` / `vs2015_ide_debug_evaluate` | IDE 当前线程／栈／locals 和显式表达式求值 |
| `vs2015_ide_guest_app_identity` | 暂停客体的实际 SDK 包身份 |
| `vs2015_ide_xaml_tree` / `vs2015_ide_xaml_action` | 有界 WinRT XAML 树、子树及快照节点操作 |
| `vs2015_discover` | 安装来源、版本、组件、架构和 SDK 能力 |
| `vs2015_inspect_solution` | 读取真实项目名和解决方案配置 |
| `vs2015_tool_help` | 查询本机工具支持的开关 |
| `vs2015_msbuild` | MSBuild 14 构建、目标执行、预处理 |
| `vs2015_devenv` | IDE 项目系统的 Build/Rebuild/Clean/Deploy |
| `vs2015_vstest` / `vs2015_mstest` | 新旧测试执行器 |
| `vs2015_native` | 已发现的编译、链接、SDK 等工具与字面量参数数组 |
| `vs2015_build_diagnostics` / `vs2015_diagnostics_read` | MSBuild 14 结构化错误、警告和目标耗时 |
| `vs2015_debug_discover` / `vs2015_debug_dump` / `vs2015_debug_snapshot` | 调试器发现、CDB dump／已有进程诊断，SOS 堆统计 |
| `vs2015_debug_launch_snapshot` / `vs2015_debug_ide_launch` | 新进程初始断点快照／交互式 VS 调试入口 |
| `vs2015_processes` / `vs2015_profile_sample` / `vs2015_profile_summary` | 宿主目标发现、CPU／内存／Framework CLR 采样和操作窗口统计 |
| `vs2015_profile_compare` | 比较两次采样或同类操作的 CPU、内存峰值、GC／分配速率 |
| `vs2015_profiler_discover` / `vs2015_profiler_cli` | Performance Tools 发现、帮助和受限原生命令 |
| `vs2015_profiler_capture` / `vs2015_profiler_report` | 有界 VSPerf CPU 采集／旧 VSP 报告导出 |
| `vs2015_trace_extract` / `vs2015_perfview_report` | VSPX 中 ETL 提取／PerfView 离线 CPU 与 GC 报告 |
| `vs2015_report_inspect` / `vs2015_hotspots_import` / `vs2015_hotspots_compare` | 显式字段映射、热点快照及口径一致的历史对照 |
| `vs2015_history_create` / `vs2015_history_list` / `vs2015_history_read` / `vs2015_history_artifact` | 运行身份、操作时间线及诊断产物 |
| `vs2015_record_action` | 执行已有 MCP 工具并记录真实调用时间 |
| `phone_discover` / `phone_devices` | XDE/部署工具/运行进程及 CoreCon 设备配置 |
| `phone_start` / `phone_stop` | 启动指定设备、请求关闭指定 XDE |
| `phone_status` / `phone_endpoint` | 就绪状态、屏幕、按钮和 IP 地址 |
| `phone_screenshot` / `phone_input` | PNG/MCP 图片、触摸、键盘、文本和硬件按钮 |
| `phone_apps` | CoreCon 应用枚举、启动、终止、卸载 |
| `phone_cli_help` / `phone_cli` / `phone_deploy` | 手机 SDK 部署帮助、原生命令和结构化部署 |
| `phone_session_open` / `phone_session_status` / `phone_session_endpoint` / `phone_session_close` | 绑定 XDE PID、启动时间、Hyper-V VM GUID、CoreCon GUID/locale 和 endpoint pair 的持久手机会话 |
| `phone_session_input` / `phone_session_screenshot` | 在持久会话中复用输入句柄和截图连接，并在关闭时释放本会话持有的按键 |
| `phone_session_ide` | 将允许的 IDE 构建、调试、清单身份和 XAML 操作路由到已绑定项目 |
| `phone_session_wpr_status` / `phone_session_wpr_start` / `phone_session_wpr_stop` | 在 WP8.1 客体中读取原生 WPR 状态、启动 CPU.Verbose.Memory、下载已校验 ETL，并写入历史 artifact |

详细使用方式及微软来源见 [IDE 指南](docs/ide-guide.md)、[CLI 指南](docs/cli-guide.md)、[诊断与性能指南](docs/diagnostics-performance.md)、[调试指南](docs/debug-guide.md)、[手机模拟器指南](docs/phone-guide.md)、[手机客体性能接入现状](docs/mobile-performance.md)。客户端可通过同名 MCP resources 读取，例如 `vs2015://ide-guide`。

## 执行语义

- 原生 argv 使用 `ProcessStartInfo.ArgumentList`，不经过 PowerShell 求值；MSBuild 属性再按 MSBuild 语法转义。项目、测试、响应文件及工具参数仍可执行本机代码，这不是沙箱。
- 构建配置、平台、属性字典、设备名称和输出语言来自请求或本机。相对项目/包路径以 `workingDirectory` 为基准，省略时使用服务工作目录。
- `dryRun` 解析工具位置并返回计划，不执行目标 CLI。VS 的 dryRun 仍会初始化开发环境。
- 原生结果包含退出码、stdout/stderr、耗时和截断标志。保留输出前段并持续排空管道；完整构建日志可用原生工具日志开关写文件。非零退出或超时映射为 MCP `isError`。
- `setupTimeoutMs` 独立控制 VS 环境初始化，默认 60 秒；`timeoutMs` 控制目标执行，默认 120 秒。客户端请求超时应覆盖初始化、执行和启动余量。内存压力较大时可提高初始化期限，不能把超时视为构建成功。
- 普通 CLI 取消/断连终止本请求的子进程树。VSPerf 采集先发送停止标记并等待清理；强制结束服务仍可能留下会话。模拟器由 SDK 服务启动，可能在启动请求超时后继续运行，应先刷新设备状态再决定是否重试或关闭。
- IDE 取消遵循已发出／未发出区别；超时只结束桥接、不会关闭 IDE，原操作可能继续，须重新连接查状态。原始 CLI 日志、历史工件、调试变量可能含项目路径或敏感内容；按需设置 `-HistoryRoot`，共享原始资料前自行检查。本版未承诺自动识别所有秘密。
- 截图成功生成后替换指定文件；未成功生成新图时保留原文件。默认写入系统临时目录，超过 4 MiB 的 PNG 返回路径而省略内联图片。输入返回 `issued` 表示 API 调用已返回，需用截图核验实际效果。

## 验证

```powershell
npm test
npm run test:integration
npm run test:cancellation
```

集成验证串行运行，要求相应 SDK 已安装。手机测试默认不启动或操作模拟器；若要验证某个已运行实例的只读状态和截图，先从 `phone_discover` 取得进程 ID，再仅为测试命令设置 `VS2015_TEST_XDE_PID`。

2026-11-16（UTC+08:00）在 Windows 10 22H2 / VS2015 Update 3 环境完成：

- 9 项单元测试；7 项构建 MCP 集成检查；3 项手机 MCP 集成检查。
- 实际 MSBuild 构建及属性传递、C 编译链接与运行、中文/空格路径、SDK 8.1 选择、输出截断、失败和超时处理。
- 真实 MCP 取消和旧协议 stdin EOF 检查；整条进程树退出，无遗留测试进程，取消后服务继续响应。
- WP8.1 发现、状态与 480×800 PNG/MCP 图片；部署 dryRun 和 PIN 脱敏。
- Win10 Mobile 模拟器已启动且可通过 MCP 查询状态、请求关闭。该次启动的 shell/tools pipe 未就绪，因此 **Win10 输入、截图及 UWP 应用运行尚未完成实际验证**。验证实例已关闭。

2026-11-18（UTC+08:00）后续验证已完成 WP8.1／Win10M 的实际部署、guest 输入、断点及截图。目标项目仍需使用对应 SDK 和就绪设备验证。本机 XDE 适配以已安装程序集及运行结果为依据。

2026-11-17（UTC+08:00）扩展验证：真实 MSBuild 14 多节点诊断、Framework CPU／分配／GC 计数、MCP 采样与历史比较、取消清理、快照完整性及归档提取。随后完成微软签名 PerfView／CDB 的独立部署，真实 CPU/GC 离线报告与热点对照、自建进程的 CDB 托管栈和完整 dump 堆统计均通过。VSPerf 实时采集／detach 仍待管理员环境验证。手机验证进展见下方 v0.4.0 说明。

实际工具回归默认跳过，避免依赖额外下载或操作已有进程。可为测试命令设置 `VS2015_TEST_PERFVIEW`、`VS2015_TEST_ETL`、`VS2015_TEST_TRACE_PROCESS`，验证已有 Framework CPU/GC trace 的报告；设置 `VS2015_TEST_CDB_ROOT` 验证测试自身创建的 Framework x64 进程，另可设置 `VS2015_TEST_MANAGED_DUMP` 分析已有 dump。它们不等同 `VS2015_MCP_*` 服务配置变量。

IDE 实机回归使用 `VS2015_TEST_IDE_PID/START/SOLUTION/SOURCE` 和 TEMP 自有 fixture 身份记录，默认跳过。已通过真实 MCP 的未保存编辑、重建事件、断点、变量、单步、停止、两客户端租约和取消等待。GitHub Actions 在 Windows/Linux、Node22/24 上运行环境独立测试，依赖已安装 VS2015 的检查通过显式环境变量启用。

### PhoneSession 与 Guest WPR

PhoneSession 固定 XDE `processId`、`expectedStartTimeUtc`、Hyper-V `expectedVmId`。IDE 绑定还需要 CoreCon `coreConDeviceId` 和 `localeId`，服务核对 SDK 的 host/guest 地址对。详细调用流程见手机指南。

WP8.1 WPR 提供 `phone_session_wpr_status`、`phone_session_wpr_start`、`phone_session_wpr_stop`。原生 unknown 状态需要调用方结合当前设备使用情况明确选择 `allowUnknownStatus`，错误中的 `operationMayContinue` 和持久 receipt 支持后续检查。成功 Stop 返回 ETL 路径、字节数、SHA256 和 `headerPlausible`。事件、符号和应用归因由后续离线分析确认。

2026-11-19（UTC+08:00）验证了 104 项完整单元测试、WP8.1 XAML 文本与单次 Invoke 实机流程、WP8.1 WPR 公开 MCP 采集与历史一致性。XAML 实机截图显示 `Result: 44` 和含引号、反斜杠、中文的完整文本。WPR ETL 经 PerfView 离线解析含 10,941 事件、145 个 CPU sample 事件，EventsLost 和 BuffersLost 均为 0。该采集验证覆盖系统采集生命周期，应用热点归因和托管 GC/堆仍待验证。

通用单元测试使用 `npm test`。已安装 VS2015/手机 SDK 的机器可设置 `$env:VS2015_TEST_INSTALLED_SDK='1'` 运行全部 SDK 相关检查。自有手机实机测试分别使用 `VS2015_TEST_WP81_XAML_CONTEXT` 和 `VS2015_TEST_WP81_WPR_CONTEXT`，上下文格式见手机指南。`test/fixtures/New-Wp81Fixture.ps1 -XamlAutomation` 生成对应测试工程和断点元数据。

### Device Portal 与事件内容

在已绑定 CoreCon 的 PhoneSession 上调用 `phone_session_portal_connect`，传设备实际 guest IP 的 HTTP(S) origin。认证通过服务端环境变量名提供；HTTPS 可指定本连接使用的 PEM CA 文件。用 `phone_session_portal_read` 查询设备支持的资源，`phone_session_portal_wpr_status/start/stop/download` 完成显式 profile 选择和采集生命周期。设备必须预先启用 Portal 并完成所需配对；工具不修改设备的安全设置。

`vs2015_perfview_report({analysis:"eventsXml",...})` 将 ETL 复制到独立目录，返回事件类型计数、CPU sample 事件数、原样 loss header 和进程生命周期线索。2026-11-20（UTC+08:00）公开 MCP 回归解析 WP8.1 trace 得到 10,941 事件、145 个 CPU sample 事件、17 个未解码事件，history 与返回一致。未解码事件和丢失字段会保留；样本数不作为 CPU 毫秒，PID/name 聚合不作为完整应用归因。
