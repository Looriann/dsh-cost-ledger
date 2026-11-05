#!/usr/bin/env node
/**
 * 一键改包名（发布前用）。
 *
 *   node scripts/rename.mjs @你的用户名/dsh-cost-ledger
 *   node scripts/rename.mjs my-dsh-cost-ledger
 *   node scripts/rename.mjs --dry @foo/bar     # 只看会改什么
 *
 * 只碰三个地方，因为它们必须完全一致：
 *   1. package.json            name
 *   2. cordis.patch.yml        insert[].name
 *   3. lib/client.js           __ModuleLoader__.load({ id })
 *
 * 不会碰 repository / homepage / bugs —— 仓库名和包名是两件事，
 * 需要的话自己改 package.json。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const next = args.find((a) => !a.startsWith("--"));

if (!next) {
  console.error("用法：node scripts/rename.mjs [--dry] <新包名>");
  process.exit(1);
}
if (!NAME_RE.test(next)) {
  console.error("包名不合法：" + next + "（只允许小写字母、数字、- . _ ~，可带 @scope/）");
  process.exit(1);
}

const packageFile = join(ROOT, "package.json");
const patchFile = join(ROOT, "cordis.patch.yml");
const clientFile = join(ROOT, "lib", "client.js");

const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
const previous = pkg.name;
if (previous === next) {
  console.log("包名已经是 " + next + "，无需改动。");
  process.exit(0);
}

// 1. package.json：解析后只改 name，保持字段顺序
pkg.name = next;
const pkgText = JSON.stringify(pkg, null, 2) + "\n";

// 2. cordis.patch.yml：只改 insert 行的 name
const patchText = readFileSync(patchFile, "utf8");
const nextPatch = patchText.replace(/(\n\s*name:\s*)"[^"]*"/, '$1"' + next + '"');
if (nextPatch === patchText) {
  console.error("cordis.patch.yml 里没找到 name 字段，请手动检查。");
  process.exit(1);
}

// 3. lib/client.js：模块加载器的 id 必须等于包名
const clientText = readFileSync(clientFile, "utf8");
const idRe = /(__ModuleLoader__\.load\(\{\s*\n\s*id:\s*)"[^"]*"/;
if (!idRe.test(clientText)) {
  console.error("lib/client.js 里没找到 __ModuleLoader__ 的 id，请手动检查。");
  process.exit(1);
}
const nextClient = clientText.replace(idRe, '$1"' + next + '"');

console.log("包名：" + previous + "  →  " + next);
console.log("  package.json       name");
console.log("  cordis.patch.yml   name");
console.log("  lib/client.js      __ModuleLoader__ id");

if (dry) {
  console.log("\n（--dry：没有写入任何文件）");
  process.exit(0);
}

writeFileSync(packageFile, pkgText);
writeFileSync(patchFile, nextPatch);
writeFileSync(clientFile, nextClient);
console.log("\n已写入。接下来：");
console.log("  1) npm run check && npm test");
console.log("  2) 已装过旧版的话，先 dsh plugin --profile desktop remove " + previous);
console.log("     再 dsh plugin --profile desktop add link:" + ROOT);
console.log("  3) npm publish");