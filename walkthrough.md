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

## 2026-11-16T23:58:51+08:00 — 接入说明、官方来源与验证边界

- 新增README、微软官方来源支持的深入CLI指南和手机指南，说明版本差异、标识映射、部署/输入完整流程，以及XDE本机反射与公开文档的证据区别。
- 新增动态生成本机MCP配置的PowerShell脚本；服务提供两份可读MCP resource，便于客户端获取详细用法。
- 验证：配置中的可执行文件与入口路径存在；真实MCP客户端确认20项工具、2份指南资源均可读取。
- 补充Win10M实测：通过MCP读取运行状态（shell/tools pipe仍false），发送Close成功，随后确认本次验证XDE进程已退出。未将未就绪设备的输入/应用操作标为通过。

## 2026-11-17T16:31:29+08:00 — 性能历史与热点比较数据层

- 新增不可覆盖的run/artifact/event文件存储、原始报告快照与SHA256，以及显式列映射/编码/数值区域规则的CSV导入。
- 比较先校验操作、上下文、采集器、指标单位和归因方式，再按时间或工作量归一化；缺失的截断报告行标未知，基线为零不输出虚假的百分比。
- 验证：3项历史/并发事件/本地化CSV/归一化与不兼容拒绝测试通过；修复BOM在引号前的解析问题。

## 2026-11-17T16:35:46+08:00 — 进程 CPU、内存及 CLR GC 时间序列

- 新增只读进程采样器，校验PID与启动时间，写入带完整结束标记的JSONL；通过语言无关的CIM CLR原始计数器读取分配与各代GC计数。
- 分析使用实际采样间隔计算CPU、分配与GC增量，计数器回绕/丢失标未知；只把操作时间窗内完整区间用于关联，不把进程计数器伪称函数热点。
- 验证：2项时间序列测试及PowerShell语法通过；自建.NET Framework分配fixture实测6秒采集8样本，CPU/内存/CLR均取得，测试进程已清理。

## 2026-11-17T16:40:42+08:00 — 将操作与性能历史接入 MCP

- 新增历史创建/查询、实际工具操作记录、进程采样/按操作摘要、CSV列检查、热点导入和基线比较工具。操作记录仅持久化参数字段名与结果状态，避免把凭据值写入历史。
- 原始CSV快照与结构化热点一同保留；操作时间窗只选完全位于其中的采样区间，明确时间相关性不等于因果。
- 验证：5项数据层测试通过；真实MCP客户端完成创建两轮历史→记录实际解决方案检查→导入本地化报告→对比归一化差值，集成通过。

## 2026-11-17T16:44:22+08:00 — MSBuild 14 结构化构建诊断

- 加入针对MSBuild14编译的ILogger，记录错误/警告代码、原始语言消息、文件起止行列、节点上下文和可选target耗时；使用独立缓存和base64日志参数。
- 新增vs2015_build_diagnostics与分页筛选读取；缺失尾记录、坏序号或截断均显式标不完整，不会把缺日志当零错误。
- 验证：logger真实多节点/中文/精确位置/截断/防覆盖/空格DLL路径验证通过；2项汇总测试与真实MCP故意失败项目（1警告1错误、历史筛选）通过。

## 2026-11-17T16:49:18+08:00 — 修正性能比较完整性与采样口径

- 独立审查复现百分比二次归一化、首样本峰值丢失、CLR延迟跨越动作窗口、并发清单未发布和非法样本误报完整；逐项修复并加入回归。
- 热点必须声明total/rate/ratio/gauge语义；只对累计量做曝光归一化。历史JSON原子发布，CLR使用自身采样时间，缺字段/坏时间/坏JSON不再标完整。
- 完整和中断采样均可落为artifact，原始证据快照带SHA256并在重新读取时核验。
- 验证：7项数据/并发/口径/MCP历史回归全部通过。

## 2026-11-17T16:55:00+08:00 — CLI debugging integration
Added debugger inventory, CDB dump/non-suspending live snapshot/initial-loader snapshot tools and an explicit VS2015 IDE handoff. Raw transcripts and failures are recorded as history artifacts. Fixed command sets isolate startup scripts and distinguish target lifecycle; no persistent stepping is claimed. Validation: real Windows inventory, dry-run argv/lifecycle and missing-CDB integration test passed (1 test). Actual CDB execution remains unverified because it is not installed.


## 2026-11-17T16:58:17+08:00 — Cooperative profiler cancellation
Added an opt-in stop-file grace period to the PowerShell bridge so profilers can detach and publish recovery state before forced termination. Cancellation keeps backend cleanup evidence; SIGINT/SIGTERM await owned children. Existing build tools retain immediate process-tree cleanup. Validation: cooperative abort/disconnect fixture passed, and real MSBuild MCP cancellation plus stdin EOF both passed with no remaining owned PIDs.


## 2026-11-17T16:59:58+08:00 — Historical diagnostic evidence
Build logs now use copied SHA-256 snapshots for re-reading and return explicit incomplete diagnostics on changed evidence. Interrupted builds retain artifact references; a generic history artifact reader makes saved debugger/profiler results accessible. Validation: real MSBuild MCP diagnostics integration passed, including deliberate snapshot tampering detected with unknown counts rather than false zero errors.


## 2026-11-17T17:08:36+08:00 — VS2015 profiler CLI and trace pipeline
Added Performance Tools discovery/help/status, bounded VSPerf CPU attach/detach with ownership checks and cooperative cancellation, VSPerfReport CSV/XML export and fixed offline PerfView CPU/GC reports. PerfView live collection is excluded because its internal failure cleanup can stop unrelated sessions. VSPX/ETL.zip extraction enumerates actual entries and streams only a selected ETL to a unique path with byte bounds. Distinct trace and artifact paths avoid overwriting return references. Validation: real profiler inventory/help, dry-run filters/capture, non-admin refusal and unsupported-command tests passed; archive multi-entry/size/traversal regressions passed. Real elevated ETW capture, detach and PerfView analysis remain unverified; CDB/PerfView were not installed and no live ETW sessions were started.


## 2026-11-17T17:10:21+08:00 — Compare CPU memory and GC by operation
Added profile_compare with source verification and operation/context/collector/settings/action matching. CPU and CLR use independent observed time windows; memory peaks stay absolute. CLR intervals crossing only the CPU window boundary are now included correctly, while missing/reset CLR coverage is explicit. Non-total hotspot duplicate keys are rejected instead of summing ratios/rates/gauges. Validation: 14 tests passed including real MCP process sampling/comparison, missing-CLR rejection, snapshot tampering, window boundaries and normalization regressions.


## 2026-11-17T17:12:16+08:00 — Managed heap type statistics from dumps
Added optional offline Framework SOS heapSummary to CDB dump analysis using !eeheap -gc and !dumpheap -stat, with explicit runtime validation. It reports heap/type statistics in the raw transcript and does not claim allocation history or retained-size analysis. Validation: debugger integration dry-run commands and invalid runtime rejection passed; real dump analysis still requires CDB and a suitable full-memory dump.


## 2026-11-17T17:12:49+08:00 — Discover profile targets through MCP
Added host process inventory with optional name filtering, PID/start-time identity and explicit inaccessible details. This completes target selection through MCP without relying on an external shell and distinguishes host PIDs from mobile guest apps. Validation: actual process discovery plus MCP sampling/history comparison integration passed.


## 2026-11-17T17:16:24+08:00 — v0.2 documentation and final validation
Published Chinese diagnostics/performance and debugging guides with Microsoft documentation, fixed-version PerfView sources, local VSPX implementation evidence, workflows, measurement semantics and explicit validation limits. Updated README and package/server version to 0.2.0, exposing four MCP guide resources. Final checks: 24 unit tests passed; 15 integration tests passed and 1 opt-in live-emulator screenshot test skipped; prior real cancellation/EOF checks both passed with no remaining owned processes. Release MCP handshake reported version 0.2.0, 45 tools and 4 readable resources. No CDB/PerfView installation or elevation was attempted; real debugger and elevated profiler execution remain environmental validation gaps.


## 2026-11-17T18:16:33+08:00 — 本机优先与可复现 PerfView 准备
用户确认本机进程和 WP8.1/Win10M 都需要，先推进本机实际验证。新增显式版本的官方 PerfView 获取脚本：校验 GitHub release SHA-256、文件大小与 Microsoft Authenticode，仅发布到独立用户目录，不修改 PATH/注册表/客户端。实测取得 4.0.0，hash=270e2ba419b0b2d93c4b15b0851f257edf655c92fe0ad95add3d0b5f6d6aad48，签名 Valid；供后续离线报告验证。


## 2026-11-17T18:29:54+08:00 — PerfView 真正离线报告闭环
使用微软 PerfView v4.0.0 仓库的 net.4.5.2.x64.etl.zip（Git blob SHA1 a81addc5158e6f2e643f2b393c1eb7ff5582de31）实测，发现ZIP输入的GCStats写入PerfView全局缓存，原封装找不到产物；修为先由既有安全提取器生成独立ETL，再NoGui/NoView分析。合并冗余目录并使用短文件名，为旧Framework分析器保留MAX_PATH报告后缀空间，超长路径明确拒绝。提取器新增内部JSON参数/管道返回，保持stdio单一JSON协议。验证：真实GC HTML/CSV、CPU CSV生成，实际函数数据经MCP导入历史并自对照为零差异；新增可选runtime集成与归档回归共2项通过。未启动ETW采集。


## 2026-11-17T18:30:56+08:00 — 独立用户目录中的官方 CDB
加入已验证版本的 Windows Debugger 获取脚本：从微软官方 MSIX bundle 用固定ETag/HTTP Range读取ZIP目录及x64最小依赖，限制下载量/展开大小、验证CRC与全部PE微软签名后发布；不运行installer、不修改PATH、不提权。固定包版本1.2611.4001.0用于可复现兼容性，不代表自动追随latest。实测仅下载14,352,637字节，20个PE签名Valid，CDB -version退出0（10.0.29680.1004）。实际自建Framework x64进程已生成完整dump并取得SOS类型堆数据；fixture全部清理。脚本PS/Node语法检查通过。


## 2026-11-17T18:34:20+08:00 — 真实 CDB 快照与堆诊断兼容性
实测当前CDB遇非侵入-pvr与-pd组合会在访问目标前退出且exit=0。按非侵入会话不建立debug port的语义，仅snapshot移除冗余-pd，保留-pvr/qd；不把此改动作为侵入式附加的降级路径。缺完成标记现在返回DEBUG_REPORT_INCOMPLETE，即使原生exit为0。增加VS2015_MCP_DEBUGGER_ROOT显式路径配置。验证：新建Framework x64 fixture通过真实MCP取得托管栈，目标保持存活并在测试finally清理；真实120MB自有dump通过MCP取得System.Byte[]与SOS堆表。补充zero-exit回归通过。系统符号不完整，未把!analyze根因判断计作已验证。


## 2026-11-17T18:34:53+08:00 — 固定调试器提取边界
审查便携CDB获取器时进一步限制动态扩展DLL名称为普通文件名字符，并在每次写入前验证解析后的绝对路径仍位于本次暂存目录；不依赖上游ZIP条目名称可信。Node语法检查通过；不重新下载或替换已经验签的工具。

