import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { NoteEditorHandle, NoteEditorProps, NoteEditorUpdatePayload } from "@/components/editors/types";
import { api } from "@/lib/api";
import type { YjsSubdocumentUpdateResult } from "@/lib/api";
import {
  createTiptapSubdocumentBundle,
  createTiptapSubdocumentRestSyncController,
  destroyTiptapSubdocumentBundle,
  splitTiptapSubdocumentSections,
  type TiptapSubdocumentBundle,
  type TiptapSubdocumentRestSyncController,
  type TiptapSubdocumentSection,
} from "@/lib/yjsSubdocumentModel";
import BaseTiptapEditor from "./TiptapEditor";

export const TIPTAP_SUBDOCUMENT_WINDOWING_KEY = "nowen:tiptap-subdocuments";

export function isTiptapSubdocumentWindowingEnabled(): boolean {
  try { return localStorage.getItem(TIPTAP_SUBDOCUMENT_WINDOWING_KEY) === "1"; } catch { return false; }
}

interface WindowedTiptapEditorProps extends NoteEditorProps {
  onFallback?: (reason: string, snapshot?: { content: string; contentText: string }) => void;
  onSubdocumentCommit?: (result: YjsSubdocumentUpdateResult) => void;
}

function plainTextFromTiptap(content: string): string {
  try {
    const doc = JSON.parse(content);
    const parts: string[] = [];
    const walk = (node: any) => {
      if (typeof node?.text === "string") parts.push(node.text);
      if (Array.isArray(node?.content)) node.content.forEach(walk);
      if (["paragraph", "heading", "listItem", "taskItem", "blockquote", "codeBlock"].includes(node?.type)) parts.push("\n");
    };
    walk(doc);
    return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}

function mergeSectionContents(sections: TiptapSubdocumentSection[], values: Map<string, string>): string | null {
  const nodes: any[] = [];
  try {
    for (const section of sections) {
      const doc = JSON.parse(values.get(section.id) || section.content);
      if (doc?.type !== "doc" || !Array.isArray(doc.content)) return null;
      nodes.push(...doc.content);
    }
    return JSON.stringify({ type: "doc", content: nodes });
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function manifestMatches(
  bundle: TiptapSubdocumentBundle,
  manifest: Awaited<ReturnType<typeof api.getYjsSubdocumentManifest>>,
): boolean {
  if (manifest.rootGuid !== bundle.rootDoc.guid || manifest.sections.length !== bundle.sections.length) return false;
  return bundle.sections.every((local, index) => {
    const remote = manifest.sections[index];
    return remote?.id === local.id
      && remote.guid === local.guid
      && remote.startBlock === local.startBlock
      && remote.endBlock === local.endBlock;
  });
}

function SectionFrame({
  section,
  index,
  mounted,
  estimatedHeight,
  onVisibility,
  onComposition,
  children,
}: {
  section: TiptapSubdocumentSection;
  index: number;
  mounted: boolean;
  estimatedHeight: number;
  onVisibility: (sectionId: string, visible: boolean, height?: number) => void;
  onComposition: (sectionId: string, composing: boolean) => void;
  children: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hostRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) onVisibility(section.id, entry.isIntersecting, Math.ceil(entry.boundingClientRect?.height || 0));
    }, { rootMargin: "1200px 0px" });
    observer.observe(hostRef.current);
    return () => observer.disconnect();
  }, [onVisibility, section.id]);
  useEffect(() => {
    if (!mounted || !hostRef.current) return;
    const height = Math.ceil(hostRef.current.getBoundingClientRect().height);
    if (height > 0) onVisibility(section.id, true, height);
  }, [mounted, onVisibility, section.id]);
  return (
    <section
      ref={hostRef}
      data-windowed-tiptap-section={section.id}
      data-section-index={index}
      onCompositionStartCapture={() => onComposition(section.id, true)}
      onCompositionEndCapture={() => onComposition(section.id, false)}
      style={{ containIntrinsicSize: `auto ${estimatedHeight}px` }}
    >
      {mounted ? children : <div aria-hidden="true" style={{ minHeight: estimatedHeight }} />}
    </section>
  );
}

/**
 * 实验性章节窗口：首章常驻以保留统一工具栏，其余章节只在视口缓冲区内挂载。
 * 每章卸载前同步抓取编辑器快照；任何无法无损合并的状态立即回退单体编辑器。
 */
const WindowedTiptapEditor = forwardRef<NoteEditorHandle, WindowedTiptapEditorProps>(
  function WindowedTiptapEditor(props, ref) {
    const sourceRef = useRef<{
      noteId: string;
      content: string;
      sections: TiptapSubdocumentSection[] | null;
    } | null>(null);
    if (sourceRef.current?.noteId !== props.note.id) {
      sourceRef.current = {
        noteId: props.note.id,
        content: props.note.content,
        sections: splitTiptapSubdocumentSections(props.note.id, props.note.content, 250),
      };
    }
    const source = sourceRef.current;
    const sections = source.sections;
    const valuesRef = useRef(new Map<string, string>());
    const editorRefs = useRef(new Map<string, NoteEditorHandle>());
    const composingRef = useRef(new Set<string>());
    const bundleRef = useRef<TiptapSubdocumentBundle | null>(null);
    const controllerRef = useRef<TiptapSubdocumentRestSyncController | null>(null);
    const windowedHostRef = useRef<HTMLDivElement | null>(null);
    const dragSourceSectionRef = useRef<string | null>(null);
    const fallbackRef = useRef(props.onFallback);
    fallbackRef.current = props.onFallback;
    const commitRef = useRef(props.onSubdocumentCommit);
    commitRef.current = props.onSubdocumentCommit;
    const [manifestReady, setManifestReady] = useState(false);
    const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());
    const [heights, setHeights] = useState<Record<string, number>>({});

    const snapshotSection = useCallback((sectionId: string) => {
      const snapshot = editorRefs.current.get(sectionId)?.getSnapshot?.();
      if (snapshot?.content) valuesRef.current.set(sectionId, snapshot.content);
    }, []);

    const requestFallback = useCallback((
      reason: string,
      committedSnapshot?: { content: string; contentText: string },
    ) => {
      if (!sections) {
        fallbackRef.current?.(reason, committedSnapshot);
        return;
      }
      let snapshot = committedSnapshot;
      if (editorRefs.current.size > 0) {
        editorRefs.current.forEach((_editor, sectionId) => snapshotSection(sectionId));
        const content = mergeSectionContents(sections, valuesRef.current);
        if (content) snapshot = { content, contentText: plainTextFromTiptap(content) };
      } else if (!snapshot) {
        const content = mergeSectionContents(sections, valuesRef.current);
        if (content) snapshot = { content, contentText: plainTextFromTiptap(content) };
      }
      fallbackRef.current?.(reason, snapshot);
    }, [sections, snapshotSection]);

    const loadSection = useCallback(async (sectionId: string) => {
      const controller = controllerRef.current;
      if (!controller) return;
      try {
        const content = await controller.loadSection(sectionId);
        if (!content || controllerRef.current !== controller) return;
        valuesRef.current.set(sectionId, content);
        setMountedIds((current) => current.has(sectionId) ? current : new Set(current).add(sectionId));
      } catch {
        if (controllerRef.current === controller) requestFallback("subdocument-snapshot-load-failed");
      }
    }, [requestFallback]);

    useEffect(() => {
      valuesRef.current = new Map((sections || []).map((section) => [section.id, section.content]));
      editorRefs.current.clear();
      composingRef.current.clear();
      setMountedIds(new Set());
      setManifestReady(false);
      setHeights({});
      if (!sections || sections.length <= 1) return;
      if (
        typeof api.getYjsSubdocumentManifest !== "function"
        || typeof api.getYjsSubdocumentState !== "function"
        || typeof api.applyYjsSubdocumentUpdate !== "function"
      ) {
        requestFallback("subdocument-api-unavailable");
        return;
      }

      const bundle = createTiptapSubdocumentBundle(props.note.id, source.content, 250, { preload: false });
      if (!bundle) {
        requestFallback("subdocument-bundle-invalid");
        return;
      }
      bundleRef.current = bundle;
      let active = true;
      void api.getYjsSubdocumentManifest(props.note.id).then((manifest) => {
        if (!active) return;
        if (!manifestMatches(bundle, manifest)) {
          requestFallback("subdocument-manifest-mismatch");
          return;
        }
        const controller = createTiptapSubdocumentRestSyncController(bundle, {
          load: async (sectionId) => {
            const state = await api.getYjsSubdocumentState(props.note.id, sectionId);
            return { guid: state.guid, state: decodeBase64(state.stateBase64) };
          },
          send: async (sectionId, update, generation) => {
            const result = await api.applyYjsSubdocumentUpdate(
              props.note.id,
              sectionId,
              encodeBase64(update),
              generation,
            );
            if (active && bundleRef.current === bundle) {
              commitRef.current?.(result);
              if (
                result.generation !== manifest.generation
                || result.structureVersion !== manifest.structureVersion
              ) {
                // 服务端重分段后旧 controller 不能再发送旧代际增量；保留请求期间
                // 新产生的 pending，并用当前所有编辑器的最新值回退单体编辑器。
                controllerRef.current?.destroy(true);
                controllerRef.current = null;
                requestFallback("subdocument-structure-changed", {
                  content: result.content,
                  contentText: result.contentText,
                });
                throw new Error("SUBDOCUMENT_CONTROLLER_INVALIDATED");
              }
            }
          },
        }, {
          generation: manifest.generation,
          manifest,
          onGenerationConflict: () => requestFallback("subdocument-generation-conflict"),
        });
        controllerRef.current = controller;
        // 先尝试提交跨卸载恢复的 pending，再加载首章，避免旧 snapshot 覆盖已提交的离线编辑。
        void controller.flushPending().then(() => {
          if (!active || controllerRef.current !== controller) return;
          setManifestReady(true);
          void loadSection(sections[0].id);
        });
      }).catch((error) => {
        if (!active) return;
        requestFallback((error as { status?: number })?.status === 409
          ? "subdocument-server-unavailable"
          : "subdocument-manifest-load-failed");
      });
      return () => {
        active = false;
        controllerRef.current?.destroy();
        controllerRef.current = null;
        destroyTiptapSubdocumentBundle(bundle);
        if (bundleRef.current === bundle) bundleRef.current = null;
      };
    }, [loadSection, props.note.id, requestFallback, sections, source.content]);

    useEffect(() => {
      const flush = () => { void controllerRef.current?.flushPending(); };
      window.addEventListener("online", flush);
      return () => window.removeEventListener("online", flush);
    }, []);

    const handleVisibility = useCallback((sectionId: string, visible: boolean, height?: number) => {
      if (height && height > 0) setHeights((current) => current[sectionId] === height ? current : { ...current, [sectionId]: height });
      if (visible) {
        void loadSection(sectionId);
        return;
      }
      setMountedIds((current) => {
        const firstId = sections?.[0]?.id;
        if (visible) return current.has(sectionId) ? current : new Set(current).add(sectionId);
        if (sectionId === firstId || composingRef.current.has(sectionId) || !current.has(sectionId)) return current;
        snapshotSection(sectionId);
        const next = new Set(current);
        next.delete(sectionId);
        return next;
      });
    }, [loadSection, sections, snapshotSection]);

    const handleComposition = useCallback((sectionId: string, composing: boolean) => {
      if (composing) composingRef.current.add(sectionId);
      else composingRef.current.delete(sectionId);
    }, []);

    useEffect(() => {
      if (!manifestReady) return;
      const sectionIdForNode = (node: Node | null): string | null => {
        const element = node instanceof Element ? node : node?.parentElement;
        return element?.closest<HTMLElement>("[data-windowed-tiptap-section]")?.dataset.windowedTiptapSection || null;
      };
      const handleSelectionChange = () => {
        const selection = document.getSelection();
        const anchorSection = sectionIdForNode(selection?.anchorNode || null);
        const focusSection = sectionIdForNode(selection?.focusNode || null);
        if (anchorSection && focusSection && anchorSection !== focusSection) {
          requestFallback("subdocument-cross-section-selection");
        }
      };
      document.addEventListener("selectionchange", handleSelectionChange);
      return () => document.removeEventListener("selectionchange", handleSelectionChange);
    }, [manifestReady, requestFallback]);

    const sectionIdForEvent = useCallback((target: EventTarget | null) => (
      target instanceof Element
        ? target.closest<HTMLElement>("[data-windowed-tiptap-section]")?.dataset.windowedTiptapSection || null
        : null
    ), []);

    const handleDragStart = useCallback((event: React.DragEvent) => {
      dragSourceSectionRef.current = sectionIdForEvent(event.target);
    }, [sectionIdForEvent]);

    const handleDrop = useCallback((event: React.DragEvent) => {
      const sourceSection = dragSourceSectionRef.current;
      const targetSection = sectionIdForEvent(event.target);
      dragSourceSectionRef.current = null;
      if (sourceSection && targetSection && sourceSection !== targetSection) {
        event.preventDefault();
        requestFallback("subdocument-cross-section-drop");
      }
    }, [requestFallback, sectionIdForEvent]);

    const emitMergedUpdate = useCallback((sectionId: string, payload: NoteEditorUpdatePayload) => {
      if (!sections || typeof payload.content !== "string") {
        if (payload.title !== props.note.title) {
          props.onUpdate({ title: payload.title, _noteId: props.note.id });
        }
        return;
      }
      valuesRef.current.set(sectionId, payload.content);
      if (!controllerRef.current?.updateSectionContent(sectionId, payload.content)) {
        requestFallback("subdocument-section-update-failed");
        return;
      }
      const content = mergeSectionContents(sections, valuesRef.current);
      if (!content) {
        requestFallback("subdocument-materialization-failed");
        return;
      }
      // 整篇快照仅保留在本地 getSnapshot；远端正文权威写入必须走章节 update API。
      if (sectionId === sections[0]?.id && payload.title !== props.note.title) {
        props.onUpdate({ title: payload.title, _noteId: props.note.id });
      }
    }, [props.note.id, props.note.title, props.onUpdate, requestFallback, sections]);

    useEffect(() => {
      if (!props.searchQuery || !sections) return;
      const query = props.searchQuery.toLocaleLowerCase();
      const target = sections.find((section) => (
        valuesRef.current.get(section.id) || section.content
      ).toLocaleLowerCase().includes(query));
      if (!target) return;
      void loadSection(target.id).then(() => {
        requestAnimationFrame(() => {
          const element = Array.from(document.querySelectorAll<HTMLElement>("[data-windowed-tiptap-section]"))
            .find((candidate) => candidate.dataset.windowedTiptapSection === target.id);
          element?.scrollIntoView({ block: "center" });
        });
      });
    }, [loadSection, props.searchQuery, sections]);

    useImperativeHandle(ref, () => ({
      flushSave: () => editorRefs.current.forEach((editor) => editor.flushSave()),
      discardPending: () => editorRefs.current.forEach((editor) => editor.discardPending?.()),
      getSnapshot: () => {
        if (!sections) return null;
        editorRefs.current.forEach((_editor, sectionId) => snapshotSection(sectionId));
        const content = mergeSectionContents(sections, valuesRef.current);
        return content ? { content, contentText: plainTextFromTiptap(content) } : null;
      },
      acknowledgeSave: (ack) => editorRefs.current.forEach((editor) => editor.acknowledgeSave?.(ack)),
      isReady: () => Boolean(sections && editorRefs.current.get(sections[0]?.id)?.isReady?.()),
      appendMarkdown: () => false,
    }), [sections, snapshotSection]);

    if (!sections || sections.length <= 1) return <BaseTiptapEditor {...props} ref={ref} />;
    if (!manifestReady) return <div data-windowed-tiptap-loading="true" className="h-full" />;
    return (
      <div
        ref={windowedHostRef}
        data-windowed-tiptap-editor="true"
        className="h-full overflow-y-auto"
        onDragStartCapture={handleDragStart}
        onDropCapture={handleDrop}
      >
        {sections.map((section, index) => {
          const mounted = mountedIds.has(section.id);
          const sectionNote = { ...props.note, content: valuesRef.current.get(section.id) || section.content };
          return (
            <SectionFrame
              key={section.id}
              section={section}
              index={index}
              mounted={mounted}
              estimatedHeight={heights[section.id] || 640}
              onVisibility={handleVisibility}
              onComposition={handleComposition}
            >
              {mounted && (
                <BaseTiptapEditor
                  {...props}
                  note={sectionNote}
                  ref={(editor) => {
                    if (editor) editorRefs.current.set(section.id, editor);
                    else editorRefs.current.delete(section.id);
                  }}
                  presentationMode={index > 0}
                  windowedSection={index > 0}
                  onHeadingsChange={index === 0 ? props.onHeadingsChange : undefined}
                  onUpdate={(payload) => emitMergedUpdate(section.id, payload)}
                />
              )}
            </SectionFrame>
          );
        })}
      </div>
    );
  },
);

WindowedTiptapEditor.displayName = "WindowedTiptapEditor";
export default WindowedTiptapEditor;
