# 手机客体性能：已核对的接入路径

手机模拟器操控与手机应用性能采集使用不同通道。已有 phone 工具负责启动、部署、输入、截图等；`vs2015_profile_sample` 和本机 CDB 面向宿主 PID。把 XDE 的 PID 传给它们只能测模拟器宿主进程，不能代表 WP8.1／Win10M 应用。

WP8.1 已通过 `phone_session_wpr_status/start/stop` 提供 CPU profile 客体采集。下表同时列出已实现通道和后续平台接入路径。

| 平台 | 可继续接入的客体通道 | 当前证据与限制 |
|---|---|---|
| WP8.1 | Developer Power Tools → CoreCon 服务 → WpWpr → ETL | 本机有 x86/ARM guest helper、服务和 Recorder/Monitor 组件；需连接、部署并启动客体服务 |
| Win10M 1511+ | Device Portal 进程指标、ETW provider、WPR | 14393 已验证真实读数、WPR 启停、Portal 在线下载和 ETL 解析 |
| 两类平台的托管堆 | VS 手机 MemoryProfilerCollectionAgent | 已找到对应架构的客体 agent 与 CoreCon 部署定义；独立命令行编排及结果解析尚未验证 |

WP8.1 SDK 的 `Tools/PowerTools/Support/{x86,ARM}/WpWpr.exe` 是**客体程序**。已从本机微软组件确认 `startWpr` 服务命令及 `-start`、`-stop`、`-status`、`-cancel` 协议，不能在宿主直接执行，也不能把 UI 中出现 Heap profile 视为已采集到托管分配调用栈。新建 CoreCon 服务连接可能部署并启动 guest agent，因此不是纯只读动作。

Win10M 可探测 `/api/resourcemanager/processes`、`/api/resourcemanager/systemperf`、`/api/etw/providers`、`/api/wpr/status`。WPR profile 应来自目标设备，不能假定与桌面相同。特别注意：**`GET /api/wpr/trace` 是停止采集并写出 ETL，状态查询是 `/api/wpr/status`。** 已在采集的设备不能自动接管或取消。WPR 同一设备只有一个会话且没有所有权 token，本地锁无法隔离外部工具。

CPU 曲线、工作集、Private Bytes、GC 事件、分配类型与对象引用图是不同数据。GC／类型热点取决于实际客体运行时、provider 和 profile；UWP .NET Native 也不能套用桌面 CLR 计数器。客体 ETL 的符号分析需要对应手机系统二进制、PDB 及进程身份。SDK 内的 CPU/NativeMemory agent 存在并不等于已提供可用的通用 CLI。

来源与适用范围：

- [Windows 10 Mobile Device Portal](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/debug-test-perf/device-portal-mobile)：Mobile 1511 起的门户、连接和配对；WP8.1 没有同一门户。
- [Device Portal Core API](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/device-portal-api-core)：进程、ETW、WPR 路径和 Mobile 支持标记。
- [VS 中的 WP8.1 性能分析](https://devblogs.microsoft.com/devops/performance-profiling-on-windows-phone-8-1-with-visual-studio/)：WinRT 与 Silverlight 工作流不同，Memory/Energy 依赖相应更新；模拟器性能不等同真机。
- [Memory Usage 工具](https://devblogs.microsoft.com/devops/diagnosing-memory-issues-with-the-new-memory-usage-tool-in-visual-studio/)：类型、快照差异和引用分析的实际含义。

SDK 内部协议经过已安装组件检查和 WP8.1 实机验证，适配器用 agent 8.1 握手限定支持范围。Win10M Device Portal 使用 `phone_session_portal_*`，调用方式与实际边界见[手机指南](phone-guide.md#portal-wpr)。

## 已验证的 WP8.1 Guest WPR

持久 PhoneSession 通过 XDE PID、启动时间、Hyper-V VM GUID、CoreCon GUID/locale 和 host/guest endpoint pair 固定客体。phone_session_wpr_status 保留 native output 和 fingerprint，phone_session_wpr_start 只接受类型化的 cpu profile，phone_session_wpr_stop 只接受本控制器返回的 captureId。真实验证返回了 4 MiB ETL，EventsLost=0、BuffersLost=0，PerfView 离线 XML 中包含 CPU sample 事件。

这条 profile 的证据覆盖客体采集生命周期和 native/module sample。当前报告仍将 managed GC、managed heap、symbol completeness 和应用热点归因标为未验证。

## 已验证的 Win10M Portal WPR

Mobile 14393 的 `WebManagement.exe` 在 `/api/wpr/tracefiles` 中检查进程临时目录下的 `WPRTraces`。目录检查失败时调用与 `/api/wpr/status` 相同的状态处理函数。Stop 写出 ETL 后，实测该接口返回 `Items`，其中含文件名、字节数和 FILETIME 创建时间。镜像自带 Portal 前端与微软 REST 参考均使用此枚举接口，再按结果中的文件名下载。[Device Portal Core API](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/device-portal-api-core)

2026-11-25（UTC+08:00）实测使用 `GeneralProfile.wprp` 采集，Stop 返回零字节并确认 Idle。采集前无枚举，Stop 后工具按设备时间和 FILETIME 选出唯一候选，并经 HTTPS 下载 11 MiB ETL。公开 MCP 回归核对了下载大小、SHA256、history 一致性和会话清理。PerfView 解析出 44,700 个事件和 848 个 CPU sample 事件，ETL 头部记录 EventsLost=0、BuffersLost=0。

### Win10M 应用归因与原生热点实测

在同一 14393 模拟器部署 UWP x86 测试应用 `McpCpu14393`，使用 `GeneralProfile.wprp` 在启动应用前开始采集，经 Portal HTTPS 下载 24 MiB ETL。Portal 报告的 PID 3120 和完整包名与 ETL 的唯一 `Process/Start` 一致，ETL 还提供 `ApplicationID=App` 和 `UniqueProcessKey`。按进程实例归入 23,996 个 CPU 采样，整条 ETL 共 25,982 个。

将采样指令地址与该进程的 `Image/Load` 记录关联，使用 GUID 和 age 均匹配的本地 PDB 解析模块相对地址。`FixtureHotMix` 命中 23,536 个采样，占该应用采样的 98.08%。14,167 个应用采样带栈，其中 13,825 个包含 `RunFixtureBatch → FixtureBatchLoop → FixtureHotMix`。9,829 个应用采样没有栈，除一个外都出现在最后一个带栈的应用采样之后。ETL 头部的 `EventsLost=0` 和 `BuffersLost=0` 与栈覆盖率是独立指标。该次符号验证覆盖测试 DLL 的原生函数。

本机 PerfView 4.0.0 的 `SaveCPUStacks` 写出可读、含三个已解析函数的 XML ZIP，随后在 `ExecuteUserCommand` 中抛出 `NullReferenceException` 并退出 1。实测用同版 TraceEvent 按精确进程实例独立提取和复核有栈样本，并用匹配 PDB 按采样指令地址复核热点计数。

## ETL 事件检查

调用 `vs2015_perfview_report`，指定 `analysis:"eventsXml"`、采集返回的 `inputPath`、已安装的 `perfViewPath` 和 `dryRun:false`。返回 XML、原始分析日志及结构化 `eventSummary`，并写入 history。`eventContentValidated:true` 表示实际导出 XML 已完整解析；不会修改采集 receipt 中原有的验证结论。

2026-11-20（UTC+08:00）真实 WP8.1 ETL 公开工具回归返回 10,941 事件、145 CPU sample 事件、17 未解码事件、39 进程生命周期观察。`traceHeaders` 原样保留 EventsLost/BuffersLost，缺失字段表示未知。`samplesByObservedPidAndName` 仅聚合观测到的 PID/name；PID 可能重用，需结合 `processObservations` 中 UniqueProcessKey 和时间线核对。它不能单独建立包与进程映射，也不输出推断的 CPU 毫秒或已符号化应用热点。

解析禁止 DTD/外部实体，最多读取 256 MiB XML，并限制分组和生命周期记录数。`summaryTruncated` 与 omitted 计数表示摘要限制；完整 XML 和分析日志保留供离线检查。未解码事件按 unresolvedEventCount 计数，不视为已识别 provider。缺少 GC/分配事件不能推断为零活动。
