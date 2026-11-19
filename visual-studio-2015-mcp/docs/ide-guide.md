# VS2015 IDE Automation

v0.3.0 增加常驻 .NET Framework x86 STA 桥接，通过 EnvDTE / EnvDTE80 操作**已经运行的 VS2015**。现有 CLI、CDB、性能及手机工具继续提供各自能力。IDE 工具读取当前已加载的状态，包括活动配置、平台和未保存文本。

首次 IDE 请求会用本机 Framework C# 编译器及 VS2015 自带 interop 程序集编译桥接到临时目录；随后连续操作复用同一桥接进程和事件订阅。无需安装 VS 扩展。`VS2015_MCP_ROOT` 可指定 VS2015 根目录；高级部署可用 `VS2015_MCP_IDE_BRIDGE` 指定已编译桥接 EXE。IDE 与 MCP 应运行在相同用户和可访问的完整性级别，ROT 中尚未注册或被模态对话框阻塞的实例可能暂时不可访问。

## 连接与状态

1. 调用 `vs2015_instances`，取得真实 `processId` 和 `startTimeUtc`。
2. 调用 `vs2015_attach`，传 `{processId,expectedStartTimeUtc}`，取得 `sessionId`。它连接 IDE 自动化对象；应用调试由后续 debugger 工具启动。
3. 每次操作显式传 sessionId。`vs2015_solution_status` 返回已打开的解决方案、项目、startupProjects、activeConfiguration、activePlatform 和调试模式。
4. `vs2015_detach` 释放连接与租约，IDE、构建和应用执行状态由开发者继续管理。也可在 IDE 已退出后 detach 清理。

每个 IDE 实例按 PID＋启动时间持有跨桥接的命名租约，第二个 MCP 客户端会收到 `SESSION_BUSY`；同一客户端重复 attach 返回原会话。租约约束本工具，用户仍能在 VS 内手动操作。应用动作前应重新检查状态，不把旧状态作为持续有效的保证。

`vs2015_open_solution` 只在所选 IDE 尚未打开解决方案且处于 design 模式时打开已有文件，避免覆盖正在处理的工作。实例发现和 attach 不会新建 IDE，也不会选择“第一个运行实例”代替显式身份。

## 文档与构建

| 工具 | 行为 |
|---|---|
| `vs2015_documents` | 列举打开的文档及 saved/readOnly 状态 |
| `vs2015_document_open` | 显式选择 text/code 视图；可按请求替换已保存视图，并定位到 1 起始行列 |
| `vs2015_document_read` | 读取 IDE 文本缓冲区，包含未保存编辑；检查 truncated |
| `vs2015_document_replace` | 使用精确 expectedText 进行整文档冲突检查后替换；默认不保存 |
| `vs2015_document_save` | 保存指定文档到原路径 |
| `vs2015_build_active` | 对活动解决方案配置执行 build/rebuild/clean/deploy |
| `vs2015_build_status` | 根据 buildId 查询真实构建事件和结果 |
| `vs2015_ide_errors_output` | 读取 IDE Error List、枚举 Output pane 或按真实 GUID 读取文本 |

编辑前读取完整文本，把该值作为 expectedText；如果用户已修改缓冲区，返回 `DOCUMENT_CONFLICT`，应重新读取。只有 `save:true` 或显式 save 才写文件。本实现不自动保存全部文档。只在 design 模式替换文本；其他扩展或只读文档可能不支持 TextDocument，错误会明确返回。

构建启动返回 buildId，`complete` 只能在匹配的 `OnBuildBegin`／`OnBuildDone` 到达后确认。使用 `vs2015_build_status` 或 `vs2015_ide_events` 等待；`LastBuildInfo` 表示失败的项目数，不能当作错误条数。缺事件或回调读取失败保持 `unconfirmed`／不完整，不从方法返回判断成功。

SolutionBuild 没有 Rebuild 方法，因此 rebuild 调用固定的 IDE 标准命令 `Build.RebuildSolution`，并等待 RebuildAll 事件。其他构建动作直接调用 SolutionBuild。接口不接受任意 ExecuteCommand 文本。已有构建会收到 `BUILD_BUSY`。Error List 是当前 IDE 视图，可能含设计期错误；与外部 MSBuild 的结构化诊断来源不同。Output pane 的名称保留本机语言，选择应使用枚举结果中的 GUID。部分第三方 pane 不提供可读文本。

`vs2015_project_properties` 未指定 `propertyName` 时只列出实际属性名称和索引信息（`valueRead:false`），再按明确名称读取所需值。VS2015 的部分旧项目属性 getter 会直接导致 IDE 崩溃，进程外异常处理无法保护这种调用；枚举不批量执行这些 getter。即使显式读取，也应先确认该项目系统支持此属性。

`vs2015_project_app_identity` 从所选项目实际包含的 Appx 清单读取包、PhoneProductId 和 Application Id，返回原始命名空间、保存字节的 SHA-256 及配置标识。多个清单需明确选择；未保存清单会被拒绝。它证明项目身份来源，部署与客体运行身份需分别确认。

清单设计器可能不提供 TextDocument。要读取或编辑 XML，可明确调用 `document_open` 的 `view:"code", replaceSavedView:true`；已保存视图关闭后按标准 IDE Code 视图重开。未保存文档不会被替换；外部编辑导致保存状态变化时，IDE 仍可显示确认，本工具不会自动应答。未请求行列时保留原选择，不强制移动光标。

## 持续调试工作流

1. 用 `vs2015_ide_debug_breakpoints`，`action:"add"`，传 source file＋line 或 function；保存返回的 breakpointId。
2. 调用 `vs2015_ide_debug_control`，`action:"go"`。它使用 IDE 当前启动项目、配置和部署／调试目标。
3. 将命令返回的 `afterSequence` 传给 `vs2015_ide_debug_wait`，`mode:"break"`，避免旧暂停状态满足新等待。
4. 用 `vs2015_ide_debug_state`／`vs2015_ide_events` 检查暂停原因，再用 debug_inspect 的 threads、frames、locals 读取当前执行上下文。
5. `vs2015_ide_debug_evaluate` 在当前栈帧求值；例如 `{sessionId,expression:"doubled",evaluationTimeoutMs:1000}`。求值可能执行应用属性或方法，应明确选择表达式。结果包含 isValidValue，不能把无效结果当作 0。
6. 执行 stepInto／stepOver／stepOut 后，用该命令的新游标等待下一次 break；停止调试使用 `action:"stop"`。
7. 按返回的 breakpointId 删除自己的断点，最后 detach。

所有 debugger 控制动作都是异步发出。`issued:true` 不保证命中预期断点；应核对事件 reason、栈、变量。inspect 读取 IDE 当前选中的线程／栈帧，不替用户切换它们。本版不提供任意调试器脚本、自动关闭提示或统一的异常修复循环。

事件有顺序号、UTC 时间和有界缓冲。传 `afterSequence` 增量读取，同时检查 oldestSequence；若游标早于缓冲最早记录，期间事件已被淘汰。会话状态属于该桥接生命周期，不是跨服务重启的历史日志。需要把 IDE 操作关联进已有性能历史时，可用 `vs2015_record_action` 包装 IDE 工具；记录边界仍然是 MCP 调用边界，异步构建／运行要额外等待完成事件。

## 超时、关闭与恢复

同一桥接将请求串行分发到 STA，并用消息过滤器有界重试 COM Busy；不会在应用层重放构建、编辑或单步。排队请求取消后不执行。已发出请求取消会标记 `operationMayContinue:true`，继续排空原响应；取消等待不等于停止应用或构建。

如果 COM 一直阻塞到请求超时，只终止该桥接进程，既有 sessionId 全部失效。重新 instances／attach，再查询实际状态决定下一步。服务断连会释放桥接，不调用 IDE Quit。`IDE_CLOSED`／`IDE_DISCONNECTED` 表示进程已关闭或 COM 连接已断开；可 detach 清理。某些模态对话框需要开发者在 IDE 处理，工具不会自动选择对话框选项。

## Windows Phone 边界

在 VS 已配置的 WP8.1／Win10M 项目和目标中，build/deploy/go 走同一 IDE 项目系统与调试器；phone 工具继续提供 SDK 设备发现、应用操作和截图输入。IDE sessionId、CoreCon deviceId、XDE PID、部署目标和应用身份仍是不同标识，不能互换。

WP8.1 与 Win10M 专用 TEMP fixture 已完成 IDE 构建、两种部署 scope、guest 输入、源码断点、locals 21/42、单步、恢复与截图。持久 PhoneSession 绑定项目清单和设备，两个平台可同时持有独立会话。暂停时可调用 `vs2015_ide_guest_app_identity` 核对 SDK 包身份，或用 `vs2015_ide_xaml_tree` 和 `vs2015_ide_xaml_action` 检查并操作 WinRT XAML 控件。当前 XAML 公开 MCP 实机回归覆盖 WP8.1。完整参数和验证边界见 [手机指南](phone-guide.md)。

## 验证与来源

本机 Windows 10 22H2／VS2015 Update 3 自有 TEMP 解决方案，经真实 MCP 完成：身份错误拒绝、两客户端租约、未保存编辑与冲突、RebuildAll 事件、IDE 警告和 Build Output、源码断点、locals 21/42、表达式、线程／调用栈、单步、停止、detach 和再次连接。另验证取消等待及桥接挂起重启不重放。测试创建的 IDE 已清理，原有用户实例未操作。IDE 关闭阶段实测出现 RPC 断开，断开错误和清理单独处理。

运行实机测试需显式设置 `VS2015_TEST_IDE_PID`、`VS2015_TEST_IDE_START`、`VS2015_TEST_IDE_SOLUTION`、`VS2015_TEST_IDE_SOURCE`。测试要求 TEMP 自有 fixture 与 owned-instance.json 匹配，默认跳过；不能直接指向日常项目。环境独立单元测试由 CI 在 Windows/Linux、Node 22/24 上运行，不代表托管 runner 装有 VS2015。

- [SolutionBuild.Build](https://learn.microsoft.com/en-us/dotnet/api/envdte.solutionbuild.build?view=visualstudiosdk-2022)、[SolutionBuild2](https://learn.microsoft.com/en-us/dotnet/api/envdte80.solutionbuild2?view=visualstudiosdk-2022)：支持列表包含 VS SDK 2015，异步完成以事件为准。
- [Debugger](https://learn.microsoft.com/en-us/dotnet/api/envdte.debugger?view=visualstudiosdk-2022)、[GetExpression](https://learn.microsoft.com/en-us/dotnet/api/envdte80.debugger2.getexpression?view=visualstudiosdk-2022)：运行／单步／求值接口和有效值判断。
- [SolutionConfiguration2.PlatformName](https://learn.microsoft.com/en-us/dotnet/api/envdte80.solutionconfiguration2.platformname?view=visualstudiosdk-2019)：活动平台与配置名分别返回。
- [ROT／DTE 示例](https://learn.microsoft.com/en-us/visualstudio/extensibility/launch-visual-studio-dte?view=visualstudio)：现行文档说明按进程查找；VS2015 的 `!VisualStudio.DTE.14.0:<PID>` 标识及 interop 兼容性另由本机验证。
