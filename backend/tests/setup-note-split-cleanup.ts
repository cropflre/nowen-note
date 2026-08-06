import test from "node:test";

import { getYjsStats, yDestroyDoc } from "../src/services/yjs";

// Note Split routes synchronize source/child Markdown into temporary Yjs rooms.
// Production keeps those rooms for the five-minute idle window, but test
// processes must release them after assertions so the idle timers do not keep
// Node alive until the workflow timeout.
test.after(() => {
  for (const room of getYjsStats().details) {
    yDestroyDoc(room.noteId);
  }
});
