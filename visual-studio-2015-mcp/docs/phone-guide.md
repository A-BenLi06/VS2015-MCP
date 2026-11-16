# Windows Phone 8.1与Windows 10 Mobile模拟器指南

手机工具覆盖已安装SDK的发现、CoreCon设备连接、XDE模拟器状态与截图、定向输入，以及部署CLI。主服务使用PowerShell7；XDE/CoreCon通过32位Windows PowerShell5.1桥运行，以匹配本机旧SDK的x86 .NET Framework程序集。每次请求独立加载相应版本，避免把XDE8.1与XDE10的程序集混在一个进程中。

以下工具名和字段与当前 `src/phone.mjs` 一致。本版本共有20个MCP工具，其中12个属于 `phone_*`。示例中的 `selectedDevice`、`running`、包路径和应用标识均应来自当前发现结果或实际构建产物；不要照抄其他机器的名称、语言或进程号。

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

当前研究与后端测试已确认WP8.1的SDK枚举、运行实例发现、AutomationClient状态读取及真实guest PNG截图。部署命令计划和PIN隐藏可以独立验证，这不等于已在设备上安装应用。

Win10M的选定模拟器已由CoreCon启动，Hyper-V报告VM运行，AutomationClient连接并能列出输入相关feature。但测试时guest的 `shellReady` 与 `toolsReady` 仍为false，CaptureImage没有生成文件。因此当前不能把Win10M输入、实际截图、UWP应用启动、应用部署或Device Portal连接标为运行验证通过。不要反复调用start掩盖尚未完成的启动/握手问题。

若CaptureImage没有产物，截图工具应报错并保留原有目标文件，不会把上一次PNG当成新结果。先检查status、SDK/镜像兼容性、Hyper-V状态及可用内存；等待或进一步诊断已有实例，避免同时启动多个配置增加压力。

## Device Portal：官方备用方案，当前MCP尚未实现

Windows Mobile Device Portal从Windows10 Mobile1511开始提供，需要设备上开启开发者模式、发现与Portal。WP8.1没有同等Portal。官方列出USB与局域网连接方式及初次配对流程；地址应取自设备设置或实际端点信息。[Mobile Device Portal官方说明](https://learn.microsoft.com/en-us/previous-versions/windows/uwp/debug-test-perf/device-portal-mobile)

本MCP目前没有 `phone_portal_*` 或通用Portal HTTP工具。`phone_endpoint` 只返回地址，不会自动启用Portal、建立信任或完成配对。下表是可用于未来集成或外部客户端的官方API，不是当前工具名称。

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

taskmanager/app所需的 `appid` 和 `package` 在文档中称为hex64编码。微软官方wrapper的 `Hex64Encode` 实际使用UTF-8字节的Base64；构造URL时还需正确转义查询值。它与CoreCon ProductID GUID不是同一套身份参数。[TaskManager源码](https://raw.githubusercontent.com/microsoft/WindowsDevicePortalWrapper/master/WindowsDevicePortalWrapper/WindowsDevicePortalWrapper.Shared/Core/TaskManager.cs)、[编码实现](https://raw.githubusercontent.com/microsoft/WindowsDevicePortalWrapper/master/WindowsDevicePortalWrapper/WindowsDevicePortalWrapper.Shared/Utilities.cs)
