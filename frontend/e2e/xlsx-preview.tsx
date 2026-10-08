import React from "react";
import { createRoot } from "react-dom/client";
import "../src/index.css";
import "../src/i18n";
import AttachmentPreview from "../src/components/attachmentPreview/AttachmentPreview";

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-4xl p-3">
    <AttachmentPreview url="/fixture.xlsx" filename="预算.xlsx" mimeType="application/octet-stream" size={1024} />
  </main>,
);
