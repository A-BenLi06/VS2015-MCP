# Walkthrough

## 2026-11-16T23:29:40+08:00 — Visual Studio 2015 MCP 项目骨架

- 新增独立的 `visual-studio-2015-mcp` Node.js ESM 项目，使用官方 MCP SDK 的 stdio 服务和 PowerShell 7 执行层；保留现有 Metro 技能。
- 协议层使用 SDK，避免自行实现 JSON-RPC 生命周期；工具层面向 VS2015 / MSBuild 14，避免混入新版 VS 参数。
- 确认本机存在 VS2015、MSBuild 14、VSTest、MSTest 和 PowerShell 7.6.9；后续在临时目录进行真实构建验证。
- 验证：安装依赖并检查依赖树；结果见本次提交。

## 2026-11-16T23:32:28+08:00 — MCP 协议与构建工具层

- 新增官方 SDK stdio 服务、PowerShell JSON 桥、解决方案静态检查及 MSBuild/devenv/VSTest/MSTest/native 工具；取消请求会终止所属进程树。
- 参数以数组传递，MSBuild 属性另外按其语法转义；配置名、属性和输出语言不固定。
- 验证：5 项 Node 测试通过，覆盖属性转义、参数依赖、Unicode 解决方案、错误退出与超时映射；server 语法检查通过。
- PowerShell 后端与手机模拟器桥将在独立改动中接入。

## 2026-11-16T23:33:38+08:00 — 修正路径和 MSBuild 属性语义

- 独立审查发现相对路径未基于 workingDirectory 解析，MSBuild 属性逗号会被当作参数分隔符；统一路径基准并转义逗号。
- 暴露 VS2015 vcvarsall 的 sdkVersion/store 选择，支持直接工具调用时指定 Windows 8.1 SDK。
- 验证：6 项单元测试全部通过；审查同时验证 SDK2.4 握手与8项工具枚举。
