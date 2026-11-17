# VS2015 与命令行调试

先调用 `vs2015_debug_discover`。VS2015 的 `devenv`、`msvsmon` 与 CDB 各有用途：devenv 提供 IDE 入口，msvsmon 是远程调试监听器，CDB 才提供这里使用的批处理诊断。CDB 来自独立的 Debugging Tools for Windows；本扩展不会自动安装或启动远程监听。

| MCP 工具 | 行为 |
|---|---|
| `vs2015_debug_dump` | 离线 dump 异常上下文、线程栈、模块、分析；可用 Framework SOS |
| `vs2015_debug_snapshot` | 对已有宿主 PID 使用 `-pvr`，结束用 `qd`；线程保持运行，栈可能不一致 |
| `vs2015_debug_launch_snapshot` | 新建目标，在初始加载器断点取快照后结束新进程；不会运行到 Main |
| `vs2015_debug_ide_launch` | `devenv /DebugExe` 打开交互式 VS2015 调试器 |

CLI 工具明确要求 x86/x64 架构。可设置 debuggerRoot、symbolPath、imagePath、sourcePath、encoding、timeoutMs、maxOutputChars、dryRun；显式 debuggerRoot 错误时不回退。原始诊断转录写入 history，可用 `vs2015_history_artifact` 再读。

已安装的 Debugging Tools 可直接传 `debuggerRoot` 或设置 `VS2015_MCP_DEBUGGER_ROOT`。另提供 `scripts/Get-WindowsDebugger.ps1`：从固定的微软官方 WinDbg MSIX 包按 HTTP Range 提取经过验证的 x64 CDB 及依赖，验证全部 PE 的 Microsoft Authenticode 后发布到独立用户目录。它不运行安装器、不修改 PATH。当前固定包为 1.2611.4001.0；并未验证整个 MSIX 签名，只校验实际使用 PE 的签名及下载内容完整性。不覆盖已经存在的版本目录。x86／其他系统需另行选择匹配的调试器，不能据 x64 实测推断兼容。

托管诊断用 `managedRuntime:"clr"`（Framework 4）或 `"mscorwks"`（Framework 2/3.5），通过 `.loadby sos` 加载匹配扩展并查询线程、托管栈与异常。分析 heap 时：

```json
{"dumpPath":"D:/dumps/App.dmp","architecture":"x86","managedRuntime":"clr","heapSummary":true,"dryRun":true}
```

`heapSummary` 只对离线 dump 开放，执行 `!eeheap -gc` 和 `!dumpheap -stat`，得到 GC 堆与类型大小统计。需要 dump 实际包含堆页及匹配 SOS/DAC；普通 minidump 未必足够。类型大小不是 retained size，也不重建历史分配调用栈。输出中的扩展错误、缺内存和缺符号信息必须保留，不从空表推出堆为空。

现有目标快照结束用 `qd`；新建加载器快照用 `q` 终止那个新目标。脚本禁用 shell 命令并覆盖隐式启动文件。`reportCompletion` 仅表示转录结束标记到达；CDB 退出 0 不能证明每条扩展命令成功。没有持久调试会话、交互断点或单步控制；这些仍使用 VS2015 IDE。IDE handoff 不接收应用参数，应用参数通过 IDE 调试属性配置。

本机 CDB 10.0.29680.1004 在 `-pvr -pd` 组合下会在执行诊断前退出，且退出码仍为 0。本实现只在非侵入快照中移除冗余 `-pd`；缺少完成标记时返回 `DEBUG_REPORT_INCOMPLETE`。这不是侵入式附加失败后的自动退让。非侵入模式也不保证忙碌进程的栈／内存视图一致。

手机模拟器的启动、部署、触摸和截图继续使用 phone 工具。宿主 CDB PID 不能替代 WP8.1／Win10M 客体应用的远程调试连接。Win10M 输入和截图仍取决于 shell/tools pipe 是否就绪。

依据：[CDB 选项](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/cdb-command-line-options)、[非侵入式调试](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/noninvasive-debugging--user-mode-)、[结束 CDB 会话](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/ending-a-debugging-session-in-cdb)、[Framework SOS](https://learn.microsoft.com/en-us/dotnet/framework/tools/sos-dll-sos-debugging-extension)、[/DebugExe](https://learn.microsoft.com/en-us/visualstudio/ide/reference/debugexe-devenv-exe?view=vs-2022)。最后一项使用现行文档说明入口，并用本机 VS2015 文件／帮助确认存在性，不据此声称支持新版调试特性。

2026-11-17（UTC+08:00）已用微软签名 CDB 完成自建 Framework x64 进程的真实 MCP 快照，取得托管栈且目标保持运行；还从自建进程的完整 dump 取得 SOS 堆表，确认 16 个保留对象和约 16 MiB 数组。测试进程均已清理。OS 符号未配齐，因此没有确认 `!analyze` 的根因分析结果；原始缺符号／退出警告保留。
