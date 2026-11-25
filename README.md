# Visual Studio 2015 MCP

在 Windows 上通过本地 stdio MCP 使用 Visual Studio 2015 的构建、测试、诊断和性能工具。安装相应 SDK 后，还可连接 Windows Phone 8.1 和 Windows 10 Mobile 模拟器。

## 安装

从 [GitHub Releases](https://github.com/A-BenLi06/VS2015-MCP/releases) 下载 **Source code (zip)** 并解压。需要 Node.js 20 或更高版本、PowerShell 7，以及所用功能对应的 VS2015 或 SDK。打开 PowerShell 7，在解压后的仓库根目录运行以下命令。

```powershell
Set-Location .\visual-studio-2015-mcp
npm ci --omit=dev
pwsh -NoProfile -File .\scripts\Print-McpConfig.ps1
```

将脚本输出的 stdio 配置填入 MCP 客户端，连接后调用 `vs2015_discover` 核对 VS2015 安装位置。

## 功能与依赖

| 功能 | 依赖与已验证范围 |
| --- | --- |
| 桌面构建、测试与诊断 | Windows 10 22H2、VS2015 Update 3 及项目所需 SDK |
| WP8.1 和 Win10M 模拟器 | 对应 SDK 与镜像、Hyper-V、32 位 Windows PowerShell 5.1。Win10M Portal 采集还需在设备开启并完成配对 |
| ETL 离线分析 | PerfView。`appCpu` 使用 PerfView 随附的 TraceEvent 和 x64 .NET Framework 4.8。原生函数解析需要匹配的 PDB |

查看[完整安装与工具说明](visual-studio-2015-mcp/README.md)、[模拟器指南](visual-studio-2015-mcp/docs/phone-guide.md)或[诊断与性能分析指南](visual-studio-2015-mcp/docs/diagnostics-performance.md)。
