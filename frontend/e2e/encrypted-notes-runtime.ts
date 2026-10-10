import type { DesktopAccountHistoryAPI, DesktopHttpAPI } from "../src/lib/desktopBridge";

export type EncryptedTestWindow = Window & {
  require?: unknown;
  process?: unknown;
  __fixtureWorker?: typeof Worker;
  Worker?: typeof Worker;
  nowenDesktop: {
    isDesktop?: boolean;
    accountHistory: Omit<DesktopAccountHistoryAPI, "save"> & {
      save: (payload: Parameters<DesktopAccountHistoryAPI["save"]>[0] & { refreshToken?: string }) => ReturnType<DesktopAccountHistoryAPI["save"]>;
    };
    http: DesktopHttpAPI;
  };
};

export type EncryptedTestGlobals = typeof globalThis & {
  encryptedFixtureRequests: Array<{ method: string; body?: string }>;
  encryptedAppRequests: unknown[];
  encryptedAppScan: (markers: string[]) => string[];
  encryptedAppWindowEvents: Array<{ at: number; event: string; focused: boolean; visible: boolean }>;
  encryptedAppHeaders: Array<{ url: string; headers: Record<string, string> }>;
};
