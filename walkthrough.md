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

## 2026-11-16T23:43:20+08:00 — 接入 VS2015 PowerShell 执行后端

- 通过注册表、VS140COMNTOOLS、显式目录和安装文件版本发现VS2015；发现并隔离14.x工具链与所选Windows SDK。
- 子进程加载vcvarsall，原生工具用ProcessStartInfo.ArgumentList，保持宿主环境和工具语言；并发读取有界输出，返回原始退出码与超时状态。
- 低内存并发验证发现30秒环境初始化超时，因此将setupTimeoutMs与目标工具timeoutMs分开（默认60秒，可配置）；目标1秒超时仍按预期终止。
- 验证：真实SDK MCP客户端集成7项全部通过，含实际MSBuild属性写文件、中文空格目录C编译链接运行、SDK8.1选择、输出截断、无效安装、错误退出和进程超时，耗时约125秒。

## 2026-11-16T23:52:49+08:00 — WP8.1 / Windows 10 Mobile 模拟器与部署

- 接入12项phone工具：发现设备、启动、状态/IP、截图、输入、关闭、应用及部署CLI；服务共20项工具。XDE SDK使用隔离的32位Windows PowerShell5.1桥，部署和VS工具共用PowerShell7原生进程执行器。
- 区分CoreCon设备GUID、XDE进程ID、应用ProductID、Win10包全名；保留本地语言/显示名。8.1与10使用各自的输入接口，坐标统一guest像素；输入调用返回issued并要求截图核验。
- 截图先写唯一临时文件，验证后替换目标，避免旧图误报；返回MCP image。PIN从部署返回参数和日志中脱敏。
- 验证：9项单元测试、全部PowerShell语法检查及3项手机MCP集成测试通过；实测WP8.1状态和480x800截图、部署dryRun与PIN脱敏。
- Win10M实测：已启动独立实例，AutomationClient可连接且Hyper-V状态正常，但shell与tools pipe未就绪；未宣称Win10输入、应用部署/启动成功。保留版本能力与环境就绪的区别。
- 独立真实验证MCP取消与stdin EOF均清理完整进程树，无遗留进程；取消后服务仍可响应。

## 2026-11-16T23:55:09+08:00 — 保留取消与断连回归验证

- 纳入已通过的真实MCP取消/旧协议stdin EOF验证脚本，动态定位仓库与依赖；只清理本测试已确认的进程树，并生成临时JSON证据。
- 集成测试的总超时现在会通过AbortSignal传到MCP，避免测试超时后后台继续构建。
- 验证：原型实际取消1.072秒、EOF4.382秒清理完整链；服务取消后仍可枚举工具，遗留PID为0。路径适配后的脚本与集成测试语法检查通过。

## 2026-11-16T23:56:25+08:00 — 保留 Unicode 项目属性名

- 属性字典校验使用Unicode字母/数字/组合字符，去除不必要的ASCII语言限制，同时拒绝参数分隔符。
- 验证：6项规划测试通过，包括中文属性名和值、逗号转义及工作目录。
