/**
 * 「文件夹排布」视图 —— 按笔记本层级展示，**只到文件夹层面**。
 *
 * ⚠️ 核心规则（用户明确要求）：**展开文件夹只出子文件夹，绝不列笔记**。
 *    笔记统一去「仅看笔记」看；文件夹视图只负责回答「我的笔记都放在哪些文件夹里」。
 *    想知道某个文件夹里有什么 → 点它，会切到「仅看笔记」并只看该文件夹（含子孙）。
 *
 * 三个刻意的取舍（沿用前一版）：
 *
 * 1. **缩进用 inline paddingLeft 而不是 CSS 变量**。
 *    层级是数据算出来的（buildNotebookFolders 会重算 depth），
 *    写成 CSS 类就要维护 0~N 个类；直接用算出来的数字最不容易错位。
 *
 * 2. **折叠是「卸载」而不是「隐藏」**（CSS 折叠会保留全部 DOM 节点，滚动和内存都白扛）。
 *
 * 3. **文件夹行不用 backdrop-filter**（性能铁律），和列表行一个规格。
 *
 * 4. **默认全部收起**（展开名单存在 localStorage，见 noteViewPrefs.ts）。
 *
 * 交互分工（刻意做得泾渭分明，避免误触）：
 *   · 点左边的箭头 = 展开 / 收起，**不跳转**
 *   · 点整行       = 进入该文件夹（切到「仅看笔记」并只看它和它的子孙）
 */
import { noteHref } from "../lib/router";
import { UNCLASSIFIED_ID, type FolderNode } from "../lib/notebookFolders";

/** 每层缩进多少 px —— 一行文字大约 8 个汉字，16px 刚好能看出层级又不浪费宽度 */
const INDENT = 16;
const BASE_PAD = 14;

/**
 * 笔记本名字里**已经自带 emoji** 的情况（实测占绝大多数：`🗂 10 工作台`、`✈️ 旅行`…）。
 * 这些本的 `icon` 字段通常是通用的 📁，两个一起渲染就会出现「📁 🗂 10 工作台」这种双图标。
 * 规则：名字自带图标时，图标位留空但**保留宽度**，这样整列名字仍然对齐。
 */
const LEADING_PICTO = /^\p{Extended_Pictographic}/u;

export type FolderScope =
  | { kind: "notebook"; id: string; name: string }
  | { kind: "unclassified" };

function Branch({
  node,
  expanded,
  onToggle,
  onEnter,
}: {
  node: FolderNode;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onEnter: (scope: FolderScope) => void;
}) {
  const open = expanded.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <li>
        <div
          className="folder-row"
          style={{ paddingLeft: BASE_PAD + node.depth * INDENT }}
        >
          {/* 箭头：只管展开/收起 */}
          <button
            type="button"
            className="folder-caret-btn"
            aria-expanded={open}
            aria-label={hasChildren ? (open ? "收起" : "展开") : "没有子文件夹"}
            disabled={!hasChildren}
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) onToggle(node.id);
            }}
          >
            <span className="folder-caret" aria-hidden="true">
              ›
            </span>
          </button>

          {/* 整行：进入文件夹（切到「仅看笔记」并只看它） */}
          <button
            type="button"
            className="folder-main"
            onClick={() => onEnter({ kind: "notebook", id: node.id, name: node.name })}
          >
            <span className="folder-icon" aria-hidden="true">
              {LEADING_PICTO.test(node.name.trim()) ? "" : node.icon}
            </span>
            <span className="folder-name">{node.name}</span>
            <span className="folder-count">{node.total}</span>
          </button>
        </div>
      </li>

      {/* 展开只出子文件夹 —— 不出现任何笔记行 */}
      {open && hasChildren ? (
        <>
          {node.children.map((child) => (
            <Branch
              key={child.id}
              node={child}
              expanded={expanded}
              onToggle={onToggle}
              onEnter={onEnter}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

export function NotebookFolders({
  tree,
  unclassifiedCount,
  expanded,
  onToggle,
  onEnter,
}: {
  tree: FolderNode[];
  /** 孤儿笔记的条数（只用来显示计数，这里不列笔记） */
  unclassifiedCount: number;
  expanded: string[];
  onToggle: (id: string) => void;
  onEnter: (scope: FolderScope) => void;
}) {
  const expandedSet = new Set(expanded);

  return (
    <div className="card glass">
      <ul className="list">
        {tree.map((node) => (
          <Branch
            key={node.id}
            node={node}
            expanded={expandedSet}
            onToggle={onToggle}
            onEnter={onEnter}
          />
        ))}

        {/* 孤儿笔记（notebookId 指向不存在的笔记本）—— 扁平视图会显示它们，
            这里也不能吞掉，否则两个视图的条数对不上。但同样【只显示文件夹行】。 */}
        {unclassifiedCount > 0 ? (
          <li>
            <div className="folder-row" style={{ paddingLeft: BASE_PAD }}>
              <span className="folder-caret-btn" aria-hidden="true" />
              <button
                type="button"
                className="folder-main"
                onClick={() => onEnter({ kind: "unclassified" })}
              >
                <span className="folder-icon" aria-hidden="true">
                  ❓
                </span>
                <span className="folder-name">未归类</span>
                <span className="folder-count">{unclassifiedCount}</span>
              </button>
            </div>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { noteHref, UNCLASSIFIED_ID };
