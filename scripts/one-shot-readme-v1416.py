from pathlib import Path

zh = Path('README.md')
en = Path('README.en.md')
zh_text = zh.read_text(encoding='utf-8')
en_text = en.read_text(encoding='utf-8')

zh_text = zh_text.replace(
    '查看：[v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) · [完整更新日志](./CHANGELOG.md)\n## 为什么选择 Nowen Note',
    '查看：[v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) · [完整更新日志](./CHANGELOG.md)\n\n## 为什么选择 Nowen Note',
)
zh_text = zh_text.replace(
    '完整记录请查看 [CHANGELOG.md](./CHANGELOG.md) 和 [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16)。\n## 截图',
    '完整记录请查看 [CHANGELOG.md](./CHANGELOG.md) 和 [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16)。\n\n## 截图',
)
zh_text = zh_text.replace(
    '> v1.4.16 重点改善移动端图片与媒体操作、大型完整备份恢复、笔记切换稳定性和导出兼容性。升级后建议重点检查移动端图片复制 / 剪切 / 粘贴、视频播放、完整备份恢复、快速切换笔记以及 Markdown + 附件 ZIP / Mermaid 图片导出。镜像回滚不等于数据库回滚，生产环境必须保留独立备份。',
    '> v1.4.16 重点改善笔记切换稳定性、视频首次打开与 Android / 局域网附件授权、Markdown / 代码块编辑细节，以及桌面客户端签名与发布完整性。升级后建议重点检查快速切换笔记、首次视频播放、Android 连接 NAS / 局域网视频、代码块全选和分享链接复制。镜像回滚不等于数据库回滚，生产环境必须保留独立备份。',
)

en_text = en_text.replace(
    'See the [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) and the [full changelog](./CHANGELOG.md).\n## Connect AI clients to Nowen Note',
    'See the [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) and the [full changelog](./CHANGELOG.md).\n\n## Connect AI clients to Nowen Note',
)
en_text = en_text.replace(
    'See [CHANGELOG.md](./CHANGELOG.md) and the [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) for complete details.\n## Screenshots',
    'See [CHANGELOG.md](./CHANGELOG.md) and the [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) for complete details.\n\n## Screenshots',
)
en_text = en_text.replace(
    '> v1.4.16 focuses on mobile image/media workflows, large full-backup recovery, note-switch stability, and export compatibility. After upgrading, verify mobile image copy/cut/paste, video playback, full-backup restore, rapid note switching, and Markdown + attachment ZIP / Mermaid image exports. Rolling back an image does not roll back the database.',
    '> v1.4.16 focuses on note-switch stability, first-open video authorization, Android/LAN attachment access, Markdown/code-block editing details, and desktop signing/release integrity. After upgrading, verify rapid note switching, first video playback, Android video access to NAS/LAN services, code-block select-all behavior, and share-link copying. Rolling back an image does not roll back the database.',
)

if 'v1.4.14' in zh_text or 'v1.4.14' in en_text:
    raise SystemExit('README still contains v1.4.14 current-version references')

zh.write_text(zh_text, encoding='utf-8')
en.write_text(en_text, encoding='utf-8')
