# Windows Phone 8.1与Windows 10 Mobile模拟器指南

手机工具覆盖已安装SDK的发现、CoreCon设备连接、XDE模拟器状态与截图、定向输入，以及部署CLI。主服务使用PowerShell7；XDE/CoreCon通过32位Windows PowerShell5.1桥运行，以匹配本机旧SDK的x86 .NET Framework程序集。单次 phone 工具每次请求启动桥接，phone_session 工具为每个目标复用独立的持久桥接。每个桥接固定所选 XDE SDK。

基础手机工具定义见 `src/phone.mjs`，持久会话及 WPR 工具定义见 `src/phone-session.mjs`。示例中的 `selectedDevice`、`running`、包路径和应用标识均应来自当前发现结果或实际构建产物；不要照抄其他机器的名称、语言或进程号。

## 字段与工具

XDE/CoreCon工具的共有字段为 `timeoutMs`（默认120000，范围1000–600000毫秒）和可选 `xdeRoots`。`xdeRoots` 用于额外安装根目录；目录下应有各版本的XDE安装子目录。

| 工具 | 主要字段与行为 |
|---|---|
| `phone_discover` | 共有字段；发现XDE版本、部署工具及当前XDE进程，返回验证过的 `processId`、`vmName` |
| `phone_devices` | 共有字段、可选 `localeId`；枚举CoreCon设备配置及稳定 `deviceId` |
| `phone_start` | `deviceId`、可选 `localeId`；超时默认300000；由SDK连接选定模拟器，必要时启动它 |
| `phone_status` | `processId`；读取VM状态、shell/工具管道就绪状态、guest分辨率、host显示区域、缩放与设备按钮 |
| `phone_endpoint` | `processId`；读取选定模拟器的host与guest IP，不会启用或配对Device Portal |
| `phone_screenshot` | `processId`、可选 `path`、`includeImage`（默认true）；捕获guest PNG并可返回MCP图像 |
| `phone_input` | `processId`、`action` 及下表对应字段；只作用于选定XDE实例 |
| `phone_stop` | `processId`；向选定XDE请求Close，返回请求状态；关闭后应重新发现确认 |
| `phone_apps` | `deviceId`、可选 `localeId`、`action:list/launch/terminate/uninstall`；后三项还需 `productId` |
| `phone_cli_help` | `tool:appdeploy/xapdeploy/winappdeploy` 与CLI共有字段；读取已安装工具帮助 |
| `phone_cli` | `tool`、`arguments:string[]` 与CLI共有字段；原样执行明确发现的部署工具argv |
| `phone_deploy` | `platform:wp81/win10m`、`action` 及相应平台字段；结构化部署与目标发现入口 |

CLI共有字段为 `timeoutMs`（默认120000，范围100–3600000）、`maxOutputChars`（默认64000，范围256–1048576）、可选 `toolPath`、`workingDirectory`、`encoding`，以及 `dryRun`（默认false）。`toolPath` 支持非默认SDK安装路径；指定文件必须与所选部署工具一致。普通XDE/CoreCon工具没有 `dryRun` 字段。

## 标识不能互换

| 标识 | 来源 | 用途 |
|---|---|---|
| CoreCon `deviceId` | `phone_devices` | 选择已安装设备/模拟器配置；用于start与apps |
| XDE `processId` | `phone_discover` 的运行实例 | 当前宿主XDE进程；用于status、endpoint、截图、输入、stop；重启后必须刷新 |
| AppDeploy `target` | WP8.1 `/EnumerateDevices` | 当前部署工具的数字索引字符串，或其 `xd`/`de` 选择器；不是CoreCon GUID |
| WinAppDeploy `guid` / `ip` | Win10M `devices` 结果 | 选择部署目标；`guid` 不能因为外形相同就替换成CoreCon deviceId |
| 应用 `productId` | 应用清单或CoreCon应用列表 | WP应用ProductID GUID；用于相应launch/uninstall等操作 |
| `packageFullName` | Win10M `list` 或Portal包列表 | 带版本等信息的包完整名称；用于WinAppDeploy卸载；不是ProductID |

Device Portal另有应用PRAID/PackageRelativeId等标识。不要把设备ID、应用GUID、PackageFamilyName、PackageFullName合并成一个通用“ID”字段。

## 完整工作流程

### 1. 发现安装、配置与运行实例

调用 `phone_discover` 确认XDE、CoreCon相关环境和部署工具，再调用 `phone_devices` 选择需要的模拟器配置。界面名称由SDK返回；仅在需要特定已安装语言时提供 `localeId`，不要固定某个语言编号。

已有合适运行实例时可直接使用它的 `processId`，不必再次启动。设备配置已安装，不代表相应VM当前已启动；VM已经Enabled，也不代表手机shell已经就绪。

### 2. 连接或启动选定模拟器

以下是调用参数示意，而不是可直接粘贴的客户端程序：

```javascript
phone_start({ deviceId: selectedDevice.deviceId })
phone_discover({})
phone_status({ processId: running.processId })
```

SDK根据配置选择镜像、内存、屏幕尺寸、语言及差分磁盘，工具不会根据显示名称猜参数。CoreCon连接可能等待guest握手。`phone_start` 超时后先重新调用 `phone_discover` 和 `phone_status`，因为XDE或VM可能已经启动；不要立即重复创建启动请求。

重点检查 `shellReady` 和 `toolsReady`。`shellReady:false` 时输入工具会拒绝操作；工具管道状态还影响文本等依赖guest通道的能力。若需要部署地址，再调用 `phone_endpoint`，使用返回的guest地址，而不是假设模拟器固定使用某个IP。

### 3. 截图并取得坐标系

```javascript
phone_screenshot({ processId: running.processId })
```

默认在临时目录生成唯一PNG，并在不超过4MiB时附带MCP图像。`includeImage:false` 只返回文件信息；较大图像仍可通过返回的本地路径查看。显式 `path` 在Node层解析为绝对路径；现有文件仅在新截图实际生成且可解码后才被替换。

截图是guest手机显示内容。输入使用guest像素坐标，不能直接使用桌面截图中的坐标。`phone_status.display` 为guest坐标范围；`hostDisplayBounds` 与 `zoomPercent` 描述宿主显示区域。缩放或移动模拟器窗口不应使调用方改用宿主桌面坐标。

### 4. 输入并复核效果

| `phone_input.action` | 字段 |
|---|---|
| `tap` | `x`、`y`，可选 `durationMs` |
| `swipe` | `x`、`y`、`toX`、`toY`，可选 `durationMs` |
| `key` | `keys:string[]`、`mode:Type/Press/Release`（默认Type） |
| `text` | `text`，长度1–8192；通过SDK文本输入接口发送 |
| `button` | `button`，使用status返回的设备按钮名称 |

坐标必须在guest显示范围内。tap默认保持80毫秒，swipe默认400毫秒；自定义 `durationMs` 范围1–10000。输入后再次截图确认实际界面变化：`issued:true` 表示API已调用，不保证guest已经响应，因为部分XDE版本内部会吞掉输入失败。

`Type` 对数组中的每个键分别执行按下/松开，因此两个元素不是组合键。键名必须是Windows Forms Keys枚举中的有效虚拟键，范围1–255；不接受数值字符串、未定义枚举或 `Control`/`Shift`/`Alt` 这样的高位组合标记。修饰键使用 `ControlKey`、`ShiftKey`、`Menu`。

例如发送Ctrl+A，应按顺序调用，并保证最后释放修饰键：

```javascript
phone_input({ processId: running.processId, action: "key", keys: ["ControlKey"], mode: "Press" })
phone_input({ processId: running.processId, action: "key", keys: ["A"], mode: "Type" })
// 无论中间步骤成功与否，最后都调用Release。
phone_input({ processId: running.processId, action: "key", keys: ["ControlKey"], mode: "Release" })
```

### 5. 部署到WP8.1

先调用 `phone_cli_help({tool:"appdeploy"})`，再用 `phone_deploy({platform:"wp81",action:"devices"})` 获取当前部署目标索引。

WP8.1结构化部署字段如下：

| `action` | 必要字段 |
|---|---|
| `devices` | 无目标字段 |
| `install` / `installlaunch` / `update` / `updatelaunch` | `target`、`package` |
| `launch` / `uninstall` | `target`、`productId` |

`target` 是发现结果对应的数字字符串，或CLI支持的 `xd`/`de`；需要确定实例时优先使用本次枚举的明确索引。`package` 是实际XAP/APPX产物路径。可先加 `dryRun:true` 查看计划，再正式调用。

这些命令对应 `AppDeployCmd /<action> <包路径或ProductID> /targetdevice:<target>`。较早 `XapDeployCmd` 仅支持其本机帮助列出的XAP操作，不能沿用AppDeploy的所有action；需要它时使用 `phone_cli` 的 `tool:"xapdeploy"` 和字面量参数数组。

### 6. 部署到Windows 10 Mobile

调用 `phone_cli_help({tool:"winappdeploy"})` 和 `phone_deploy({platform:"win10m",action:"devices"})`。除devices外，每次请求必须在 `ip` 和 `guid` 中指定且只指定一个。需要配对时提供本次设备生成的 `pin`；返回计划会隐藏PIN。

| `action` | 其他字段 |
|---|---|
| `install` | `package`；可选 `dependencies:string[]` |
| `update` | `package` |
| `list` | 无包字段 |
| `uninstall` | `packageFullName`，从list结果获取 |

`dependencies` 仅支持install。部署工具不会替代项目构建，也不会把任意桌面包转换为Mobile包。WinAppDeploy不提供launch、截图或输入命令；这些需求应使用相应的XDE/CoreCon能力。[官方WinAppDeploy指南](https://learn.microsoft.com/en-us/windows/uwp/packaging/install-universal-windows-apps-with-the-winappdeploycmd-tool)

`phone_cli` 可用于本机帮助已经确认、结构化 `phone_deploy` 尚未覆盖的参数。传入一个元素对应一个原始argv参数，不要拼接shell命令或为路径重复添加人为引号。不同SDK版本可能支持不同开关。

### 7. 应用生命周期与关闭模拟器

`phone_apps({deviceId,action:"list"})` 返回CoreCon暴露的应用列表；需要launch、terminate、uninstall时提供其中的 `productId`。该操作先连接设备，可能启动尚未运行的模拟器，所以应用列表工具并非保证无副作用的纯文件读取。

CoreCon应用身份与Windows10 UWP包身份不完全相同。只有当所需应用被当前CoreCon API正确暴露时，才能使用该入口；不能承诺所有UWP应用都可由ProductID操控。需要PackageFullName/PRAID的UWP流程可参考下方Device Portal方案。

结束后通过当前 `processId` 调用 `phone_stop`，再重新发现确认目标实例是否关闭。Close请求可能影响未保存的guest应用状态；不要把“请求已发出”当作VM已经完成关机的证据。

## XDE版本适配：已知API与证据

| 能力 | XDE8.1 | XDE10.0.14393 |
|---|---|---|
| 连接运行实例 | `AutomationClient.CreateAutomationClient(vmName)` | 相同入口 |
| 截图、状态、地址、Close | AutomationClient公开成员 | AutomationClient公开成员 |
| 键盘、鼠标、设备按钮 | AutomationClient公开输入成员 | `XdeFeatureAutomationClient<IXdeAutomationInput>` 的FeatureProxy |
| 文本 | `InputPipe.SendText` | 输入FeatureProxy的SendText |

以上XDE成员来自已安装微软程序集的本机反射与有限运行验证，不应描述成微软承诺稳定的公开自动化SDK。CoreCon的旧微软文档说明了平台/设备模型，本项目再通过安装的程序集确认具体成员。[微软Device模型文档](https://learn.microsoft.com/en-us/previous-versions/visualstudio/visual-studio-2008/bb310870(v=vs.90))

本机XDE8.1实现使用Hyper-V的合成鼠标接口处理guest坐标。微软正式文档确认SetAbsolutePosition使用像素，并且输入设备通过VM关联定位；这支持避免依赖宿主窗口位置的设计，但不等于证明所有XDE/guest组合都已经实测通过。[SetAbsolutePosition](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/setabsoluteposition-msvm-syntheticmouse)、[Hyper-V输入设备](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/input-classes)

## 验证范围与未就绪状态

WP8.1 与 Win10M 已在专用 TEMP 应用中完成 IDE 构建、解决方案及项目部署、guest 输入、断点、locals、单步、恢复和截图。两个平台的持久会话也已同时运行，核对独立身份、关闭一个会话后另一个继续工作及清理结果。

2026-11-19（UTC+08:00）新增 WP8.1 XAML 和 WPR 公开 MCP 实机验证。XAML 覆盖树与子树、文本写入、一次 Invoke、旧节点拒绝及恢复后的截图。WPR 覆盖状态、CPU profile 启动、停止、ETL 下载、SHA256 和历史 artifact 一致性。v0.5.0 已实现 Win10M Portal 适配与 HTTP 回归，真实设备 WPR 仍待验证。

2026-11-20（UTC+08:00）补充：Win10M 14393 的模拟器 shell 滑动未通过本轮验证，鼠标路径只改变焦点，SDK 触摸原型请求超时。既有应用点击验证不能证明通用 shell 触摸手势；未将未确认的触摸实现合入。

CaptureImage 未生成产物时会返回错误。可结合 shellReady、toolsReady、SDK/镜像及 Hyper-V 状态检查已有实例。

## Device Portal

Windows Mobile Device Portal从Windows10 Mobile1511开始提供，需要设备上开启开发者模式、发现与Portal。WP8.1没有同等Portal。官方列出USB与局域网连接方式及初次配对流程；地址应取自设备设置或实际端点信息。[Mobile Device Portal官方说明](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/debug-test-perf/device-portal-mobile)

启动模拟器与启用 Portal 是两个步骤。先用 `phone_devices` 选择配置并调用 `phone_start`，再刷新 `phone_discover` 的进程身份，检查 `phone_status` 的 shellReady/toolsReady，并用 `phone_screenshot` 确认手机画面。随后在手机设置的开发者页面检查 Device Portal 和实际连接地址；模拟器就绪不代表 Portal 已监听。TCP 超时不能单独证明 Portal 未启用，也可能是网络不可达。

`phone_session_portal_*` 工具使用持久 PhoneSession。`phone_session_portal_connect` 要求先绑定 CoreCon GUID/locale，并用实际 guest IP 提供 `baseUrl`。协议和端口来自设备设置，不自动探测或假定；微软文档中的 `http://127.0.0.1:10080` 是 USB 转发地址，不能直接替换为模拟器 guest IP。当前会话绑定不接受 localhost 转发端点。HTTP 需 `allowInsecureHttp:true`；HTTPS 默认保持证书和主机名校验，可通过 `caPath` 提供 PEM CA。`usernameEnv/passwordEnv` 指定服务进程的 Basic 认证凭据变量名，不能直接传密码；浏览器配对状态不会自动传递给 MCP。工具拒绝重定向，不启用 Portal，也不自动重试变更请求。

需要保留模拟器供人工设置或继续调试时，只调用 `phone_session_close` 释放 MCP 会话，并核对 `vmClosed:false`；`phone_stop` 会请求关闭模拟器。重启后必须重新读取 processId/startTimeUtc/vmId，不能沿用上次运行的会话参数。

Win10M 14393 实测生成的证书可能缺少现代 CA/SAN 扩展，提供 `caPath` 后仍可能报 `INVALID_PURPOSE`。这种目标可显式提供 `certificateSha256`（叶证书 DER 的 SHA-256，64 位小写十六进制），与 `caPath` 互斥。此模式以已核对的完整叶证书作为目标身份，替代 CA 链和主机名验证；每次请求先检查指纹及证书有效期，再发送任何 HTTP 内容，包括凭据。证书变化、到期、尚未生效及握手取消均在请求分发前拒绝，不自动更新指纹。调用方应从可信设备通道核对指纹；工具不会把未认证下载自动当成信任。返回的 `transportTrust` 和采集 receipt 记录实际信任模式。默认 HTTPS 验证不变，也不修改系统证书库。

Mobile 14393 未配对时，API 会以 307 跳转到同源 `/authenticate.htm`；工具将它报告为 `PORTAL_AUTH_REQUIRED`，不自动跟随。需要配对时，先在手机点击 Pair，再通过服务进程的环境变量提供当次六位码，并将变量名传入 `pairingPinEnv`。它与 Basic 凭据互斥，必须使用 HTTPS；只请求一次非持久配对（`persistent=0`）。验证码与返回的认证 Cookie 不进入结果/history，Cookie 仅在当前客户端内存中使用，关闭时清除。协议来自实际设备提供的 authenticate.js，不能把 Basic 用户名/密码或其他浏览器的登录状态当作 Mobile 配对结果。

`phone_session_portal_read` 的 `resource` 可选 `os`、`packages`、`processes`、`systemPerformance`、`etwProviders`、`profiles`、`traceFiles`，保留原始 JSON 并返回 history artifact。端点不支持、认证失败与连接超时分别报错。调用前核对原 VM/进程/CoreCon 地址对与连接时的 OS 信息。

下表列出相关官方 API。当前工具覆盖包列表和 OS 读取，Portal 包部署及应用启停尚未开放；已有 CoreCon/部署工具继续适用。

| HTTP请求 | 用途 |
|---|---|
| GET `/api/app/packagemanager/packages` | 获取包列表及PackageFullName、PackageRelativeId |
| POST `/api/app/packagemanager/package` | 发起APPX安装；还需轮询安装状态 |
| GET `/api/app/packagemanager/state` | 查询安装是否完成或失败 |
| DELETE `/api/app/packagemanager/package` | 卸载指定包 |
| POST `/api/taskmanager/app` | 通过appid/PRAID与package启动现代应用 |
| DELETE `/api/taskmanager/app` | 按package停止现代应用 |
| GET `/api/os/info` | 读取操作系统信息 |

微软文档明确列出这些相关API的Mobile支持；任意PID终止则没有Mobile支持。核心参考没有提供可直接推广到Mobile的截图或触控接口，不能把Xbox或HoloLens端点套用过来。[Device Portal核心API](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/device-portal-api-core)

taskmanager/app所需的 `appid` 和 `package` 在文档中称为hex64编码。微软官方wrapper的 `Hex64Encode` 实际使用UTF-8字节的Base64；构造URL时还需正确转义查询值。它与CoreCon ProductID GUID不是同一套身份参数。[TaskManager源码](https://raw.githubusercontent.com/microsoft/WindowsDevicePortalWrapper/main/WindowsDevicePortalWrapper/WindowsDevicePortalWrapper.Shared/Core/TaskManager.cs)、[编码实现](https://raw.githubusercontent.com/microsoft/WindowsDevicePortalWrapper/main/WindowsDevicePortalWrapper/WindowsDevicePortalWrapper.Shared/Utilities.cs)

### Portal WPR

1. `phone_session_portal_wpr_status` 返回 `status`、`profiles` 及两份指纹。status 必须为 `idle`、mode 为 `normal`。
2. 从实际 profile JSON 中选择供 API 使用的 profile 名称字符串，以 JSON Pointer 传 `profilePointer`。例如返回 `{"profiles":[{"id":"actual-profile"}]}` 时使用 `/profiles/0/id`；这是格式示例，字段名和值应以设备响应为准。传 `observedStatusFingerprint`、`profilesFingerprint`、`operation` 和 `exclusiveGuest:true` 调用 start，保存 `captureId`。
3. 执行应用操作后调用 stop，提供同一 captureId 和 exclusiveGuest。它只分发一次，确认 Idle 后返回直接 ETL 或新增文件的 `candidateFiles`。
4. 没有直接 `trace` 时调用 download；多个候选必须传实际 `filename`。下载失败可重试 download，不能重放 stop。文件保存到历史目录并计算 SHA256；事件内容用 PerfView `eventsXml` 继续检查。

WDP 没有远端所有权 token，也不返回采集实例的可靠唯一身份。工具的本地 captureId、VM 校验和前后文件列表依赖持续独占该客体的前提，无法排除外部工具在两次观察之间替换同类采集。不确定响应保留 receipt 和 `operationMayContinue`；关闭会话报告可能继续的采集，不能用新连接接管旧 captureId。Stop/download 可在 IDE 已退出时执行，仍检查 guest 身份。

## 持久 PhoneSession

从 `phone_discover.running` 获取 `processId`、`startTimeUtc` 和 `vmId`，传给 `phone_session_open` 的 `processId`、`expectedStartTimeUtc` 和 `expectedVmId`。CoreCon 绑定使用 `phone_devices` 返回的 GUID 及相同 `localeId`。打开时和后续操作时都核对 XDE 与 CoreCon 的 host/guest 地址对。

`ideBinding` 使用已连接 IDE 的 `sessionId`、实际 `projectUniqueName`、目标 GUID 属性的 `targetPropertyName` 和 `scope`。清单由项目实际包含的已保存 Appx 文件解析。`phone_session_ide` 允许列表包含构建、调试、文档、客体身份和 XAML 工具。它会复核配置、启动项目、清单 SHA256 和目标属性。`vs2015_ide_guest_app_identity` 在暂停客体中读取 SDK 包身份，匹配时返回 `guest-matched`，其余调用报告 `project-only`。

`phone_session_input` 复用 SDK 输入句柄，Press 持有状态跨请求保存。`phone_session_close` 释放本会话持有的键及连接，并返回清理信息。截图使用 guest 像素坐标和原子文件替换。

## WinRT XAML 自动化

在托管 XAML UI 线程暂停后，向 `vs2015_ide_xaml_tree` 传当前 `pauseId` 和可选 `frameId`。树根为 `Window.Current.Content`，可用上次树中的 `rootNodeId` 请求子树。`maxDepth` 相对所选根，`maxNodes`、`maxChildren`、`queryTimeoutMs` 控制遍历范围。检查 `partial`、`truncated` 和 `warnings`。

`vs2015_ide_xaml_action` 接受本次快照的 `nodeId` 和 `action`。`invoke` 使用 InvokePattern，`setValue` 使用 ValuePattern，`setText` 对启用且可编辑的标准 TextBox 写入 Text 并回读。文本操作还需 `value`。SDK 求值可能执行应用代码，读取过程也可能触发 getter。新快照、执行恢复和动作分发都会使旧节点失效。使用动作返回的新 `pauseId` 继续检查。`issued` 表示调用已返回，`confirmed` 表示文本回读一致，按钮处理结果需另行观察。

## WP8.1 Guest WPR

先调用 `phone_session_wpr_status`，保存 `observation.status.fingerprint`。首次调用会部署并启动已安装的 developer agent。start 接受 `operation` 说明、`exclusiveGuest:true`、指纹和 `profiles:["cpu"]`。原生状态为 unknown 时，调用方可在明确独占该 guest 的前提下传 `allowUnknownStatus:true`。已有采集会被拒绝，外部 profiler 客户端仍可独立改变 WPR 状态。

记录 start 返回的 `captureId`，执行应用操作后调用 `phone_session_wpr_stop`，同时传 `exclusiveGuest:true`。Stop 重新核对 profile 集合，下载唯一 ETL。返回的 `trace.path`、`trace.bytes`、`trace.sha256` 和 `trace.headerPlausible` 描述文件证据，`eventContentValidated:false` 提示需要离线解析。使用 `vs2015_history_artifact` 可按返回的 runId/artifactId 读取相同结果。长历史路径触发 `GUEST_WPR_PATH_TOO_LONG` 时可通过 `VS2015_MCP_HISTORY` 指定较短根目录。

错误中的 `operationMayContinue:true` 表示命令可能已经执行。检查 receipt 和 native status，避免重放 start/stop。关闭期间若采集可能继续，会返回 `GUEST_WPR_CAPTURE_MAY_CONTINUE` 及 receipt 路径。中断后的原始 receipt 和命令日志保存在历史目录，恢复时必须重新核对设备与采集归属。

## 可重复实机测试

XAML fixture 可通过 `test/fixtures/New-Wp81Fixture.ps1 -XamlAutomation` 创建。将它打开在专用 VS2015 中，设置 Debug/x86 和明确的模拟器目标，启动对应自有模拟器。`VS2015_TEST_WP81_XAML_CONTEXT` 指向 TEMP 内 JSON，包含 `ownsIde:true`、`ownsXde:true`、`fixtureManifest`、`ide:{processId,startTimeUtc}`、`phone:{processId,startTimeUtc,vmId,coreConDeviceId,localeId}`、`targetPropertyName`、fixture 的 `invokePauseLine` 和实际截图确认的 `tap:{x,y}`。执行 `node --test test/integration/phone-xaml-runtime.test.mjs`，检查输出目录中的 results.json 和 PNG。

`VS2015_TEST_WP81_WPR_CONTEXT` 指向 TEMP 内 JSON，包含 `ownsXde:true`、`exclusiveGuest:true`、`processId`、`startTimeUtc`、`vmId`、`coreConDeviceId`、`localeId` 和按实际原生状态决定的 `allowUnknownStatus`。执行 `node --test test/integration/guest-wpr-runtime.test.mjs`。测试会采集五秒 CPU profile、下载 ETL、校验 SHA256、核对历史记录并关闭会话。模拟器由创建它的调用方管理。

`VS2015_TEST_WIN10M_PORTAL_CONTEXT` 使用 TEMP 内自有测试设备 JSON，同样提供 `ownsXde:true`、`exclusiveGuest:true`、processId/startTimeUtc/vmId/CoreCon/locale，另加 `baseUrl`、按实际连接选择的 `allowInsecureHttp`、可选 usernameEnv/passwordEnv/caPath 或 certificateSha256、从设备目录选择的 `profilePointer`。执行 `node --test test/integration/portal-runtime.test.mjs`，它通过公开 MCP 读取进程、性能、包并完成五秒采集、下载、hash/history 一致性和清理。仅对独占测试客体启用；默认跳过。

需要本机交互输入 Mobile 配对码时，在上述 TEMP 上下文加入 `pairingPinEnv` 变量名，然后用 PowerShell 7 运行 `./scripts/Test-MobilePortal.ps1 -ContextPath <context.json>`。脚本掩码读取六位码，仅通过子进程环境传给 MCP，退出后恢复原环境变量。省略 `profilePointer` 时会打印真实设备的 profile 目录并要求选择 JSON Pointer；选择后执行同一公开 MCP 验证链，结果写入打印的 TEMP 目录。脚本保留模拟器运行，不修改设备的 Portal/discovery/认证开关，也不保存 PIN 或配对 Cookie。

2026-11-20（UTC+08:00）本机专用 Win10M Portal 端口无响应，未完成上述真实端点回归。模拟 HTTP 生命周期、认证/CSRF、重定向拒绝、身份变化、超时不重放和下载恢复测试已通过；不以此宣称 Win10M WPR 实机成功。
