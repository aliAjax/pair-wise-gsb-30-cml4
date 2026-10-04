// 自测入口：用 vite 自带的 esbuild 把 TS 测试打包为临时 CJS，再用子进程执行并清理
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { rmSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".tmp-sync-test.cjs");

try {
  await build({
    entryPoints: [path.join(here, "sync.test.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "warning",
  });
  execFileSync(process.execPath, [outfile], { stdio: "inherit" });
} finally {
  rmSync(outfile, { force: true });
}
