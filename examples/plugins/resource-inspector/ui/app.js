const client = window.NowenApp;
const status = document.querySelector("#status"), metadata = document.querySelector("#metadata");
async function refresh() {
  try {
    await client.ready;
    const context = await client.call("context.get");
    document.documentElement.dataset.theme = context.theme;
    if (!context.selection) { status.textContent = "Open this inspector from a note, task or file detail. / 请从笔记、任务或附件详情打开检查器。"; return; }
    const resource = await client.call("inspector.getResource");
    document.querySelector("#resource-title").textContent = resource.title;
    metadata.replaceChildren();
    for (const [key, value] of Object.entries(resource)) {
      const label = document.createElement("dt"), content = document.createElement("dd");
      label.textContent = key; content.textContent = String(value ?? "—"); content.dataset.field = key;
      metadata.append(label, content);
    }
    status.textContent = "Ready";
  } catch {
    metadata.replaceChildren(); status.textContent = "Resource unavailable. Close and reopen the inspector. / 资源不可用，请关闭后重新打开。";
  }
}
client.on("theme.changed", event => { document.documentElement.dataset.theme = event.theme; });
document.querySelector("#refresh").addEventListener("click", refresh);
void refresh();
