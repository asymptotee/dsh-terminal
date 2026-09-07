# dsh 会话事件词汇表

> 基于 `@deepseek-ai/dsh-session@0.1.2-rc.1`（`lib/types/types.d.ts` 的 `SessionEventMap`）整理，
> 并标注 dsh-terminal 的 fold（`src/frames.ts`）如何消费每类事件。

## 基础概念：事件溯源

dsh 的会话是**事件溯源（event-sourcing）**模型：会话中发生的一切都是一条条追加进不可变日志的事件，
每条带 `seq`（序号）和 `time`（时间戳）。推论有两条：

- **显示 = fold**——把事件流折叠成显示状态（本工程在 `src/frames.ts`），同一事件序列折叠两次结果相同；
- **恢复 = 重放**——恢复会话就是重放持久化日志走同一个 fold，显示自动重建。

## 层级骨架：session → turn → step

```
session（会话）
 └─ turn（回合：提交一条消息 → agent 处理到收尾）
     └─ step（步骤：一次模型调用 + 它请求的工具执行）
```

一个 turn 可以有多个 step（模型调工具 → 工具结果进下一步的上下文，循环往复）；
没有进入任何 step 的 turn（例如直接被拒）不会有 step 事件。

## 生命周期事件（层级骨架）

| 事件 | 载荷 | 含义 |
|---|---|---|
| `turn/start` | `{turn}` | 回合开始 |
| `turn/end` | `{turn, reason}` | 回合结束，reason 六态见下 |
| `step/start` | `{turn, step}` | 步骤开始 —— 心跳指示器 `✢ Running…` 的起点 |
| `step/end` | `{turn, step}` | 步骤结束 —— 指示器消失点 |

`turn/end` 的六种 reason（`TurnEndReasonMap`，插件可合并扩展）：

| kind | 场景 |
|---|---|
| `completed` | 正常完成 |
| `aborted` | 被取消 —— Ctrl+C 中断就是它 |
| `blocked` | 被阻塞 |
| `error` | 失败，携带结构化 `LlmFailure`（API 错误等） |
| `max-tokens` | 至少一个 step 撞到输出 token 上限 |
| `interrupted` | **不是循环发出的** —— 重载时持久层给「崩溃孤儿回合」补的收尾标记，崩溃前的事件保持完整 |

## Step 内的内容事件

| 事件 | 载荷要点 | 含义 |
|---|---|---|
| `user/message` | `UserMessage` | user 角色消息：人类输入、合成注入（`agent.inject()` —— 文件变更通知、skill 内容、cron 通知等）、goal 续轮；`source` 区分三者 |
| `assistant/chunk` | `{turn, step, chunk: StreamChunk}` | 原始流式增量（token 级重放保真）。chunk 四类：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta`。**不携带 token 用量** |
| `assistant/message` | `{turn, step, message, usage?, interrupted?}` | 一个 step 组装完成的完整消息；`usage`（`TokenUsage`）在此才出现 —— 没有独立的 usage 事件；中途取消的回合以 `interrupted: true` 收尾 |
| `tool/call` | `{turn, step, callId, name, arguments}` | 模型请求一次工具调用；`arguments` 是原始 JSON 字符串（未解析），`callId` 配对结果 |
| `tool/result` | `{turn, step, message, error?, meta?}` | 工具执行结果；`meta` 是工具私有展示载荷（如 `dsh-tool-fs` 的结果时上下文 diff），核心不透明但必须 JSON 可序列化 —— 重放时还原同一张卡 |

## Log-only 事件（只进日志，不进显示）

| 事件 | 含义 |
|---|---|
| `request/header` | 下次请求的完整头部快照（调用配置、system prompt、工具表）；最新一份快照即可重建请求头 |
| `request/context` | 路由元数据；仅路由或容量变化时记录，不参与请求重建 |
| `session/end-seed` | **种子结束标记**：它之前的事件来自种子历史（resume / fork / replay），本次活会话没有产生它们；载荷为空，位置即语义。只有 `Session` 构造器是合法写入者 |

## 插件声明合并的事件

`SessionEventMap` 是可扩展接口 —— 各包通过 declaration merging 注入自己的事件，
运行时零代码。本工程 adapter 的 `src/dsh-adapter/effects.ts` 因此只 `import type {}` 这些包
（把合并拉进类型面），不产生任何运行时依赖：

| 事件 | 来源包 | 含义 |
|---|---|---|
| `command/run` / `command/done` | `dsh-commands` | 斜杠命令的执行记录与结算 |
| `todo/write` | `dsh-tool-todo` | todolist 全量快照（整表替换，last-write-wins） |
| `subagent/descriptor` | `dsh-subagent` | 子代理标签（本工程按结构读取，不 import 该包） |

## 典型时间线（示意）

```
turn/start {turn:1}
step/start {turn:1, step:1}          ← ✢ Running… 出现
assistant/chunk ×N                   （推理/文本/工具调用增量流式到达）
assistant/message (usage)
tool/call {callId, name, arguments}
tool/result {callId, message}
step/end {turn:1, step:1}            ← 指示器消失（多步回合时下一步立即续上）
step/start {turn:1, step:2}
...
turn/end {turn:1, reason:{kind:'completed'}}   ← 兜底清空指示器
turn/start {turn:2}                  ← plan 面板清空（turn 级生命周期）
```

## dsh-terminal 的 fold 映射（`src/frames.ts`）

| 事件 | fold 动作 |
|---|---|
| `user/message` | user 帧（`❯`）；notice 形态的注入渲染为 notice 帧 |
| `assistant/chunk` | 流式 assistant 帧（80ms 合批渲染） |
| `assistant/message` | 提交 assistant 帧 + usage（footer 上下文占比） |
| `tool/call` / `tool/result` | 工具卡帧 pending → 填充结果视图 |
| `command/run` / `command/done` | 命令帧 pending → 结算结果 |
| `todo/write` | plan 面板（全部完成自动隐藏） |
| `step/start` | `activeStep` 开表（`startedAt = event.time`） |
| `step/end` | 匹配 turn/step 才关表（防陈旧事件误清） |
| `turn/start` | 清 plan + 关闭未完成的 assistant 帧 |
| `turn/end` | 关闭 assistant 帧 + 兜底清空 `activeStep` |
| default（`request/header`、seed 标记、会话生命周期） | log-only，不渲染 |

## 一句话总结

**turn 是「一问一答」的边界，step 是「一次思考 + 一批工具」的边界，
chunk / message / tool 是内容，request / seed 是幕后记录，插件按需扩展词汇表。**
