# 手机客体性能：已核对的接入路径

手机模拟器操控与手机应用性能采集使用不同通道。已有 phone 工具负责启动、部署、输入、截图等；`vs2015_profile_sample` 和本机 CDB 面向宿主 PID。把 XDE 的 PID 传给它们只能测模拟器宿主进程，不能代表 WP8.1／Win10M 应用。

WP8.1 已通过 `phone_session_wpr_status/start/stop` 提供 CPU profile 客体采集。下表同时列出已实现通道和后续平台接入路径。

| 平台 | 可继续接入的客体通道 | 当前证据与限制 |
|---|---|---|
| WP8.1 | Developer Power Tools → CoreCon 服务 → WpWpr → ETL | 本机有 x86/ARM guest helper、服务和 Recorder/Monitor 组件；需连接、部署并启动客体服务 |
| Win10M 1511+ | Device Portal 进程指标、ETW、WPR | 有公开 API；需先启用、配对并探测目标 OS 实际支持的功能 |
| 两类平台的托管堆 | VS 手机 MemoryProfilerCollectionAgent | 已找到对应架构的客体 agent 与 CoreCon 部署定义；独立命令行编排及结果解析尚未验证 |

WP8.1 SDK 的 `Tools/PowerTools/Support/{x86,ARM}/WpWpr.exe` 是**客体程序**。已从本机微软组件确认 `startWpr` 服务命令及 `-start`、`-stop`、`-status`、`-cancel` 协议，不能在宿主直接执行，也不能把 UI 中出现 Heap profile 视为已采集到托管分配调用栈。新建 CoreCon 服务连接可能部署并启动 guest agent，因此不是纯只读动作。

Win10M 可探测 `/api/resourcemanager/processes`、`/api/resourcemanager/systemperf`、`/api/etw/providers`、`/api/wpr/status`。WPR profile 应来自目标设备，不能假定与桌面相同。特别注意：**`GET /api/wpr/trace` 是停止采集并写出 ETL，状态查询是 `/api/wpr/status`。** 已在采集的设备不能自动接管或取消。WPR 同一设备只有一个会话且没有所有权 token，本地锁无法隔离外部工具。

CPU 曲线、工作集、Private Bytes、GC 事件、分配类型与对象引用图是不同数据。GC／类型热点取决于实际客体运行时、provider 和 profile；UWP .NET Native 也不能套用桌面 CLR 计数器。客体 ETL 的符号分析需要对应手机系统二进制、PDB 及进程身份。SDK 内的 CPU/NativeMemory agent 存在并不等于已提供可用的通用 CLI。

来源与适用范围：

- [Windows 10 Mobile Device Portal](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/debug-test-perf/device-portal-mobile)：Mobile 1511 起的门户、连接和配对；WP8.1 没有同一门户。
- [Device Portal Core API](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/device-portal-api-core)：进程、ETW、WPR 路径和 Mobile 支持标记。
- [VS 中的 WP8.1 性能分析](https://devblogs.microsoft.com/devops/performance-profiling-on-windows-phone-8-1-with-visual-studio/)：WinRT 与 Silverlight 工作流不同，Memory/Energy 依赖相应更新；模拟器性能不等同真机。
- [Memory Usage 工具](https://devblogs.microsoft.com/devops/diagnosing-memory-issues-with-the-new-memory-usage-tool-in-visual-studio/)：类型、快照差异和引用分析的实际含义。

SDK 内部协议经过已安装组件检查和 WP8.1 实机验证，适配器用 agent 8.1 握手限定支持范围。Win10M Device Portal 接入仍待实现。

## 已验证的 WP8.1 Guest WPR

持久 PhoneSession 通过 XDE PID、启动时间、Hyper-V VM GUID、CoreCon GUID/locale 和 host/guest endpoint pair 固定客体。phone_session_wpr_status 保留 native output 和 fingerprint，phone_session_wpr_start 只接受类型化的 cpu profile，phone_session_wpr_stop 只接受本控制器返回的 captureId。真实验证返回了 4 MiB ETL，EventsLost=0、BuffersLost=0，PerfView 离线 XML 中包含 CPU sample 事件。

这条 profile 的证据覆盖客体采集生命周期和 native/module sample。当前报告仍将 managed GC、managed heap、symbol completeness 和应用热点归因标为未验证。Win10M 需要其对应的 Portal 接入与运行验证。