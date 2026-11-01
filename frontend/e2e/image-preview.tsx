import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import FullscreenImageViewer from "../src/components/FullscreenImageViewer";
import EditorImageTransformBridge, { EditorImageTransformControls } from "../src/components/EditorImageTransformBridge";
import { createResizableImageNodeView } from "../src/components/ResizableImageView";
import "../src/index.css";
import "../src/i18n";

const source = (id: string) => `${location.origin}/api/attachments/123e4567-e89b-42d3-a456-${id}?w=240&exp=2000000000&sig=fixture&scope=v2.fixture`;
const images = [
  { src: source("426614174216"), alt: "Portrait" },
  { src: source("426614174217"), alt: "Landscape" },
];
function Harness() {
  const [open, setOpen] = useState(false);
  const [single, setSingle] = useState(false);
  const [downloadSource, setDownloadSource] = useState("");
  const editor = useEditor({
    extensions: [StarterKit, Image.extend({
      addAttributes() { return { ...this.parent?.(), width: { default: null }, height: { default: null } }; },
      addNodeView() { return createResizableImageNodeView(); },
    }).configure({ inline: true })],
    content: `<p>Imported dimensions<img src="${source("426614174217")}" width="600" height="600"></p>`,
  });
  return <main className="mx-auto max-w-3xl p-4">
    <button onClick={() => { setSingle(false); setOpen(true); }}>Open gallery</button>
    <button onClick={() => { setSingle(true); setOpen(true); }}>Open single</button>
    <output data-testid="download-source">{downloadSource}</output>
    {editor && <EditorImageTransformControls editor={editor} />}
    <EditorContent editor={editor} />
    <EditorImageTransformBridge />
    <FullscreenImageViewer open={open} images={single ? images.slice(0, 1) : images} onClose={() => setOpen(false)} onDownload={(item) => setDownloadSource(item.src)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
