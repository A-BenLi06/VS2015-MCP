# Visual Studio 2015 命令行工作指南

本 MCP 将 VS2015、MSBuild 14、测试运行器、VC 和 Windows SDK 工具连接到同一个可发现、可预览的执行入口。先确认安装版本和项目配置，再选择构建工具。VS2015 文档已归档；现代 Microsoft Learn 页面中的新参数不代表旧工具也支持。[微软的 VS2015 文档归档说明](https://learn.microsoft.com/en-us/visualstudio/vs-2015-archive?view=visualstudio)

## 工具入口

本版本提供 8 个 `vs2015_*` 工具；手机模拟器与部署的 12 个 `phone_*` 工具另见手机指南。

| MCP 工具 | 用途与主要字段 |
|---|---|
| `vs2015_discover` | 发现工具、版本与缺失组件；可选 `vsRoot`、`architecture`、`sdkVersion`、`store`、`setupTimeoutMs` |
| `vs2015_inspect_solution` | 读取 `path` 指定的解决方案，列出真实项目名与配置；不执行项目 imports |
| `vs2015_tool_help` | 获取指定 `tool` 的本机帮助，确认当前 Update/SDK 的开关 |
| `vs2015_msbuild` | `path`、`targets`、`properties`、`hostArchitecture`、`maxCpuCount`、`verbosity`、`preprocess`、`additionalArguments` |
| `vs2015_devenv` | `solution`、`action`、`configuration`、`project`、`projectConfiguration`、`logFile` |
| `vs2015_vstest` | `containers`、`listTests`、`settings`、`tests`、`filter`、`platform`、`framework`、`adapterPath`、`trx` |
| `vs2015_mstest` | `containers`、`tests`、`settings`、`resultsFile`、`additionalArguments` |
| `vs2015_native` | 对发现的 `tool` 传递字面量 `arguments` 数组，覆盖专用工具未建模的合法 CLI 参数 |

执行类工具共有字段包括 `vsRoot`、`architecture`、`sdkVersion`、`store`、`workingDirectory`、`timeoutMs`、`setupTimeoutMs`、`maxOutputChars`、`encoding`、`dryRun`。`vsRoot` 可显式指定安装根目录；设置错误时会失败，不会静默切换到其他 VS。也可通过服务环境变量 `VS2015_MCP_ROOT` 指定默认根目录。

`dryRun:true` 会解析工具和开发环境，再返回命令计划，但不执行目标工具。它不是完全不启动子进程的离线字符串生成器。`setupTimeoutMs` 单独约束旧开发环境初始化；`timeoutMs` 约束目标工具。输出截断后不要把“未看到错误”当成成功，应检查退出码、超时状态和完整文件日志。

## 从发现到构建

1. 调用 `vs2015_discover`，确认发现的是 VS2015/MSBuild14，而不是 PATH 中的其他版本。
2. 调用 `vs2015_inspect_solution`，从结果选择实际存在的解决方案配置和项目名。
3. 调用 `vs2015_tool_help` 阅读本机参数；使用 `dryRun` 检查工作目录、目标工具及 argv。
4. 执行构建并检查退出状态；需要诊断时增加日志详细度或输出文件。

下面是参数构造示意。`solutionPath`、`selectedConfiguration` 和 `selectedPlatform` 均应来自当前项目与发现结果，不是固定名称。

```javascript
vs2015_msbuild({
  path: solutionPath,
  targets: ["Build"],
  properties: {
    Configuration: selectedConfiguration,
    Platform: selectedPlatform
  },
  verbosity: "minimal",
  dryRun: true
})
```

`architecture` 选择宿主开发环境，例如 `x86`、`amd64` 或交叉工具环境；`hostArchitecture` 只决定使用32位还是64位 MSBuild。`properties.Platform` 则是项目/解决方案的平台名称。这三者不是同一个设置，不能因为选择64位 MSBuild就自动把项目平台改成 x64。

## MSBuild 14：构建、诊断和属性

`vs2015_msbuild` 固定加入 `/nologo` 和 `/nr:false`，减少遗留构建节点滞留。`targets` 对应 `/t:`，`maxCpuCount` 对应 `/m:`，`verbosity` 对应 `/v:`。常用目标有 Build、Rebuild、Clean；其他目标应以项目实际定义为准。项目可以运行自定义任务，预览参数不等于验证项目执行内容。[VS2015 MSBuild 命令行参考](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/msbuild/msbuild-command-line-reference?view=vs-2015)

`preprocess` 对应 `/pp:<输出文件>`：汇总项目及导入的 targets/props，适合定位导入路径和属性来源，本次不会执行构建。它保留展开后的项目结构，不是现代 `/getProperty` 的替代查询接口。不要仅凭原始 XML 文本推断最终条件求值结果。

`properties` 是开放字典。结构化入口对 `% $ @ ( ) ; , ? ' *` 做 MSBuild 百分号转义，每个属性独立成为一个 `/p:name=value` 参数。例如字面值 `A;B` 会传为 `A%3BB`，字面 `%` 会成为 `%25`。调用方应提供原始属性值，不要提前转义，否则会重复编码。该入口适合传递字面数据，不会把 `$(...)` 当成需要主动求值的表达式。

`additionalArguments` 和 `vs2015_native.arguments` 是原始 argv：不会补做 MSBuild 值转义，也不会把单个字符串拆成多项。需要表达式、复杂 logger 或响应文件时，按相应工具语法自行构造这些参数。shell 引号与 MSBuild 转义解决的是不同层次的问题。

文件日志可通过一个完整 argv 参数传入，例如：

```text
/flp:LogFile=<本次日志路径>;Verbosity=diagnostic;Encoding=UTF-8
```

尖括号表示待替换的实际路径。MSBuild 文件 logger 的分号是它自己的参数分隔符；日志路径若含这类字符，须按工具语法处理。`diagnostic` 可能输出环境和构建属性，分享日志前应检查其内容。预先创建日志目录，并为不同构建选择不同文件，便于区分结果。

### 工具集不是目标框架

`ToolsVersion` 选择 MSBuild tasks、targets 和相关工具；`VisualStudioVersion` 影响工具集/项目系统的版本上下文。托管项目的目标 .NET Framework 是另一项项目设置，C++ 的 `PlatformToolset` 和 Windows SDK版本也另有作用。不要把所有字段都统一改为 `14.0` 来解决兼容问题。先检查缺失的 targeting pack、SDK、VC工具和项目 imports。[VS2015 ToolsVersion 文档](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/msbuild/msbuild-toolset-toolsversion?view=vs-2015)

MSBuild14入口不默认使用现代 `/restore`、`/bl`、`/getProperty` 或 `.slnx`。旧项目的 NuGet恢复应按项目采用的包管理方式单独处理；`vs2015_native` 可调用已发现的 `nuget`，但不会自动下载 NuGet或猜测恢复策略。

## devenv.com：需要 IDE 项目系统时

微软对常规构建推荐 MSBuild；依赖 IDE项目系统的解决方案可使用 `vs2015_devenv`。本工具运行 `devenv.com`，因为它提供标准输出与错误流；直接运行 `devenv.exe` 会绕过这一控制台封装。[VS2015 devenv开关](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/ide/reference/devenv-command-line-switches?view=vs-2015)

```text
devenv.com <解决方案> /Build <解决方案配置>
devenv.com <解决方案> /Rebuild <解决方案配置>
devenv.com <解决方案> /Clean <解决方案配置>
devenv.com <解决方案> /Deploy <解决方案配置>
```

`configuration` 应使用解决方案实际配置，必要时包含平台部分。`project` 可为项目显示名、相对解决方案的项目路径或绝对路径。`projectConfiguration` 必须同时指定 `project`。[Build](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/ide/reference/build-devenv-exe?view=vs-2015)、[ProjectConfig](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/ide/reference/projectconfig-devenv-exe?view=vs-2015)

`logFile` 对应 `/Out`，已有文件会被追加。为每次调用生成新日志路径，避免旧错误混入本次判断。[Out](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2015/ide/reference/out-devenv-exe?view=vs-2015)

专用 `vs2015_devenv` 工具仅建模 Build/Rebuild/Clean/Deploy；它不是完整的 IDE调试会话、断点或编辑器自动化接口。

## VSTest与MSTest

`vs2015_vstest` 接受编译好的测试容器，不会自动先构建。可先用 `listTests:true` 检查发现结果，再执行。`tests` 与 `filter` 不能同时指定；`trx:true` 默认启用 `/Logger:trx`。`settings`、`adapterPath`、`platform` 和 `framework` 应与测试程序集及安装的 adapter相匹配。

不要只根据退出码0认定测试有效执行：还应检查发现/执行数量及 TRX。MSTest adapter处于 legacy模式时，不支持 TestCaseFilter；`.testsettings` 等配置可能影响运行模式。[VSTest官方说明](https://learn.microsoft.com/en-us/visualstudio/test/vstest-console-options?view=vs-2022)

`/Parallel` 是 VS2015 Update2 才增加的开关。若要通过 `additionalArguments` 使用，先检查本机帮助，不能假定所有VS2015安装都支持。现代 `/Blame`、新的 framework简写和其他新开关也不应直接移植。[VS2015 Update2发布说明](https://learn.microsoft.com/en-us/visualstudio/releases/2015/vs2015-update2-vs)

`vs2015_mstest` 为旧测试工作流保留 `MSTest.exe`：`containers` 生成多个 `/testcontainer:`；`tests` 生成多个 `/test:`；`settings` 对应 `/testsettings:`；`resultsFile` 对应 `/resultsfile:`。为结果文件选择新路径，并以当前可执行文件的 `/help` 或 `/?` 为最终兼容依据。旧文档中的能力不等于任意新版 runner兼容行为。[旧版MSTest参考](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2013/ms182489(v=vs.120))

## VC与SDK工具的进一步利用

`vs2015_native.tool` 支持：`devenv`、`msbuild`、`msbuild64`、`vstest`、`mstest`、`cl`、`link`、`lib`、`dumpbin`、`nmake`、`rc`、`mt`、`makeappx`、`signtool`、`nuget`。可用性由实际安装决定。

| 工具 | 可开展的工作 |
|---|---|
| `cl` / `link` / `lib` | 单文件编译、独立链接、静态库构建、响应文件驱动的重复构建 |
| `dumpbin` | 检查产物架构、导入依赖、导出符号；帮助区分编译与部署问题 |
| `nmake` | 执行项目已有 Makefile；不等于生成 VS解决方案 |
| `rc` / `mt` | 资源编译、清单处理；使用与目标平台匹配的SDK工具 |
| `makeappx` | APPX布局打包/解包；不负责完成项目编译、补齐依赖或自动签名 |
| `signtool` | 签名、验证与时间戳；选项需匹配安装版本及证书用途 |
| `nuget` | 使用已安装客户端进行项目所需的包操作 |

CL支持 `@响应文件` 和 `/link` 后续链接器参数，适合把较长的参数序列保存为可重复使用的文件。大部分CL选项区分大小写。[CL命令行语法](https://learn.microsoft.com/en-us/cpp/build/reference/compiler-command-line-syntax?view=msvc-140)

MakeAppx与SignTool的现代文档同时包含新SDK能力；为VS2015/Windows Phone工作流应检查本机帮助和目标系统支持，不要把MSIX、ARM64或新摘要算法规则当作旧SDK保证。[MakeAppx](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)、[SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)

## PowerShell 7与旧开发环境

VS2015的 `vcvarsall.bat` 位于安装目录的 `VC` 下；不能套用VS2017以后的 `VC\Auxiliary\Build` 布局，也不能把不同VS版本的环境初始化叠加在同一命令环境。`sdkVersion` 与 `store` 最终是否被支持，取决于本机批处理和已安装组件。[微软C++命令行环境说明](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line?view=msvc-140)

主执行层使用 PowerShell7；旧批处理仅用于构造相应子进程环境。普通工具使用分离的可执行文件路径和 argv，不通过 shell解释用户参数。参数数组元素不应再包裹一层人为引号；响应文件内容仍由对应工具自行解析。

PowerShell7.3改变了本机程序的参数传递规则，Windows模式对 `cmd.exe` 和批处理仍保留Legacy行为。`.NET ProcessStartInfo.ArgumentList` 可以为普通可执行文件处理参数转义，但不能使任意拼接的cmd语句安全或正确。[PowerShell解析规则](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.5)、[ArgumentList](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.argumentlist?view=net-9.0)

`encoding` 调整旧工具输出的解码，不强制修改其界面语言。自动化判断应优先依赖退出状态、结构化结果和产物，避免把某一种语言的成功提示硬编码为唯一判据。
