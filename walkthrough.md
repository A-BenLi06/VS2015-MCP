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


## 2026-11-17T18:41:23+08:00 — v0.2.1 接入配置与双目标边界
更新文档为本轮真实验证结果，并提供手机客体性能接入现状（WP8.1 CoreCon/WpWpr、Win10M Device Portal/WPR，未实现实采，不误称宿主计数为客体热点）。Print-McpConfig新增显式PerfView/Debugger/History路径，并修复PATH中多个node/pwsh导致配置command/env成为数组的问题；始终选择首个实际命令来源。版本更新0.2.1。验证：25项单元测试通过；真实PerfView CPU/GC/历史对照、CDB自有进程快照和dump测试通过；配置与调试集成2项通过；由生成配置启动MCP确认45工具、5资源且发现实际CDB/PerfView。无遗留PerfView/CDB/测试fixture进程。当前仍未验证管理员VSPerf实时采集与手机客体采集。


## 2026-11-17T20:08:28+08:00 — 对接 VS2015-MCP 远端并启用提交后自动推送
保留原 origin 指向 MetroApp-developing-skill，新增 vs2015-mcp 远端。因远端 main 是独立初始提交，与本地历史无共同祖先，在 codex/vs2015-mcp 分支发布现有项目历史，避免覆盖远端 main。AGENTS.md 现在要求每次提交后推送当前分支上游，首次发布分支时设置 upstream，并禁止 force-push。验证：已读取远端 main 并确认两侧无共同祖先；本次提交推送后将确认上游及工作区状态。

## 2026-11-17T20:28:04+08:00 — 修复审查 A：嵌套比较丢字段
确认JSON.stringify属性白名单会遗漏嵌套context/settings，改为共享递归规范化，保留数组顺序，并让热点与进程比较使用同一逻辑。新增ARM/x86嵌套差异、数组顺序、空值及属性重排回归。验证11项历史/进程比较测试通过。


## 2026-11-17T20:28:46+08:00 — 修复审查 B：历史结果状态一致
在性能结果落盘前完成退出码/超时提升及不完整采集错误归类，确保即时响应和历史工件是同一最终状态。真实文件工件回归覆盖partial、native失败/超时和已有取消错误，测试通过。


## 2026-11-17T20:39:39+08:00 — 持久 VS2015 IDE 自动化
新增Framework x86 C# STA常驻桥接、WinForms消息循环、ROT按PID/启动时间连接、跨桥接实例租约、有界COM busy重试与事件订阅。新增20项IDE工具覆盖活动解决方案/配置平台、文档未保存编辑与冲突检查、事件驱动build/rebuild/clean/deploy、ErrorList/Output、断点/运行/暂停/单步/停止、线程/栈/locals/表达式和带游标等待。Node串行队列取消不重放、超时仅终止桥接并作废会话，不关闭IDE。编译器动态发现VS14安装及本机interop引用，不含二进制依赖。实测发现clean后异步Build调用可能被VS忽略，rebuild改为固定标准IDE命令，仍校验RebuildAll事件。强化订阅失败回滚、Dispose释放租约、COM回调异常不误报成功。验证：5项真实子进程生命周期回归通过；自有TEMP VS2015实例通过完整MCP编辑→重建→警告/输出→断点→变量21/42→单步→停止→detach，用户原有3个IDE未操作。


## 2026-11-17T20:40:44+08:00 — IDE租约与取消的实机回归
扩展IDE端到端测试：两个独立MCP客户端连接同一自有IDE时第二个收到SESSION_BUSY，首个detach后第二个可接管；取消等待断点只结束等待，IDE仍保持design且后续工作流可用。同时检查活动平台。完整MCP编辑/重建/断点/单步回归通过。


## 2026-11-17T20:41:21+08:00 — 环境独立 CI
新增GitHub Actions单元测试矩阵（Windows/Linux、Node22/24），锁定官方checkout/setup-node提交，工作流仅read权限。实机VS2015/Hyper-V测试继续本机显式运行，不在托管runner冒充通过。验证：本机npm test共32项通过；工作流已按官方动作参数配置，推送后检查实际运行。


## 2026-11-17T20:44:44+08:00 — IDE关闭后的清理
将detach移到PID存活检查前，确保IDE退出或RPC断开后仍能释放事件源与租约。常见RPC断连HRESULT单独返回IDE_DISCONNECTED；stdin读取线程结束标志使用volatile。验证：修改前后的完整自有IDE MCP流程通过，随后仅对已核实PID/启动时间/路径且无未保存文档的测试IDE执行Quit并清理；实测关闭阶段先出现RPC服务器断开，未误判成操作成功。更新桥接重新编译通过。用户原有3个IDE保持运行。CI四个Windows/Linux、Node22/24组合已全部通过。


## 2026-11-17T20:47:34+08:00 — v0.3.0 IDE Automation 发布说明
增加IDE指南与逐项审查跟进，记录真实会话/事件/编辑/调试工作流、取消/模态/断连恢复、CLI与IDE诊断边界及手机端仍未验收事项；不把桌面调试实测等同手机客体闭环。版本更新0.3.0，65工具/6资源握手实测通过；旧45工具保留。CI四个矩阵已成功，构建诊断/历史/MCP取消3项相关回归通过。仓库默认分支、PhoneSession/客体部署断点、持久手机输入与通用秘密检测未在本轮完成，文档明确列出。


## 2026-11-18T11:43:16+08:00 — 连接发布分支历史
核实远端main仅有LICENSE且与开发分支无共同祖先，使用正常合并连接两条历史；保留两份原有版权署名，MIT正文不变，不重写提交。这样后续可以经常规PR将完整工程合入默认main，而不是强推覆盖初始化历史。验证：main树确实仅LICENSE，合并冲突仅该文件；git diff --check通过。


## 2026-11-18T11:45:20+08:00 — IDE可靠性：断点所有权与构建协调
断点改为observed/owned分离并以COM身份跟踪，列举不授予所有权，普通删除拒绝用户断点；优雅detach/EOF清理本会话owned断点并校验辅助Tag。Add前保留实际断点身份，防止将返回的旧断点认领。新增buildReconcile只在IDE实际idle时将丢完成证据的active记录标unconfirmed并释放自动化锁，不猜成功、不停止构建。构建历史限制64条并报告淘汰数量；documents返回activeDocument。验证：专用IDE PID65284中disabled手动断点不能删且detach后保留，新建owned断点被清理；真实idle状态harness验证70条记录保留64/淘汰6、协调不伪造成功；旧完整MCP编辑/重建/断点/变量/单步流程通过。


## 2026-11-18T11:47:35+08:00 — 用户断点保护的可重复实机测试
新增受owned-instance身份约束的真实桥接回归及独立STA手动断点helper：观察不授权、拒绝删除用户断点、相同位置Add先拒绝避免改变disabled设置、detach/EOF自动清自己断点。状态harness使用真实idle IDE和测试自身内存账本验证丢事件协调及64条上限，无产品testhook。全部实机通过；只改专用TEMP fixture，手动测试断点已删除。


## 2026-11-18T11:53:52+08:00 — 项目系统配置与递归发现
新增独立ProjectSystem partial，递归发现Solution Folder中的真实项目，返回活动配置/平台/启动项目和configurationToken。新增受token与expectedValue保护的配置/启动项目/项目属性设置；从实际属性发现调试目标，未硬编码通用手机属性。新增项目级BuildProject/DeployProject入口并记录配置/平台、项目scope和唯一名。验证：真实TEMP嵌套Library被发现，Release→Debug切换与过期token拒绝、folder不能作启动项目、StartArguments精确值冲突/恢复、nested project-scope构建事件完整成功。实机MCP回归通过；项目级部署待手机实际事件验证，未据编译结果宣称部署通过。


## 2026-11-18T11:57:45+08:00 — 冷启动期限与内容寻址缓存
将编译/进程启动/STA ready握手与具体请求计时分离，默认初始化120秒，排队/操作预算在ready后开始；初始化取消不分发、迟到子进程只清理桥接。编译器按全部partial源码、引用、Framework编译器/支持文件hash缓存，互斥并发写入、原子发布，复用前校验产物清单和hash，损坏明确拒绝。增加EnvDTE90a实际9.x引用，为源码帧导航提供能力；错误码保留。验证10项真实子进程回归通过，实际并发缓存/源码失效/篡改拒绝集成通过；真实MCP配置/嵌套构建流程在新ready协议下通过。


## 2026-11-18T11:59:42+08:00 — 暂停上下文与源码帧导航
新增独立DebugNavigation partial，使用EnvDTE90a StackFrame2取得源码文件、行和Depth；线程/帧ID与pauseId及debugprogram绑定，恢复执行、新断点或切program时作废。新增显式select_thread/select_frame，locals/evaluate可验证预期暂停/帧；Locals2(false)避免隐式属性展开。验证：真实MCP在Compute返回行16定位源码/depth1，切换另一线程并还原，选择caller Main8/depth2读input21，再选择Compute读result42；单步后旧pause/frame拒绝，测试通过并清理owned断点。


## 2026-11-18T12:02:49+08:00 — 受保护的小范围编辑
新增DocumentEditing partial与document_edit，按1起始UTF-16行列/排他结束位置批量应用不重叠区间；全缓冲SHA和可选expectedText在写前校验，使用本工具自己打开的UndoContext事务，异常回滚并核验，拒绝加入用户已有undo事务。read返回完整缓冲SHA，默认不落盘。验证：真实IDE带tab/中文/代理对emoji/CRLF的三处range正确修改，过期hash、重叠、越界均拒绝且缓冲不变，磁盘保持原样；测试通过并恢复保存专用文档。


## 2026-11-18T12:10:33+08:00 — IDE phone deployment event completion

- Accept the observed WP8.1 solution deployment preparation sequence (Build begin, Deploy done), while requiring the final matching Deploy event to confirm completion. A preparatory Build done alone keeps deployment pending and explicit reconciliation records an unconfirmed outcome.
- Validation: real WP8.1 solution deployment completed with LastBuildInfo=0; the owned IDE reliability integration passed, including missing-Deploy rejection, manual breakpoint preservation and bounded build history.

