/**
 * bundle 产物闸门，bundle.mjs 之后运行。校验：
 *  (a) @deepseek-ai 未被内联（所有出现都落在带引号的裸 import 说明符里）；
 *  (b) 两个 experimental agent-team 包彻底不出现（它们只能由 loader 独立加载）；
 *  (c) 6 个 adapter 值依赖确实以 external 说明符保留；
 *  (d) 两入口及其 sourcemap 均存在；
 *  (e) release 变体不含任何 dev 构建特征字符串，且 build-info 自洽；
 *  (f) react-devtools-core 的 import 只允许出现在惰性的 devtools chunk 里。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const infoPath = path.join(dist, 'build-info.json')
if (!existsSync(infoPath)) {
  console.error('verify-dist: 缺少 dist/build-info.json —— 请先运行 `pnpm build` / `pnpm build:release`')
  process.exit(1)
}
const info = JSON.parse(readFileSync(infoPath, 'utf8'))
const errors = []

const jsFiles = readdirSync(dist).filter((f) => f.endsWith('.js'))
for (const entry of ['index.js', 'startup.js']) {
  if (!existsSync(path.join(dist, entry))) errors.push(`缺少入口 dist/${entry}`)
}
for (const f of jsFiles) {
  if (!existsSync(path.join(dist, f + '.map'))) errors.push(`缺少 sourcemap dist/${f}.map`)
}

// 期望以 external 说明符保留的 adapter 值依赖（来自 src/dsh-adapter/services.ts）。
const expectedExternal = [
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-cmdline', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools',
]
const forbidden = [
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
]
// release 不应残留的 dev 构建特征。
const devSignatures = [
  /react\.development/, /react-reconciler\.development/, /scheduler\.development/,
  /Invalid hook call/, /Download the React DevTools/,
]

let all = ''
for (const f of jsFiles) {
  const content = readFileSync(path.join(dist, f), 'utf8')
  all += content + '\n'
  // (a) 去掉所有带引号的 @deepseek-ai 说明符后，不应再出现 @deepseek-ai/
  const stripped = content.replace(/["'`]@deepseek-ai\/[^"'`]*["'`]/g, '')
  if (stripped.includes('@deepseek-ai/')) {
    errors.push(`${f}: 存在非 import 说明符形式的 @deepseek-ai 引用（疑似内联了上游代码）`)
  }
  // (b) experimental 包不得出现
  for (const bad of forbidden) {
    if (content.includes(bad)) errors.push(`${f}: experimental 插件包 ${bad} 泄漏进 bundle`)
  }
  // (e) release 不得含 dev 特征
  if (info.variant === 'release') {
    for (const sig of devSignatures) {
      if (sig.test(content)) errors.push(`${f}: release 产物含 dev 构建特征 ${sig}`)
    }
  }
  // (f) react-devtools-core 的真实 import 只允许在惰性 devtools chunk，绝不在入口。
  //     入口里的守卫 `import.meta.resolve("react-devtools-core")` 字符串是预期且
  //     无害的（DEV 未设时永不触发），不算违规。
  const rdcImport = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']react-devtools-core["']/
  if ((f === 'index.js' || f === 'startup.js') && rdcImport.test(content)) {
    errors.push(`${f}: 入口产物出现 react-devtools-core import（应被 splitting 隔离进 devtools chunk）`)
  }
}
// (c) 期望的 external 说明符确实保留（开 splitting 后它们可能落在共享 chunk）
for (const pkg of expectedExternal) {
  if (!all.includes(`"${pkg}"`) && !all.includes(`'${pkg}'`)) {
    errors.push(`期望的 external 说明符 ${pkg} 未在 dist 中出现（可能被意外内联）`)
  }
}
// (e) 变体自洽
if (info.variant === 'release' && info.nodeEnv !== 'production') {
  errors.push('release 变体但 build-info.nodeEnv 不是 production')
}
if (info.variant === 'dev' && info.nodeEnv !== 'development') {
  errors.push('dev 变体但 build-info.nodeEnv 不是 development')
}

if (errors.length > 0) {
  console.error('verify-dist: bundle 闸门未通过：')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log(`verify-dist: ${info.variant} bundle OK（${jsFiles.length} 个 js 文件）`)
