#!/usr/bin/env node
/**
 * 飞牛 fpk 一键打包脚本
 *
 * 用法：
 *   PowerShell:
 *     $env:DOCKERHUB_REPO="yourname/nowen-note"; node scripts/fpk/build-fpk.mjs
 *   Bash:
 *     DOCKERHUB_REPO=yourname/nowen-note node scripts/fpk/build-fpk.mjs
 *
 * 可选环境变量：
 *   DOCKERHUB_REPO   必填，例如 myname/nowen-note
 *   FPK_VERSION      可选，写入 manifest 的版本号（飞牛要求 X.Y.Z 形式），默认 package.json.version
 *   FPK_IMAGE_TAG    可选，compose.yaml 里镜像的 tag（可带 v 前缀），默认与 FPK_VERSION 一致
 *                    -- release.sh 走原子发布时会传 v${VERSION}，与 docker push 的 tag 对齐
 *   FNPACK_BIN       可选，fnpack 可执行文件路径，默认自动探测
 *   FPK_OUT_DIR      可选，输出目录，默认 dist-fpk
 */
import { execSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    chmodSync,
    readdirSync,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TEMPLATE_DIR = join(__dirname, 'template');

const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
const VERSION = process.env.FPK_VERSION || pkg.version;
// 镜像 tag 默认 = VERSION；release.sh 会覆盖成 v${VERSION} 与 docker push 的 tag 对齐
// （DockerHub 上实际镜像 tag 是 v1.0.30，飞牛 NAS 拉裸 1.0.30 会 manifest unknown / EOF）
const IMAGE_TAG = process.env.FPK_IMAGE_TAG || VERSION;
const DOCKERHUB_REPO = process.env.DOCKERHUB_REPO;
const OUT_DIR = resolve(PROJECT_ROOT, process.env.FPK_OUT_DIR || 'dist-fpk');

if (!DOCKERHUB_REPO) {
    console.error('[fpk] 错误：必须设置环境变量 DOCKERHUB_REPO，例如 yourname/nowen-note');
    process.exit(1);
}

console.log(`[fpk] 项目版本: ${VERSION}（写入 manifest）`);
console.log(`[fpk] 镜像地址: ${DOCKERHUB_REPO}:${IMAGE_TAG}（写入 compose.yaml）`);

// 1. 准备工作目录
mkdirSync(OUT_DIR, { recursive: true });
const WORK_DIR = join(OUT_DIR, `nowen-note-${VERSION}`);
if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(WORK_DIR, { recursive: true });

// 2. 复制模板
console.log('[fpk] 复制模板到工作目录');
cpSync(TEMPLATE_DIR, WORK_DIR, { recursive: true });

// 3. 注入版本号 / 镜像地址
//    - manifest 用 VERSION（飞牛 NAS 应用版本，必须 X.Y.Z 纯版本号）
//    - docker-compose.yaml 用 IMAGE_TAG（DockerHub 上的实际 tag，可能带 v 前缀）
function injectInto(filePath, replacements) {
    let content = readFileSync(filePath, 'utf8');
    for (const [key, val] of Object.entries(replacements)) {
        content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
    writeFileSync(filePath, content);
}
const RELEASE_NOTES = VERSION === '1.5.5'
    ? '优化多端双向同步与知识树冲突处理、桌面恢复和交互动效；修复应用内更新日志缺少 v1.5.4 / v1.5.5 且展示大量英文开发提交的问题。'
    : '完善笔记体验与运行稳定性，详细更新内容请查看对应版本的官方发布说明。';
injectInto(join(WORK_DIR, 'manifest'), {
    VERSION,
    DOCKERHUB_REPO,
    UPDATE_NOTES: RELEASE_NOTES,
});
injectInto(join(WORK_DIR, 'app', 'docker', 'docker-compose.yaml'), {
    IMAGE_TAG,
    DOCKERHUB_REPO,
});

// 4. 生成图标（根目录 ICON.PNG/ICON_256.PNG，UI 目录 icon_64.png/icon_256.png）
console.log('[fpk] 生成图标');
const SRC_ICON = join(PROJECT_ROOT, 'electron', 'icon.png');
if (!existsSync(SRC_ICON)) {
    console.error(`[fpk] 错误：找不到源图标 ${SRC_ICON}`);
    process.exit(1);
}
const uiImagesDir = join(WORK_DIR, 'app', 'ui', 'images');
mkdirSync(uiImagesDir, { recursive: true });

await sharp(SRC_ICON).resize(64, 64).png().toFile(join(WORK_DIR, 'ICON.PNG'));
await sharp(SRC_ICON).resize(256, 256).png().toFile(join(WORK_DIR, 'ICON_256.PNG'));
await sharp(SRC_ICON).resize(64, 64).png().toFile(join(uiImagesDir, 'icon_64.png'));
await sharp(SRC_ICON).resize(256, 256).png().toFile(join(uiImagesDir, 'icon_256.png'));

// 5. 给 cmd/* 加上可执行权限位（在飞牛 Linux 上需要）
//    Windows 文件系统下 chmod 是 noop，但 fnpack 会按内容/属性打包，影响不大；
//    保险起见仍调用一次。
try {
    const cmdDir = join(WORK_DIR, 'cmd');
    for (const f of readdirSync(cmdDir)) {
        chmodSync(join(cmdDir, f), 0o755);
    }
} catch {
    /* ignore */
}

// 6. 探测 fnpack 二进制
function findFnpack() {
    const env = process.env.FNPACK_BIN;
    if (env && existsSync(env)) return env;

    // 优先匹配项目根目录里 fnpack-* 形式的文件（适配多版本/多平台命名，
    // 比如 fnpack-1.2.1-windows-amd64 / fnpack-1.2.1-linux-amd64 / fnpack-1.2.1-linux-arm64）
    // 优先用与当前平台/架构匹配的，找不到就退回任意 fnpack-*
    try {
        const entries = readdirSync(PROJECT_ROOT)
            .filter((f) => f.toLowerCase().startsWith('fnpack'));

        const platform = process.platform; // 'win32' | 'linux' | 'darwin'
        const arch = process.arch;          // 'x64' | 'arm64'
        const platTag = platform === 'win32' ? 'windows'
                      : platform === 'darwin' ? 'darwin'
                      : 'linux';
        const archTag = arch === 'x64' ? 'amd64' : arch;

        // 第一优先：完全匹配当前平台 + 架构
        const exact = entries.find((f) => {
            const lf = f.toLowerCase();
            return lf.includes(platTag) && lf.includes(archTag);
        });
        if (exact) return join(PROJECT_ROOT, exact);

        // 第二优先：仅平台匹配
        const platMatch = entries.find((f) => f.toLowerCase().includes(platTag));
        if (platMatch) return join(PROJECT_ROOT, platMatch);

        // 第三：任何 fnpack-* 文件
        const anyFnpack = entries.find((f) => /^fnpack[-.]/i.test(f));
        if (anyFnpack) return join(PROJECT_ROOT, anyFnpack);
    } catch (_) {
        // ignore
    }

    // 最后退回写死的几个固定名（向后兼容）
    const candidates = [
        join(PROJECT_ROOT, 'fnpack.exe'),
        join(PROJECT_ROOT, 'fnpack'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

let FNPACK = findFnpack();
if (!FNPACK) {
    console.error('[fpk] 错误：找不到 fnpack 可执行文件');
    console.error('       请把它放到项目根目录，或通过环境变量 FNPACK_BIN 指定路径');
    process.exit(1);
}

// Windows 下若没有 .exe 后缀，复制一份带后缀的临时副本（保留原文件不动）
if (process.platform === 'win32' && !/\.exe$/i.test(FNPACK)) {
    const exeCopy = join(OUT_DIR, 'fnpack.exe');
    cpSync(FNPACK, exeCopy);
    FNPACK = exeCopy;
}
console.log(`[fpk] 使用 fnpack: ${FNPACK}`);

// 7. 调用 fnpack build —— 真实签名是 `fnpack build -d <dir>`，无 -o 参数
//    fnpack 默认会把生成的 fpk 放在工作目录的父目录 / 工作目录里
console.log('[fpk] 调用 fnpack 打包');

// 记录打包前 OUT_DIR 与 WORK_DIR 父目录的 *.fpk 文件，事后对比即可定位输出
function listFpks(dir) {
    if (!existsSync(dir)) return new Set();
    return new Set(readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fpk')));
}
const beforeOut = listFpks(OUT_DIR);
const beforeWork = listFpks(WORK_DIR);
const beforeRoot = listFpks(PROJECT_ROOT);

try {
    execSync(`"${FNPACK}" build -d "${WORK_DIR}"`, {
        stdio: 'inherit',
        cwd: OUT_DIR,
    });
} catch (e) {
    console.error('[fpk] fnpack 执行失败');
    process.exit(1);
}

// 8. 找到产物 fpk
function diff(before, dir) {
    const after = listFpks(dir);
    return [...after].filter((f) => !before.has(f)).map((f) => join(dir, f));
}
const newFpks = [
    ...diff(beforeOut, OUT_DIR),
    ...diff(beforeWork, WORK_DIR),
    ...diff(beforeRoot, PROJECT_ROOT),
];

if (newFpks.length === 0) {
    console.warn('[fpk] 打包似乎完成但没找到新增的 .fpk 文件，请手动检查 dist-fpk/ 目录');
} else {
    // 把所有新产物搬到 OUT_DIR 根，并重命名为 <name>-<version>.fpk
    for (const src of newFpks) {
        const baseName = basename(src, '.fpk');
        const versionedName = baseName.includes(VERSION)
            ? `${baseName}.fpk`
            : `${baseName}-${VERSION}.fpk`;
        const dst = join(OUT_DIR, versionedName);
        if (resolve(src) !== resolve(dst)) {
            cpSync(src, dst);
            rmSync(src, { force: true });
        }
        console.log(`[fpk] 产物: ${dst}`);
    }
}

console.log('');
console.log(`[fpk] 完成。输出目录：${OUT_DIR}`);
console.log('[fpk] 安装方式：把 .fpk 文件传到飞牛 NAS，');
console.log('              在「应用中心 → 设置 → 手动安装」中选择该文件即可。');
