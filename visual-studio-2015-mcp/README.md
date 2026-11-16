# Visual Studio 2015 MCP

面向 Windows 的本地 stdio MCP 服务，提供 VS2015 构建、测试、SDK CLI，以及 Windows Phone 8.1 / Windows 10 Mobile 模拟器操控，共 20 项工具。

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

从普通 PowerShell 环境启动，避免继承其他 VS 版本 Developer Prompt 的 INCLUDE/LIB/PATH。开发环境只装入本次子进程。脚本启动使用进程范围的 `-ExecutionPolicy Bypass`，不修改机器或用户执行策略；组织强制策略仍可能阻止运行。

## 工具

| 工具 | 用途 |
|---|---|
| `vs2015_discover` | 安装来源、版本、组件、架构和 SDK 能力 |
| `vs2015_inspect_solution` | 读取真实项目名和解决方案配置 |
| `vs2015_tool_help` | 查询本机工具支持的开关 |
| `vs2015_msbuild` | MSBuild 14 构建、目标执行、预处理 |
| `vs2015_devenv` | IDE 项目系统的 Build/Rebuild/Clean/Deploy |
| `vs2015_vstest` / `vs2015_mstest` | 新旧测试执行器 |
| `vs2015_native` | 已发现的编译、链接、SDK 等工具与字面量参数数组 |
| `phone_discover` / `phone_devices` | XDE/部署工具/运行进程及 CoreCon 设备配置 |
| `phone_start` / `phone_stop` | 启动指定设备、请求关闭指定 XDE |
| `phone_status` / `phone_endpoint` | 就绪状态、屏幕、按钮和 IP 地址 |
| `phone_screenshot` / `phone_input` | PNG/MCP 图片、触摸、键盘、文本和硬件按钮 |
| `phone_apps` | CoreCon 应用枚举、启动、终止、卸载 |
| `phone_cli_help` / `phone_cli` / `phone_deploy` | 手机 SDK 部署帮助、原生命令和结构化部署 |

详细使用方式及微软来源见 [CLI 指南](docs/cli-guide.md) 和 [手机模拟器指南](docs/phone-guide.md)。客户端也可通过 MCP resources 读取 `vs2015://cli-guide` 和 `vs2015://phone-guide`。

## 执行语义

- 原生 argv 使用 `ProcessStartInfo.ArgumentList`，不经过 PowerShell 求值；MSBuild 属性再按 MSBuild 语法转义。项目、测试、响应文件及工具参数仍可执行本机代码，这不是沙箱。
- 构建配置、平台、属性字典、设备名称和输出语言来自请求或本机。相对项目/包路径以 `workingDirectory` 为基准，省略时使用服务工作目录。
- `dryRun` 解析工具位置并返回计划，不执行目标 CLI。VS 的 dryRun 仍会初始化开发环境。
- 原生结果包含退出码、stdout/stderr、耗时和截断标志。保留输出前段并持续排空管道；完整构建日志可用原生工具日志开关写文件。非零退出或超时映射为 MCP `isError`。
- `setupTimeoutMs` 独立控制 VS 环境初始化，默认 60 秒；`timeoutMs` 控制目标执行，默认 120 秒。客户端请求超时应覆盖初始化、执行和启动余量。内存压力较大时可提高初始化期限，不能把超时视为构建成功。
- 取消/断连终止本请求的子进程树。模拟器由 SDK 服务启动，可能在启动请求超时后继续运行，应先刷新设备状态再决定是否重试或关闭。
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

部署真实包、测试程序集、手机输入效果仍需在目标项目/就绪设备上验证。本机 XDE 公共程序集提供输入接口，但不应将其视为微软承诺长期兼容的公开自动化协议。
