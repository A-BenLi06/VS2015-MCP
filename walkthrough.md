# Walkthrough

## 2026-11-16T23:29:40+08:00 — Visual Studio 2015 MCP 项目骨架

- 新增独立的 `visual-studio-2015-mcp` Node.js ESM 项目，使用官方 MCP SDK 的 stdio 服务和 PowerShell 7 执行层；保留现有 Metro 技能。
- 协议层使用 SDK，避免自行实现 JSON-RPC 生命周期；工具层面向 VS2015 / MSBuild 14，避免混入新版 VS 参数。
- 确认本机存在 VS2015、MSBuild 14、VSTest、MSTest 和 PowerShell 7.6.9；后续在临时目录进行真实构建验证。
- 验证：安装依赖并检查依赖树；结果见本次提交。
