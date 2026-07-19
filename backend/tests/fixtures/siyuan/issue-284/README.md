# Issue #284 SiYuan regression fixture

`20260719010101-demo284.sy` is a small, sanitized SiYuan Spec 2 document used by the end-to-end importer regression test. It follows the official `.sy` AST shape and covers the nodes reported in #284:

- `NodeCallout` with type, title, icon and folded state;
- `NodeKramdownBlockIAL` source-only metadata;
- `NodeIFrame` with a password-bearing URL;
- `NodeAudio` and `NodeWidget` safe degradation paths;
- table metadata and formatted table-cell text.

The original binary attachment linked from the GitHub issue is not stored in this repository. The connector used during implementation could not download the `github.com/user-attachments/files/...` URL, so this deterministic fixture is intentionally committed for CI. Release smoke testing should still import the reporter's original archive when it is available locally.
