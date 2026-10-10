// Host owns consent, destination selection, and the persistent capture queue.
globalThis.__nowenPluginModule = { actions: {
  "capture-article": async ({ input, nowen }) => {
    const key = `assistant:${input.itemId}`;
    const prior = await nowen.storage.get({ key });
    if (prior) return prior;
    const note = await nowen.capture.importUrl({ url: input.url, notebookId: input.notebookId });
    await nowen.storage.set({ key, value: note });
    return note;
  },
} };
