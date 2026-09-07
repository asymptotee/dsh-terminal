# dsh-terminal

DeepSeek Harness 的终端 UI 插件：经官方 dsh 的 profile 插件机制挂载在 `dsh-base` 之上，消费宿主提供的运行时，通过带版本契约的 adapter 边界与上游解耦。

## 架构

- **纯插件挂载** —— 不自带宿主运行时：官方 `dsh` CLI 提供 launcher 与 base bundle（`dsh-base` 是 profile 的第一层），本包只提供 TUI 插件行（`tui-startup`/`tui-runner`，经 `cordis.patch.yml` insert）与 `dsh.bundle.patch` 元数据。运行时依赖全部声明为 peerDependencies。
- **Adapter 边界** —— 官方 `@deepseek-ai/*` 包只允许在 `src/dsh-adapter/` 内被 import；UI 与 driver 一律通过 adapter 的类型 re-export 和服务 facade 间接接触上游。`pnpm run verify:boundary` 扫描源码，发现越界 import 即失败。
- **上游契约** —— adapter 消费的所有依赖按 `src/dsh-adapter/contract.ts` 中的版本线精确钉版（当前 `0.1.2-rc.1`；cordis/loader/schemastery 钉在对应已发布版本）。`pnpm run verify:contract` 对漂移直接失败；上游升版时只需升版本线并修 adapter 暴露的 API 差异。

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
pnpm run build
pnpm run typecheck
pnpm test
pnpm run verify:boundary
pnpm run verify:contract
```

迭代安装：`pnpm build && pnpm pack && dsh plugin --profile dsh-terminal add ./dsh-terminal-<版本>.tgz`（重装会覆盖 profile 里的旧版本）。
