# 编译诊断、性能采集与历史比较

本扩展使用 PowerShell 7 调用本机 VS2015 CLI。先调用 `vs2015_discover`、`vs2015_profiler_discover` 和 `vs2015_processes`，根据实际工具、权限和目标进程选择路径。PID 属于宿主 Windows；XDE 的 CPU／内存不代表手机客体应用。

## 数据来源与能力

| 目标 | 工具／来源 | 边界 |
|---|---|---|
| 编译错误、警告、文件和行列 | `vs2015_build_diagnostics`，MSBuild 14 ILogger | 直接订阅构建事件，消息保留原语言 |
| CPU、Private Bytes、Working Set 趋势 | `vs2015_profile_sample`，进程计数器 | 得到进程和时间区间，不推断函数热点 |
| 分配量、各代 GC 次数 | 同一采样工具，Framework CLR 原始计数器 | 不是逐对象分配记录；现代 .NET／手机客体不适用 |
| CPU 函数／调用栈 | VSPerf → VSPX 内 ETL → PerfView 离线报告 | VSPerf 实采需要管理员；当前机器尚未验证整条链路 |
| 旧性能文件的函数／Type／Life 表 | `vs2015_profiler_report`，VSPerfReport | 输入限真实 `.vsp`／`.vsps`；取决于原始采集是否包含相应事件 |
| CLR GC 事件统计 | `vs2015_perfview_report` 的 `gcStats` | 输入必须已有 CLR ETW 事件；GCStats 不提供按类型的分配热点 |
| dump 中的托管类型内存统计 | `vs2015_debug_dump`，`heapSummary:true` | 需要 CDB、匹配的 SOS/DAC 和包含堆内存的 dump，见调试指南 |
| 跨版本／操作比较 | `vs2015_profile_compare`、`vs2015_hotspots_compare` | 校验采集口径；不把时间关联解释为因果 |

## MSBuild 错误与警告

调用 `vs2015_build_diagnostics`，参数继承 `vs2015_msbuild`：

```json
{"path":"D:/work/App/App.sln","properties":{"Configuration":"Debug"},"maxCpuCount":4,"timings":true}
```

返回原生退出码、`runId`、`artifactId` 和 `diagnostics`。每条诊断保留 code、file、line/column、endLine/endColumn、project、原消息以及并行节点上下文。使用 `vs2015_diagnostics_read` 按 severity/code 分页读取。缺日志、被取消或日志损坏时，不能从空列表推出“没有错误”；检查 `complete`、计数和退出码。

Logger 在首次使用时通过已安装的 Framework `csc.exe` 编译，引用实际 MSBuild 14 Framework 程序集。输出 JSONL 使用独立路径和序列边界；缓存 DLL 路径不能包含 MSBuild logger 语法分隔符 `;`、`,`，必要时设置 `VS2015_MCP_LOGGER_CACHE`。目标耗时可能跨节点重叠，不能相加当作构建 CPU 时间。MSBuild 14 不支持新版 `/bl`，本实现不依赖该开关。

## 记录操作并对照历史

1. 用 `vs2015_history_create` 创建运行，填写有意义的 `operation`、可比较的 `context`，把提交号放在独立的 `revision`。例如 context 可包含目标、构建配置、架构、数据集及输入规模，字段由调用方定义。
2. `vs2015_processes` 取得目标 PID／启动时间。开始 `vs2015_profile_sample`，传入 runId、processId、durationMs、intervalMs、includeClr。采样期间并发调用 `vs2015_record_action`，包装已有 MCP 工具。客户端必须允许这两个请求重叠。
3. `vs2015_profile_summary` 接收采样 artifactId，可加 `actionId`，只统计完全落在该动作窗口内的采样区间。
4. 用相同 operation/context/settings 建立下一次运行。`vs2015_profile_compare` 的 baseline 和 candidate 分别传 `{runId,artifactId,actionId?}`；`groups` 可选 `cpu`、`memory`、`clr`。旧记录缺采集版本／设置时需要重新采集才能比较。
5. `vs2015_history_list`、`vs2015_history_read`、`vs2015_history_artifact` 可读取历史、时间线和原始诊断结果。

采样工具返回前会生成快照；历史分析重新检查 SHA-256。取消采样保留可获得的部分数据并标为不完整。CPU 百分比以单逻辑核为 100%，同时提供整机容量口径。CPU 与 CLR 查询存在时差，各自使用实际区间；内存峰值不除以时间。GC 各代累计次数不能相加当作总次数。缺 CLR 实例返回 unavailable/null，不制造 0。

动作开始／结束表示 MCP 调用边界。特别是 `phone_input` 返回 issued 并不表示界面已经完成渲染；需要应用完成事件或后续状态核验来定义业务完成时间。很短的操作可能没有完整采样区间。后台活动也可能落在同一窗口内。

## 函数／类型热点报告

性能工具默认 `dryRun:true`，先查看真实路径和 argv，再显式执行。

### Windows 10 CPU 管线

`vs2015_profiler_capture` 对已存在的宿主 PID 进行有限时长的 VSPerf CPU 采样，使用 `/attach:<pid>` 和独立 `/file:<path>`。结束使用 `/detach`，不使用会终止目标的 `/stop`。需要已提升权限的 MCP 进程，并且采集期间独占 VS profiler。普通服务会返回 `PERMISSION_REQUIRED`，不会自动提权。

后端检查已有 ETW 会话、独立输出路径及会话身份；不能确认所有权时不会发送全局 detach。VSPerf 的固定 collector 无法与用户另行启动的 VS profiler 完全隔离，因此不能并发改变 profiling 会话。内部会话名来自本机 14.x 实现；其他版本不匹配会拒绝确认。采集目录保留 `session.json`、清理状态和恢复计划。取消先通知后端清理；硬终止／断电仍可能留下会话，不能忽略 ownership 条件直接执行恢复命令。

本机 EtwMon 程序集的静态检查显示 VSPX 通过 ZipArchive 封装合并后的 ETL。`vs2015_trace_extract` 枚举实际归档内容，有多个 ETL 时要求指定准确 `entryName`；只向独立 UUID 路径复制选中的流，检查字节上限。这个实现证据不是微软对 VSPX 格式的长期承诺。`traceValidated:false` 表示只完成容器提取，没有验证事件／符号质量。

把提取的 ETL 交给 `vs2015_perfview_report`：

```json
{"analysis":"cpuStacks","inputPath":"D:/traces/trace.etl","processName":"MyApp","perfViewPath":"D:/tools/PerfView.exe","dryRun":false}
```

`cpuStacks` 导出 PerfView XML stack source；`cpuCsv` 导出 CSV；`gcStats` 导出 GC HTML 和各进程 CSV。原始 ETL 先复制到历史目录；ZIP 输入先安全提取选中的 ETL，多 ETL 时传 `entryName`，`maxTraceBytes` 限制展开字节数。这样避免 PerfView 把 ZIP 的报告写到共享缓存。使用 NoGui/NoView 执行，原始目录不写报告。为兼容旧 Framework 的 MAX_PATH，内部使用短文件名，过长的历史目录会明确报错，应选择较短的 `VS2015_MCP_HISTORY`。

CPU 内置导出选择最后一个同名实例，并非 PID＋启动时间筛选；GCStats 包含全部 CLR 进程，PID 重用也可能影响其输出命名。必须核对实际进程范围。

PerfView CSV 会改写名称中的逗号，`Inc` 是 count，不是 InclusiveMetric，数值受文化设置影响。保留原报告并核对列和单位；需要无损调用栈时保留 XML／ETL。此扩展不启动 PerfView 实时 collect：其失败路径会内部调用影响其他会话的 Abort。

### 旧 VSP 报告与比较

`vs2015_profiler_report` 可选 summaryTypes、csv/xml、processId、startMs/durationMs、symbolPath。它为每次输出创建新目录，不把 `.vspx`／ETL 改扩展名送给 VSPerfReport。

需要原生差异表时，可用 `vs2015_profiler_cli` 调用 VSPerfReport 的 `/Diff`＋`/QueryDiffTables`，查询当前版本的表／列后再指定 `/DiffTable` 和 `/DiffColumn`。此受限入口还提供帮助、状态和只读 VSInstr `/DumpFuncs`；不开放全局 start/stop、插桩或 PackSymbols 修改输入文件。

要纳入统一历史比较，先 `vs2015_report_inspect` 查看 CSV 的实际表头，然后 `vs2015_hotspots_import` 明确选择 symbolColumn/valueColumn/moduleColumn、编码、分隔符和小数格式，同时声明 metric、unit、valueSemantics、attribution、collector、scope、settings、durationMs。工具不猜英语列名。`valueSemantics` 区分 total/rate/ratio/gauge；只有累计总量能按时间或操作数归一化。

`vs2015_hotspots_compare` 校验操作、context、单位、归属方式、采集器和设置。完整报告中缺失行才可视为 0；截断／Top-N 报告必须 `complete:false`，缺失行保持未知。基线为 0 时百分比变化为 null。inclusive 调用栈数值不能跨帧求和；非总量报告出现重复模块／符号键会拒绝隐式相加。

Private Bytes、Working Set、分配字节、堆中对象大小和 retained size 是不同指标。本版本不提供分配调用栈自动提取、对象引用图／dominator 分析，也不据内存增长自动下泄漏结论。

## 官方来源与兼容验证

- [MSBuild loggers](https://learn.microsoft.com/en-us/visualstudio/msbuild/build-loggers)、[并行日志](https://learn.microsoft.com/en-us/visualstudio/msbuild/writing-multi-processor-aware-loggers)：事件接口；另用本机 MSBuild 14 编译和真实构建验证兼容。
- [.NET Framework 性能计数器](https://learn.microsoft.com/en-us/dotnet/framework/debug-trace-profile/performance-counters)：GC／分配／内存计数语义，适用 Framework。
- [VS2015 的 Windows 8+ 性能工具边界](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/profiling/performance-tools-on-windows-8-and-windows-server-2012-applications?view=vs-2015)、[VSPerf](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/profiling/vsperf?view=vs-2015)、[VSPerfReport](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/profiling/vsperfreport?view=vs-2015)：采样后端、停止语义和旧报告格式。
- [PerfView v4.0.0 UserCommands](https://github.com/microsoft/perfview/blob/v4.0.0/src/PerfView/UserCommands.cs)、[导出实现](https://github.com/microsoft/perfview/blob/v4.0.0/src/PerfView/Extensibility.cs)、[collect/Abort 实现](https://github.com/microsoft/perfview/blob/v4.0.0/src/PerfView/CommandProcessor.cs)：固定版本的离线命令、CSV 局限与内部清理行为。
- [WNODE_HEADER](https://learn.microsoft.com/en-us/windows/win32/etw/wnode-header)、[ControlTraceW](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/nf-evntrace-controltracew)：会话身份与限定会话清理。

2026-11-17（UTC+08:00）已验证真实 MSBuild 错误／警告、Framework 分配与 GC 计数、宿主采样、MCP 历史比较及取消。随后取得微软签名 PerfView 4.0.0，并用[微软 Framework 测试 trace](https://github.com/microsoft/perfview/blob/v4.0.0/src/TraceEvent/TraceEvent.Tests/inputs/net.4.5.2.x64.etl.zip) 实测 GC HTML/CSV、CPU 函数 CSV，以及“实际报告→MCP 热点导入→历史对照”。该固定文件的 Git blob SHA1 为 `a81addc5158e6f2e643f2b393c1eb7ff5582de31`，不是本机新采集的数据。

CDB 也已验证自有 Framework x64 进程快照与完整 dump 堆统计。当前令牌未提升权限，VSPerf 实时 ETW 采集／detach、真实 VSPX 采集链路仍未端到端验证。
