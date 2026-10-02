import { installDesktopNativeHttpBridge } from "../src/lib/desktopNativeHttpBridge";

// Match main.tsx's transport initialization only for the file deployment fixture.
if (location.protocol === "file:") installDesktopNativeHttpBridge();
