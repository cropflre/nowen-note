// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAttachment } from "@/lib/downloadFile";
import { registerAttachmentAccessUrls } from "@/lib/noteAttachmentAccessBridge";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174242";

describe("downloadAttachment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the current signed URL when triggering a same-origin download", async () => {
    const signed = new URL(`/api/attachments/${ATTACHMENT_ID}`, window.location.origin);
    signed.searchParams.set("exp", "2000000000");
    signed.searchParams.set("sig", "server-value");
    signed.searchParams.set("scope", "v2.scope");
    registerAttachmentAccessUrls({ [ATTACHMENT_ID]: signed.toString() });

    let clickedHref = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.href;
    });

    await downloadAttachment(`/api/attachments/${ATTACHMENT_ID}`, "report.pdf");

    const url = new URL(clickedHref);
    expect(url.searchParams.get("download")).toBe("1");
    expect(url.searchParams.get("sig")).toBe("server-value");
  });
});
