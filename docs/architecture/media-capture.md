# Media Capture Capability

## Why this exists

`<input type="file" capture="environment">` is only a hint. Android/iOS browsers often map it to the system camera, but Windows Chromium / Electron is allowed to ignore it and open a normal file chooser instead.

Nowen therefore separates two concepts:

```text
Native file/capture picker
vs
Managed photo capture
```

The managed path is used where the browser camera API is the reliable capability and the native `capture` hint is not.

## Product boundary

`MediaExperienceBridge` remains the owner of media selection, preflight, upload progress and editor insertion.

`CameraCaptureBridge` owns only camera capture:

```text
user clicks image input[capture]
        ↓
CameraCaptureBridge intercepts on managed desktop environments
        ↓
mediaCapture.openCameraStream()
        ↓
preview / switch camera / capture / retake
        ↓
capturePhotoToFile()
        ↓
File injected back into the original input
        ↓
existing input change handler
        ↓
receiveFiles → prepareMediaFiles → existing upload/insert pipeline
```

This is deliberate: camera support must not create a second attachment-upload implementation.

## Platform strategy

### Electron / Windows tablet / desktop web

Image capture uses `navigator.mediaDevices.getUserMedia()` when the existing picker creates an image `input[capture]`.

The request is always:

```ts
{
  video: { facingMode: { ideal: "environment" } },
  audio: false,
}
```

After permission is granted, `enumerateDevices()` supplies available `videoinput` devices for camera switching.

### Capacitor native and mobile browsers

Existing native/browser `input[capture]` behavior is preserved. The managed bridge intentionally does not intercept these runtimes, so fixing Windows does not replace mature Android/iOS capture behavior.

### Video capture

Issue #778 concerns photo capture. `video/*` capture is intentionally not intercepted; the existing system video-capture path remains unchanged until Nowen has a dedicated recording capability.

## Capture lifecycle

The camera stream is never treated as persistent data.

Rules:

- opening capture requests video only;
- switching cameras stops the previous stream first;
- taking a photo stops the live stream after the frame is encoded;
- closing, Escape, page hide and component unmount stop all tracks;
- the raw camera frame is not stored in localStorage or IndexedDB;
- a captured photo is uploaded only after the user chooses **Use photo**;
- object URLs used for preview are revoked during cleanup.

## Error model

`mediaCapture.describeCameraError()` normalizes browser errors into product-level states:

- `NotAllowedError` / `SecurityError` → permission denied;
- `NotFoundError` → no camera;
- `NotReadableError` → camera busy/unavailable;
- `OverconstrainedError` → device constraints unsupported;
- `NotSupportedError` → camera API/security-context unavailable;
- unknown errors → generic retry state.

The UI always offers a retry or **Choose image file** fallback instead of silently opening a file picker after the user explicitly selected **Take photo**.

## Electron security boundary

Electron still keeps the original restrictive permission policy. `camera-permission.js` composes with it and adds only a narrow camera exception.

A media permission is accepted only when:

1. `permission === "media"`;
2. the requesting `webContents.id` is the registered Nowen main window;
3. the main renderer URL is trusted (`file://` packaged UI or localhost development UI);
4. the requesting origin matches the main renderer, so an external iframe cannot borrow the permission;
5. when Electron exposes `details.mediaTypes`, every requested type is `video` and audio is absent.

Notifications/fullscreen continue through the existing policy. Setup windows, UGREEN remote windows and other renderers do not inherit camera access.

## Internal API

`frontend/src/lib/mediaCapture.ts` is an internal Media Engine capability, not a public plugin API.

Current reusable operations:

- `shouldUseManagedPhotoCapture()`
- `canOpenManagedCamera()`
- `openCameraStream()`
- `listVideoInputs()`
- `capturePhotoToFile()`
- `stopCameraStream()`
- `describeCameraError()`

Keep this private until there are multiple stable consumers. A future native Camera adapter or video recorder can implement the same capability boundary without exposing browser-specific details to editor components.

## Regression assets

- `frontend/src/lib/__tests__/mediaCapture.test.ts`
  - Windows/Electron image takeover;
  - video capture is not intercepted;
  - Capacitor native capture is preserved;
  - `audio: false` contract;
  - stream cleanup;
  - browser error normalization.

- `scripts/tests/electron-camera-permission.test.cjs`
  - trusted main window only;
  - video-only media permission;
  - microphone denial;
  - external iframe denial;
  - composition with notifications/fullscreen permissions.

## Future extension

Natural next steps, only when real requirements appear:

- native Capacitor Camera adapter;
- dedicated video recording capability;
- photo rotation/crop/compression before preflight;
- explicit camera preference persistence;
- barcode/document scanning modes.

Do not turn this into a public Plugin API until multiple internal consumers stabilize the interface.
