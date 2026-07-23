import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, LayoutTemplate, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { MindMap } from "@/types";
import {
  escapeMindMapXml,
  getMindMapNodeStyle,
  getMindMapRootText,
  parseMindMapDocument,
  preserveMindMapNodeStyleInSerializedData,
  transformMindMapExportSvg,
  withMindMapNodeStyle,
  type MindMapDocument,
  type MindMapNodeStyle,
} from "@/lib/mindMapAppearance";
import "./MindMapAppearanceBridge.css";

const API_PATCH_FLAG = Symbol.for("nowen.mindMapAppearance.apiPatch");
const BLOB_PATCH_FLAG = Symbol.for("nowen.mindMapAppearance.blobPatch");
const APPEARANCE_EVENT = "nowen:mindmap-appearance-state";
const MAX_RECENT_MAPS = 12;

type MindMapSnapshot = {
  map: MindMap;
  document: MindMapDocument;
  nodeStyle: MindMapNodeStyle;
  rootText: string;
};

type MindMapAppearanceState = {
  active: MindMapSnapshot | null;
  candidates: MindMapSnapshot[];
};

const runtimeState: MindMapAppearanceState = {
  active: null,
  candidates: [],
};

function dispatchAppearanceState(): void {
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, {
    detail: {
      activeId: runtimeState.active?.map.id || null,
      nodeStyle: runtimeState.active?.nodeStyle || "card",
    },
  }));
}

function setDocumentNodeStyle(nodeStyle: MindMapNodeStyle): void {
  document.documentElement.dataset.nowenMindmapNodeStyle = nodeStyle;
}

function toSnapshot(map: MindMap): MindMapSnapshot | null {
  const document = parseMindMapDocument(map.data);
  if (!document) return null;
  return {
    map,
    document,
    nodeStyle: getMindMapNodeStyle(document),
    rootText: getMindMapRootText(document),
  };
}

function rememberCandidate(map: MindMap): void {
  const snapshot = toSnapshot(map);
  if (!snapshot) return;
  runtimeState.candidates = [
    snapshot,
    ...runtimeState.candidates.filter((candidate) => candidate.map.id !== snapshot.map.id),
  ].slice(0, MAX_RECENT_MAPS);
}

function activateSnapshot(snapshot: MindMapSnapshot): void {
  runtimeState.active = snapshot;
  setDocumentNodeStyle(snapshot.nodeStyle);
  dispatchAppearanceState();
}

function syncActiveMap(map: MindMap): void {
  const snapshot = toSnapshot(map);
  if (!snapshot) return;
  rememberCandidate(map);
  if (runtimeState.active?.map.id === map.id) activateSnapshot(snapshot);
}

function getDisplayedMindMapIdentity(): { title: string; rootText: string } | null {
  const rootNode = document.querySelector<HTMLElement>('[data-mindmap-node-id="root"]');
  if (!rootNode) return null;
  const content = rootNode.closest<HTMLElement>(".flex-1.flex.overflow-hidden");
  const shell = content?.parentElement;
  if (!content || !shell) return null;
  const header = Array.from(shell.children).find((child) =>
    child instanceof HTMLElement && child.classList.contains("border-b"));
  const title = header?.querySelector("h1")?.textContent?.trim() || "";
  const rootText = rootNode.textContent?.replace(/[+−]\d*$/, "").trim() || "";
  return { title, rootText };
}

function resolveDisplayedSnapshot(): MindMapSnapshot | null {
  const identity = getDisplayedMindMapIdentity();
  if (!identity) return null;
  if (
    runtimeState.active
    && runtimeState.active.map.title === identity.title
    && runtimeState.active.rootText === identity.rootText
  ) {
    return runtimeState.active;
  }
  return runtimeState.candidates.find((candidate) =>
    candidate.map.title === identity.title && candidate.rootText === identity.rootText) || null;
}

function findMindMapToolbarHost(): HTMLElement | null {
  const rootNode = document.querySelector<HTMLElement>('[data-mindmap-node-id="root"]');
  const content = rootNode?.closest<HTMLElement>(".flex-1.flex.overflow-hidden");
  const shell = content?.parentElement;
  if (!rootNode || !content || !shell) return null;
  const header = Array.from(shell.children).find((child) =>
    child instanceof HTMLElement && child.classList.contains("border-b"));
  const host = header?.lastElementChild;
  return host instanceof HTMLElement ? host : null;
}

function markMindMapMiniMaps(): void {
  const rootNode = document.querySelector<HTMLElement>('[data-mindmap-node-id="root"]');
  const content = rootNode?.closest<HTMLElement>(".flex-1.flex.overflow-hidden");
  if (!content) return;
  content.querySelectorAll<SVGSVGElement>("svg.cursor-pointer").forEach((svg) => {
    if (svg.querySelector("rect")) svg.dataset.nowenMindmapMinimap = "true";
  });
}

function resolveSvgNodeStyle(svg: string): MindMapNodeStyle {
  const matchingCandidate = runtimeState.candidates.find((candidate) => {
    if (!candidate.rootText) return false;
    return svg.includes(`>${escapeMindMapXml(candidate.rootText)}</text>`);
  });
  return matchingCandidate?.nodeStyle || runtimeState.active?.nodeStyle || "card";
}

function installMindMapBlobPatch(): void {
  if (typeof window === "undefined") return;
  const taggedWindow = window as typeof window & Record<PropertyKey, unknown>;
  if (taggedWindow[BLOB_PATCH_FLAG]) return;
  taggedWindow[BLOB_PATCH_FLAG] = true;

  const NativeBlob = window.Blob;
  class MindMapAwareBlob extends NativeBlob {
    constructor(blobParts: BlobPart[] = [], options: BlobPropertyBag = {}) {
      const isSvg = options.type?.toLowerCase().includes("image/svg+xml");
      const nextParts = isSvg
        ? blobParts.map((part) => {
          if (typeof part !== "string") return part;
          return transformMindMapExportSvg(part, resolveSvgNodeStyle(part));
        })
        : blobParts;
      super(nextParts, options);
    }
  }

  Object.defineProperty(window, "Blob", {
    configurable: true,
    writable: true,
    value: MindMapAwareBlob,
  });
}

function installMindMapApiPatch(): void {
  if (typeof window === "undefined") return;
  const taggedApi = api as typeof api & Record<PropertyKey, unknown>;
  if (taggedApi[API_PATCH_FLAG]) return;
  taggedApi[API_PATCH_FLAG] = true;

  const nativeGetMindMap = api.getMindMap.bind(api);
  const nativeUpdateMindMap = api.updateMindMap.bind(api);

  api.getMindMap = (async (...args: Parameters<typeof nativeGetMindMap>) => {
    const map = await nativeGetMindMap(...args);
    rememberCandidate(map);
    window.requestAnimationFrame(() => {
      const displayed = resolveDisplayedSnapshot();
      if (displayed) activateSnapshot(displayed);
    });
    return map;
  }) as typeof api.getMindMap;

  api.updateMindMap = (async (...args: Parameters<typeof nativeUpdateMindMap>) => {
    const [mapId, payload] = args;
    let nextArgs = args;
    const active = runtimeState.active;
    if (
      active?.map.id === mapId
      && payload
      && typeof payload === "object"
      && typeof (payload as { data?: unknown }).data === "string"
    ) {
      const nextPayload = {
        ...payload,
        data: preserveMindMapNodeStyleInSerializedData(
          (payload as { data: string }).data,
          active.nodeStyle,
        ),
      };
      nextArgs = [mapId, nextPayload] as Parameters<typeof nativeUpdateMindMap>;
    }

    const updated = await nativeUpdateMindMap(...nextArgs);
    syncActiveMap(updated);
    return updated;
  }) as typeof api.updateMindMap;
}

installMindMapApiPatch();
installMindMapBlobPatch();

function useAppearanceCopy() {
  const language = (localStorage.getItem("i18nextLng") || navigator.language || "").toLowerCase();
  return language.startsWith("zh")
    ? {
      label: "节点样式",
      card: "卡片",
      minimal: "简洁",
      saveFailed: "思维导图样式保存失败",
    }
    : {
      label: "Node style",
      card: "Card",
      minimal: "Minimal",
      saveFailed: "Failed to save mind map style",
    };
}

export default function MindMapAppearanceBridge() {
  const copy = useAppearanceCopy();
  const [active, setActive] = useState<MindMapSnapshot | null>(runtimeState.active);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  const refreshDomState = useCallback(() => {
    const displayed = resolveDisplayedSnapshot();
    if (displayed && displayed.map.id !== runtimeState.active?.map.id) activateSnapshot(displayed);
    const nextHost = findMindMapToolbarHost();
    markMindMapMiniMaps();
    setHost((current) => current === nextHost ? current : nextHost);
    setVisible(Boolean(nextHost && displayed));
    setActive(runtimeState.active);
  }, []);

  useEffect(() => {
    const onState = () => refreshDomState();
    window.addEventListener(APPEARANCE_EVENT, onState);
    window.addEventListener("nowen:workspace-changed", onState);

    let frame = 0;
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(refreshDomState);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    refreshDomState();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener(APPEARANCE_EVENT, onState);
      window.removeEventListener("nowen:workspace-changed", onState);
    };
  }, [refreshDomState]);

  const changeStyle = async (nodeStyle: MindMapNodeStyle) => {
    const current = runtimeState.active;
    if (!current || current.nodeStyle === nodeStyle || saving) return;

    const previous = current;
    const optimistic: MindMapSnapshot = {
      ...current,
      document: withMindMapNodeStyle(current.document, nodeStyle),
      nodeStyle,
    };
    activateSnapshot(optimistic);
    setActive(optimistic);
    setSaving(true);
    try {
      const updated = await api.updateMindMap(current.map.id, {
        data: JSON.stringify(optimistic.document),
      });
      const next = toSnapshot(updated);
      if (next) activateSnapshot(next);
    } catch (error) {
      activateSnapshot(previous);
      toast.error((error as Error)?.message || copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  if (!visible || !host || !active) return null;

  return createPortal(
    <div
      data-mindmap-appearance-control="true"
      className="ml-1 hidden items-center gap-0.5 rounded-lg border border-app-border/70 bg-app-surface/80 p-0.5 shadow-sm backdrop-blur sm:flex"
      title={copy.label}
    >
      <button
        type="button"
        aria-pressed={active.nodeStyle === "card"}
        disabled={saving}
        onClick={() => void changeStyle("card")}
        className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition ${
          active.nodeStyle === "card"
            ? "bg-accent-primary text-white shadow-sm"
            : "text-tx-secondary hover:bg-app-hover"
        }`}
      >
        <LayoutTemplate size={12} />
        {copy.card}
      </button>
      <button
        type="button"
        aria-pressed={active.nodeStyle === "minimal"}
        disabled={saving}
        onClick={() => void changeStyle("minimal")}
        className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition ${
          active.nodeStyle === "minimal"
            ? "bg-accent-primary text-white shadow-sm"
            : "text-tx-secondary hover:bg-app-hover"
        }`}
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <AlignLeft size={12} />}
        {copy.minimal}
      </button>
    </div>,
    host,
  );
}
