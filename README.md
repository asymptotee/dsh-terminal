# dsh-terminal

DeepSeek Harness 的终端 UI 插件：经官方 dsh 的 profile 插件机制挂载在 `dsh-base` 之上，消费宿主提供的运行时，通过带版本契约的 adapter 边界与上游解耦。

## 架构

- **纯插件挂载** —— 不自带宿主运行时：官方 `dsh` CLI 提供 launcher 与 base bundle（`dsh-base` 是 profile 的第一层），本包只提供 TUI 插件行（`tui-startup`/`tui-runner`，经 `cordis.patch.yml` insert）与 `dsh.bundle.patch` 元数据。宿主提供的上游运行时全部声明为 peerDependencies。
- **打包发布（esbuild 双变体）** —— UI 依赖（ink/react/commander/string-width 及其传递依赖）在构建期打进 `dist/`；运行时 external 仅 `@deepseek-ai/*` 与 node 内置。两个 experimental agent-team 包保持为 dependencies——它们是 `cordis.patch.yml` 的独立 loader 插件行，由宿主从 profile 的 node_modules 加载，绝不进 bundle（防双实例）。同一管线两个变体：dev（`NODE_ENV="development"`，保留 React 警告，日常验证）与 release（`NODE_ENV="production"`，dev 代码物理摇掉，发布）；`scripts/verify-dist.mjs` 自动断言打包边界与变体正确性。
- **Adapter 边界** —— 官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import；UI 与 driver 一律通过 adapter 的类型 re-export 和服务 facade 间接接触上游。`pnpm run verify:boundary` 扫描源码，发现越界 import 即失败。
- **上游契约** —— adapter 消费的所有依赖按 `src/dsh-adapter/contract.ts` 中的版本线精确钉版（当前 `0.1.5-rc.2`；cordis/loader/schemastery 钉在对应已发布版本）。`pnpm run verify:contract` 对漂移直接失败；上游升版时只需升版本线并修 adapter 暴露的 API 差异。

## 安装与使用

前置条件：官方 `dsh` CLI、`pnpm` 10+、可用终端 TTY、`DEEPSEEK_API_KEY`（进程 env 或 `$DSH_HOME/.credentials.yaml`）。

```sh
npm install -g @deepseek-ai/dsh          # 官方 CLI
# 发布后：
dsh plugin --profile dsh-terminal add dsh-terminal
# 开发期（未发布）：
pnpm pack
dsh plugin --profile dsh-terminal add ./dsh-terminal-<版本>.tgz

dsh --profile dsh-terminal              # 启动新会话
dsh --profile dsh-terminal --resume <id>  # 恢复持久化会话
node bin/dsh-terminal.js                # 或经本包 bin 直通（profile 未初始化时自动引导）
```

会话统一持久化在 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。

## 开发

```sh
pnpm install
pnpm run build            # dev 变体 bundle → dist/（日常迭代装这个）
pnpm run build:release    # release 变体（dev 代码构建期物理摇掉）
pnpm run typecheck
pnpm test
pnpm run verify:boundary  # 源码级 adapter 边界
pnpm run verify:contract  # 上游版本契约
pnpm run verify:dist      # bundle 产物闸门（build/build:release 已自动带上）
```

迭代安装：**版本号不变时 `add` 会被 pnpm 跳过（`Already up to date`），必须先 `remove` 再 `add`**：

```sh
pnpm build && pnpm pack
dsh plugin --profile dsh-terminal remove dsh-terminal
dsh plugin --profile dsh-terminal add ./dsh-terminal-<版本>.tgz
```

安装后可 `grep -aF "ctx.appExit" ~/.dsh/profiles/dsh-terminal/node_modules/dsh-terminal/dist/index.js` 确认产物就位（bundle 用 `charset: utf8`，中文文案保持字面量，grep 中文亦可）。报错栈要还原到 `src/*.ts` 行号时：

```sh
NODE_OPTIONS=--enable-source-maps dsh --profile dsh-terminal
```

## 发布检查单

```sh
pnpm run release:pack     # build:release + 全量 verify（typecheck/test/boundary/contract）+ pack，
                          # 杜绝把 dev 变体当 release 发出去
dsh plugin --profile dsh-terminal remove dsh-terminal
dsh plugin --profile dsh-terminal add ./dsh-terminal-<版本>.tgz   # 真机装 release 产物冒烟
dsh --profile dsh-terminal                                        # UI/输入/审批/团队面板 + 挂机验证
```

