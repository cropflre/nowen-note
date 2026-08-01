from pathlib import Path

path = Path("frontend/src/components/knowledgeTreeImport.ts")
text = path.read_text(encoding="utf-8")
old = '''  if (ownedResult.status === "fulfilled") nodes.push(...ownedResult.value.nodes);
  if (sharedResult.status === "fulfilled") nodes.push(...sharedResult.value.nodes);
  if (nodes.length > 0) {
    return Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  }
  const reason = ownedResult.status === "rejected"
    ? ownedResult.reason
    : sharedResult.status === "rejected"
      ? sharedResult.reason
      : new Error("无法读取内容树");
  throw reason;
'''
new = '''  if (ownedResult.status === "fulfilled") nodes.push(...ownedResult.value.nodes);
  if (sharedResult.status === "fulfilled") nodes.push(...sharedResult.value.nodes);
  if (ownedResult.status === "fulfilled" || sharedResult.status === "fulfilled") {
    return Array.from(new Map(nodes.map((node) => [node.id, node])).values());
  }
  throw ownedResult.reason || sharedResult.reason || new Error("无法读取内容树");
'''
if text.count(old) != 1:
    raise RuntimeError(f"expected one empty-tree block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("empty-tree handling fixed")
