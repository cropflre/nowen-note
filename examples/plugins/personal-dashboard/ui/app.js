(() => {
  const api = window.NowenApp, $ = id => document.getElementById(id);
  let offset = 0, version = 1, busy = false;
  const notes = new Map(), tasks = new Map();
  const status = text => { $("status").textContent = text; };
  function theme(data) { document.documentElement.dataset.theme = data.theme; }
  async function run(work) { if (busy) return; busy = true; document.querySelectorAll("button").forEach(button => { button.disabled = true; }); try { await work(); } catch (error) { status("Operation failed: " + (error.code || error.message) + " — Refresh before retrying / 请刷新后核对"); } finally { busy = false; document.querySelectorAll("button").forEach(button => { button.disabled = false; }); } }
  async function load() {
    const group = $("filter").value.trim();
    const data = await api.call("data.query", { collection: "items", orderBy: "updatedAt", descending: true, offset, limit: 10, ...(group ? { where: { group } } : {}) });
    version = data.schemaVersion; $("items").replaceChildren();
    $("summary").textContent = "Total: " + data.total + " · Done on this page: " + data.items.filter(item => item.value.status === "done").length;
    $("page").textContent = (offset + 1) + "–" + Math.min(offset + 10, data.total);
    for (const item of data.items) {
      const row = document.createElement("li"), label = document.createElement("span"), detail = document.createElement("small");
      label.textContent = (item.value.status === "done" ? "✓ " : "○ ") + item.value.title;
      detail.textContent = item.value.group + (item.value.taskId ? " · Task: " + (tasks.get(item.value.taskId) || item.value.taskId) : ""); label.append(detail); row.append(label);
      const toggle = document.createElement("button"); toggle.textContent = item.value.status === "done" ? "Reopen" : "Complete";
      toggle.onclick = () => run(async () => { await api.call("data.put", { collection: "items", id: item.id, schemaVersion: version, expectedRevision: item.revision, value: { ...item.value, status: item.value.status === "done" ? "open" : "done" } }); await load(); status("Saved"); }); row.append(toggle);
      if (item.value.noteId) { const open = document.createElement("button"); open.textContent = "Note: " + (notes.get(item.value.noteId) || item.value.noteId); open.onclick = () => run(() => api.call("navigation.open", { target: "all", noteId: item.value.noteId })); row.append(open); }
      const remove = document.createElement("button"); remove.textContent = "Delete"; let armed = false; remove.onclick = () => { if (!armed) { armed = true; remove.textContent = "Confirm delete"; return; } void run(async () => { await api.call("data.delete", { collection: "items", id: item.id, schemaVersion: version, expectedRevision: item.revision }); offset = 0; await load(); status("Deleted"); }); }; row.append(remove); $("items").append(row);
    }
    return data;
  }
  $("add-item").onclick = event => { event.preventDefault(); void run(async () => { const title = $("title").value.trim(); if (!title) return; await api.call("data.put", { collection: "items", id: "item-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10), schemaVersion: version, expectedRevision: 0, value: { title, group: $("group").value.trim() || "Personal", status: "open", noteId: $("note").value, taskId: $("task").value } }); $("title").value = ""; offset = 0; await load(); status("Saved"); }); };
  $("reload").onclick = () => run(async () => { offset = 0; await load(); status("Loaded"); });
  $("previous").onclick = () => run(async () => { offset = Math.max(0, offset - 10); await load(); });
  $("next").onclick = () => run(async () => { if (offset < 90) offset += 10; await load(); });
  $("notes").onclick = () => run(() => api.call("navigation.open", { target: "all" })); $("tasks").onclick = () => run(() => api.call("navigation.open", { target: "tasks" }));
  api.on("theme.changed", theme); api.on("destroy", () => { document.querySelectorAll("button").forEach(button => { button.disabled = true; }); });
  void run(async () => { await api.ready; theme(await api.call("context.get")); for (const [method, element, target] of [["notes.list", "note", notes], ["tasks.list", "task", tasks]]) { const items = await api.call(method); for (const item of items) { target.set(item.id, item.title); const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; $(element).append(option); } } await load(); status("Ready"); });
})();
