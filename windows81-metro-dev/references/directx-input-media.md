# DirectX, Input, Media, And Non-Form Apps

Use this for games, drawing surfaces, camera/media features, sensors, and custom touch interactions.

## Pointer And Gesture Input

Prefer high-level control events for normal UI. Use pointer or manipulation events when the user manipulates content directly:

```xml
<Grid ManipulationMode="TranslateX,TranslateY,Scale"
      ManipulationDelta="OnManipulationDelta"
      PointerPressed="OnPointerPressed"
      PointerMoved="OnPointerMoved"
      PointerReleased="OnPointerReleased" />
```

Rules:

- Set `ManipulationMode`; gestures will not behave correctly if it is left implicit.
- Handle cancellation and pointer capture loss.
- Support mouse and pen paths unless the app is explicitly touch-only.
- Keep hover affordances optional; Metro apps must work without hover.

## Board And Game State

For board games or interactive canvases:

- Separate view input from game state and rules.
- Keep board coordinates independent from pixel coordinates.
- Store state snapshots for undo, suspend/resume, and tests.
- Test legal move/state transitions without UI.
- Use XAML grids or items controls for simple boards; use DirectX only when rendering requirements justify it.

## DirectX/XAML Interop

Match the control already used by the project:

- `SwapChainBackgroundPanel`: common in Windows 8 era full-screen DirectX/XAML samples.
- `SwapChainPanel`: common in Windows 8.1 XAML interop scenarios.
- `SurfaceImageSource` or `VirtualSurfaceImageSource`: use for DirectX-rendered images or very large surfaces inside XAML.

Lifecycle rules:

- Create device resources separately from window-size dependent resources.
- Recreate size-dependent resources on orientation, DPI, or bounds changes.
- Handle device lost.
- Pause or throttle rendering during suspend and resume cleanly.
- Marshal UI interactions to the UI thread and keep the render loop off expensive XAML work.

## Sensors And Touch-First Game Loops

For accelerometer, orientation, or motion-controlled apps:

- Check sensor availability.
- Set a report interval appropriate for the experience.
- Smooth noisy input before applying it to gameplay.
- Stop or reduce sensor updates during suspend or when the page is not visible.

## Media And Camera

Choose the simplest API that fits:

- `CameraCaptureUI` for simple user-driven capture.
- `MediaCapture` for custom camera preview, frame control, or continuous capture.
- `FileOpenPicker` and `FileSavePicker` for user-mediated file access.

Manifest capabilities matter:

- Webcam requires webcam capability.
- Microphone requires microphone capability.
- Pictures/music/video libraries require the corresponding library capability or picker-based access.

Handle denied permissions, missing hardware, camera-in-use errors, and suspended capture sessions.

## Layout And Visual Quality

- Design for full-screen, portrait, landscape, snapped/narrow widths, high DPI, and touch.
- Use `VisualStateManager` or the app's existing layout state helper for width/orientation changes.
- Keep primary content unobscured by AppBars.
- Avoid desktop-style dense chrome; command surfaces should appear at edges or in contextually expected places.
