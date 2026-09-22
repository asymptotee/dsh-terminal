/**
 * dsh-terminal 双变体 esbuild 打包。
 *
 *   node scripts/bundle.mjs            -> dev 变体     (NODE_ENV=development，保留 React 警告)
 *   node scripts/bundle.mjs --release  -> release 变体 (NODE_ENV=production，dev 代码构建期物理摇掉)
 *
 * 两变体产物形态完全一致（external 边界、入口结构、sourcemap），仅 define 的
 * NODE_ENV 不同：日常迭代装 dev 变体（调试信息齐全，panelTick 的时间线清理兜底
 * 挂机安全），发布走 release 变体（dev reconciler 及其 performance.measure 埋点
 * 在构建期被常量折叠 + DCE 物理移除，根治挂机 OOM）。
 */
import * as esbuild from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = process.argv.includes('--release')
const variant = release ? 'release' : 'dev'
const nodeEnv = release ? 'production' : 'development'
const outdir = path.join(root, 'dist')

// 必须排除在 bundle 之外、运行时由宿主解析的模块：
//  - @deepseek-ai/*：dsh-base profile 提供（16 个 peer）或以 dependencies 装进
//    profile（experimental-agent-team / tool-agent-team 两者——它们是
//    cordis.patch.yml 的独立 loader 插件行，绝不能内联出第二份实例）。adapter
//    的 6 条值 re-export 依赖宿主解析，通配符 external 后以裸说明符保留在产物
//    里（verify-dist 校验）。
//  - react-devtools-core：ink 的 optional peer，未安装。ink 仅在 process.env.DEV
//    守卫下经动态 import 触达它；必须 external，否则 esbuild 解析失败。配合
//    splitting，它连同 ws 被关进一个永不加载的惰性 chunk（见 splitting 注释），
//    不会被提升到主入口顶层造成运行期 MODULE_NOT_FOUND。
// node 内置模块由 platform:node 自动 external。
const external = [
  '@deepseek-ai/*',
  'react-devtools-core',
]

// esbuild 不清空 outdir：先删，避免上一次构建的陈旧 hash chunk 被打进包里。
rmSync(outdir, { recursive: true, force: true })

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts', 'src/startup.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',            // engines: ^22.19 || >=24
  // 关键：ink 的 reconciler 有受 DEV 守卫的 `await import('./devtools.js')`。
  // 不开 splitting 时，esbuild 会把 devtools 依赖的 react-devtools-core import
  // 提升到入口顶层——加载即崩。splitting 把它隔离成惰性 chunk，主入口只留守卫
  // 内的 `await import("./devtools-*.js")`，DEV 未设时永不触发。
  splitting: true,
  sourcemap: true,             // 外链 .js.map + sourceMappingURL 注释
  sourcesContent: true,        // map 内嵌原始 TS，profile 内无 src/ 也能还原源码行
  charset: 'utf8',             // 保留中文 UI 文案字面量（默认 ascii 会转 \uXXXX）
  jsx: 'automatic',            // 对齐 tsconfig 的 react-jsx；与 bundle 内唯一 react 同源
  define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
  external,
  // CJS 依赖里的条件分支 require（如 ink 的 signal-exit 在 if/else 内
  // require('assert')）无法静态提升为 ESM import，esbuild 留 __require 桩，
  // ESM 输出没有 require → 加载即抛 "Dynamic require of X is not supported"。
  // banner 在模块顶部注入真实 require，桩即回退到它（实测 smoke 确认）。
  banner: {
    js: [
      "import { createRequire as __dshTerminalCreateRequire } from 'node:module';",
      'const require = __dshTerminalCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  // 不开 minify：仅 define + esbuild DCE 已物理摇掉 dev 代码（实测），且保持
  // 两变体"仅 define 不同、结构一致、release 亦可读"。
})

writeFileSync(
  path.join(outdir, 'build-info.json'),
  JSON.stringify({ variant, nodeEnv, builtAt: new Date().toISOString() }, null, 2) + '\n',
)
console.log(`bundle: ${variant} 变体 (NODE_ENV=${nodeEnv}) -> dist/`)
