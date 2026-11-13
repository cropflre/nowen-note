const app = window.NowenApp;
const input = document.getElementById("message"), status = document.getElementById("status");
const theme = ({ theme }) => { document.documentElement.dataset.theme = theme; };
const report = error => { status.textContent = `Request failed: ${error.code || error.message}. Read saved data before retrying a save.`; };
async function read() {
  const value = await app.call("storage.get", { key: "message" });
  input.value = typeof value === "string" ? value : "";
  status.textContent = "Saved data loaded";
}
document.getElementById("save").addEventListener("click", async () => {
  try { await app.call("storage.set", { key: "message", value: input.value }); status.textContent = "Saved"; } catch (error) { report(error); }
});
document.getElementById("read").addEventListener("click", () => read().catch(report));
document.getElementById("notes").addEventListener("click", () => app.call("navigation.open", { target: "all" }).catch(report));
app.on("theme.changed", theme);
app.on("visibility.changed", ({ visible }) => { document.documentElement.dataset.visible = String(visible); });
app.ready.then(async () => { theme(await app.call("context.get")); await read(); }).catch(report);
