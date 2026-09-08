# Todolist 机制：原理与实现

> 原理部分与任何具体 UI/宿主无关；实现部分基于 `@deepseek-ai/dsh-tool-todo@0.1.2-rc.1`
> 的真实源码（`lib/index.js`）与中文 README；第三部分基于 dsh-terminal 的 TUI 消费实现。
> 姊妹篇：《Subagent 基本原理与实现》（`subagent.md`）讲委派，《会话事件词汇表》
> （`session-events.md`）讲事件词汇——`todo/write` 是后者中插件声明合并事件的典型例子。

# 第一部分：基本原理

## 1.1 为什么需要 todolist

agent 处理多步骤任务时有三个根本问题：

1. **计划易失**——步骤清单只存在于模型的推理里，长任务中途容易被遗忘或漂移；
2. **进度不可见**——用户看到的只是一连串工具调用，不知道整体进展到哪一步；
3. **单步短视**——没有显式清单时，模型倾向于一步步摸索而不是先规划。

todolist 的解法：**给模型一个面向自己的任务清单工具——开工前先拆步骤写入，
推进时逐项更新状态**。清单既是模型的工作记忆，也是用户可观察的进度面板。

## 1.2 核心模型：整表替换（whole-list replacement）

这是整个机制最关键的设计决策：

```
模型每次调用发送的是【完整列表】，不是增量
  ┌─ 第 1 次调用：[A pending, B pending, C pending]
  ├─ 第 2 次调用：[A in_progress, B pending, C pending]     ← 全量重发
  └─ 第 3 次调用：[A completed, B in_progress, C pending]   ← 全量重发
```

推论有三条：

- **没有部分更新、没有单项编辑、没有回读工具**——模型每次调用必须重新发送完整列表；
- **回放即后写覆盖先写（last-write-wins）**——当前清单 = 最新一条快照，fold 平凡；
- **条目不需要稳定身份**——既然整表替换，就没有 id、没有优先级、没有 active-form
  字段，条目形状刻意保持最小：`content` + 三态 `status`。

## 1.3 具体示例：模型到底看到什么、交出什么

「给模型」包含两个方向：**给模型看的**（工具定义）和**模型要交的**（每次调用的
完整列表参数）。用一个「实现 wordcount CLI」任务完整走一遍。

**① 给模型看的：工具定义**（随每个请求发送）：

```
工具名: todo_write
描述:   记录并更新当前工作的结构化任务清单。每次调用发送完整列表——
        整表替换（无部分更新、无单项编辑）。用于规划多步工作并展示进度：
        开始前每个具体步骤加一条 todo。
        同一时刻至多一个 todo 处于 in_progress……（策略段，随配置切换）
        todo 完成即标 completed（不要攒批）……三态：pending/in_progress/completed。

参数:   todos: array (required) — The COMPLETE task list, replacing any previous list.
        └─ items: object (不允许额外字段)
            ├─ content: string (required) — 任务是啥，简短祈使句
            └─ status:  'pending' | 'in_progress' | 'completed' (required)
```

**② 模型要交的：每次调用都是完整清单**——

第 1 次调用（规划，5 项全 pending）：

```json
todo_write({ "todos": [
  { "content": "检查工作区现状与 Python 环境", "status": "pending" },
  { "content": "实现核心模块 wordcount.py",   "status": "pending" },
  { "content": "编写单元测试",                "status": "pending" },
  { "content": "运行测试并验证 CLI 入口",      "status": "pending" },
  { "content": "输出最终交付摘要",            "status": "pending" }
]})
```

→ 返回给模型：`Updated todo list: 5 pending, 0 in progress, 0 completed.`；日志追加
第 1 条 `todo/write` 快照。

第 2 次调用（开工——注意：**不是「把第 1 项改成 in_progress」，而是把 5 项全部重发**）：

```json
todo_write({ "todos": [
  { "content": "检查工作区现状与 Python 环境", "status": "in_progress" },
  { "content": "实现核心模块 wordcount.py",   "status": "pending" },
  { "content": "编写单元测试",                "status": "pending" },
  { "content": "运行测试并验证 CLI 入口",      "status": "pending" },
  { "content": "输出最终交付摘要",            "status": "pending" }
]})
```

第 3 次调用（第 1 项完成、第 2 项开工——又是完整 5 项），如此反复，最后一次调用
5 项全 `completed`。

对比增量式 API（**这个工具不是这样**）：增量式会说 `update_item(id=1, status=done)`
——需要稳定 id、需要回读当前状态、回放时还得按序重放所有增量。整表替换把这些全部省掉：
**任意一条快照自身就是完整的当前状态**。

**③ 各方分别拿到什么**（以第 2 次调用为例）：

| 消费者 | 拿到什么 |
|---|---|
| **模型**（当轮） | 一句确认：`Updated todo list: 4 pending, 1 in progress, 0 completed.`（很小，形状固定） |
| **模型**（后续请求） | 历史里的调用参数——**完整的 5 项列表**原样保留（这就是随清单增长的 token 成本，保留到压缩） |
| **会话日志** | 一条 `todo/write` 事件，载荷 = 完整列表快照 |
| **TUI** | 从事件流渲染面板：`● todolist进行中...` + `◼ 检查工作区...` + 4 个 `◻` |
| **校验失败时** | 稳定错误文本：content 重复 → `Error: invalid todos: duplicate content "编写单元测试"`；策略为 false 时标了两个 in_progress → `Error: invalid todos: at most one task may be in_progress (got 2)` |

「给模型」= 一个 `todo_write(todos)` 工具 + 「每次必须重发完整列表」的规则；模型交回
的每次都是**当前全量清单**，系统把它原样快照进日志——模型用冗余的参数换取了无需记忆
id、无需回读、可回放的最简心智模型。

## 1.4 事件溯源：清单是日志里的一类事件

todolist 不是工具的内存状态，而是**会话日志里的事件序列**：

```
工具 execute → agent.session.append('todo/write', { todos })
                    │
                    ▼
        会话日志追加一条完整列表快照事件
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   重放 / 投影               UI 订阅渲染
（恢复会话、web 客户端）   （TUI 面板、计划条）
```

这与《会话事件词汇表》里的事件溯源模型完全一致——`todo/write` 由本包通过
declaration merging 并入 `SessionEventMap`。**UI 与回放状态都从事件流渲染，
工具结果（给模型看的确认文本）不是第二条模型消息，二者互不冒充**。

## 1.5 三态生命周期与单活跃纪律

```
pending（未开始）→ in_progress（正在做）→ completed（完成）
```

状态纪律由部署配置 `allowParallelInProgress` 选择——**这是部署层决策而非固定规则**
（并发的活跃任务是否合理，取决于工具无法观测的运行时并发情况）：

| 策略 | 面向模型的指令 | 接受的输入 |
|---|---|---|
| `true` | 「把所有正在推进的任务都标 `in_progress`——真并行时可以多个」 | 任意数量的 in_progress |
| `false` | 「同一时刻至多一个 `in_progress`，恰有一个活跃任务」 | 超过一个即拒绝 |

开关**同时改变指令与验证**——描述文本切换措辞，`execute` 同步放宽/收紧校验。
注意：持久日志的不变式**不跟随**这个开关——在允许并行时写下的日志，部署收紧策略
后仍必须可回放，因此不变式对活跃数量保持沉默。

## 1.6 单一所有者（single owner）

清单属于**调用工具的那个 agent 会话**，一个且仅一个：

- 不存在 subagent / 共享 / swarm scope——这是有意设置的 scope 限制；
- 非 agent 调用方（没有 `exec.agent`）无处写入清单，直接拒绝：
  `Error: todo_write requires an owning agent session`；
- 子代理可以有自己的清单（它有自己的会话），与父级的清单互不干扰——这正是
  `subagent.md` 里「每个子代理一个独立 fold」的另一个受益者。

## 1.7 Turn 级生命周期

清单是**当前轮次**的活跃计划：

- `todo/write` 更新当前清单（整表替换）；
- **`turn/start` 清空**——下一轮开始时清单归零（旧计划属于上一轮，不应残留）；
- `turn/end` **保留**刚完成的清单——轮次结束到下一轮开始之间，用户还能看到
  最终的完成状态。

这个「下一轮清空」的生命周期由上游投影与本工程 fold 共同遵守（web 客户端同样
依据「当前有效计划 = 其后没有更晚 `turn/start` 的最近一次 `todo/write`」渲染）。

## 1.8 生命周期全景

```
模型规划 → todo_write（完整列表，多为 pending）→ todo/write 事件落日志
→ 推进：逐项 in_progress / completed，每次全量重发 → 事件持续追加快照
→ 全部 completed（UI 可据此自动隐藏面板）
→ turn/end 保留清单 → 下一轮 turn/start 清空
```

# 第二部分：dsh-tool-todo 的实现

> 本部分按第一部分的每条原理，给出对应的具体实现。

## 2.1 总览：原理 → 实现位置

| 原理 | 具体实现 |
|---|---|
| 模型侧清单工具 | `apply` 注册 `todo_write`（`defineTool`），描述由四段文本按策略拼合 |
| 整表替换 + 落日志 | `execute`：校验 → `agent.session.append('todo/write', { todos })` |
| 条目形状最小化 | `TodoItem = { content, status }`；schema `additionalProperties: false` |
| 输入校验 | `toTodoList`：trim 非空、去重、in_progress 数量（按部署策略） |
| 单一所有者 | `exec.agent` 缺失即抛 `todo_write requires an owning agent session` |
| 回放 / 投影 | `todos` 投影单元：`init=null`、`apply` 整表取 / `turn/start` 清空、`stateVersion=2` |
| Turn 级清空 | 投影 `apply` 与本包约定：`turn/start → null`（`turn/end` 不动） |
| 类型扩展 | declaration merging：`SessionEventMap['todo/write']`、`SessionProjectionMap.todos` |

## 2.2 工具注册：`apply`

```ts
export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']

export function apply(ctx: Context, config: Config): void {
  const allowParallel = config.allowParallelInProgress   // 必填，部署层显式选择
  ctx.sessionProjections.register({ ... })               // todos 投影单元（见下文）
  ctx.tools.register(defineTool({ ... }))                // todo_write 工具
}
```

`Config` 只有一个字段且 **required**：`allowParallelInProgress: boolean`——每个组合
都必须显式表态，不允许默认值含糊过去。

**导出形状**的细节：函数/命名空间插件导出 `name`/`inject`/`apply`，**不提供默认导出**
——意外的 `export default` 会被 Loader 的 `unwrapExports` 折叠，导致 `inject` 丢失
（上游有专门的 postmortem 记录这个事故）。

## 2.3 工具描述：按策略拼合的四段文本

面向模型的 description 由四段常量拼成，**唯一的可变段是「活跃状态条款」**——因为它
是唯一随并行策略变化的指令：

```ts
DESCRIPTION_HEAD    // 「记录并更新当前工作的结构化任务清单。每次调用发送完整列表——
                    //   整表替换（无部分更新、无单项编辑）。用于规划多步工作并展示
                    //   进度：开始前每个具体步骤加一条 todo。」
DESCRIPTION_PARALLEL // 「把每个正在推进的 todo 标 in_progress——工作真并行时（并发
                     //   subagent、后台命令）可以多个，顺序工作就一个；有活没干完时
                     //   至少一个任务应是 in_progress。」
DESCRIPTION_SINGLE  // 「同一时刻至多一个 todo 处于 in_progress；有活没干完时恰有一个
                    //   活跃任务。」
DESCRIPTION_TAIL    // 「todo 完成即标 completed（不要攒批）；全部完成才允许没有
                    //   in_progress 项。平凡单步任务不用清单。三态说明……」

function describe(allowParallel: boolean): string {
  return DESCRIPTION_HEAD + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL
}
```

## 2.4 参数 schema：`additionalProperties: false` 的用意

```ts
parameters: { todos: {
  type: 'array', required: true,
  description: 'The COMPLETE task list, replacing any previous list.',
  items: {
    type: 'object',
    additionalProperties: false,      // ★ 关键
    properties: {
      content: { type: 'string', required: true, description: '任务是啥——简短祈使句' },
      status:  { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
    },
  },
} }
```

`additionalProperties: false` 的设计理由（源码注释）：**落日志的快照必须等于模型
自认为写入的内容**——扩展条目形状（嵌套对象、额外字段）应当在 schema 边界响亮失败，
而不是被静默压平。这与第一部分「条目形状刻意最小」互为表里。

## 2.5 校验：`toTodoList`

registry 已按 schema 做了类型/必填/枚举检查；`toTodoList` 负责 schema 表达不了的
约束，并产出规范的 `TodoItem[]`：

```ts
function toTodoList(raw, allowParallel): TodoItem[] {
  for (const item of raw) {
    const content = item.content.trim()
    if (content.length === 0) throw new Error('invalid todo: `content` must be a non-empty string')
    if (seen.has(content)) throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`)
    if (item.status === 'in_progress') active++
    todos.push({ content, status: item.status })      // 只保留 content/status
  }
  if (!allowParallel && active > 1)
    throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`)
  return todos
}
```

三条规则：**trim 后非空**、**content 不重复**、**in_progress 数量受部署策略约束**。
列表的顺序与及时更新不在校验范围——由模型依照工具描述负责。

## 2.6 execute：校验 → 落日志 → 规范结果

```ts
execute(args, exec) {
  const todos = toTodoList(args.todos, allowParallel)
  if (!exec.agent) throw new Error('todo_write requires an owning agent session')  // 单一所有者
  exec.agent.session.append('todo/write', { todos })        // ★ 整表快照落日志
  return Promise.resolve({
    todos: todos.map(todo => ({ content, status })),
    counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
  })
}
```

**规范结果与渲染**：output schema 是 `{ todos, counts }`；渲染器把结果浓缩为一句
确认——

> `Updated todo list: 2 pending, 1 in progress, 0 completed.`

**稳定失败文本**（模型可预期）：

- ``Error: invalid todo: `content` must be a non-empty string``
- `Error: invalid todos: duplicate content "<content>"`
- `Error: todo_write requires an owning agent session`
- `Error: invalid todos: at most one task may be in_progress (got <n>)`（仅
  `allowParallelInProgress: false` 的部署）

**`presentCall`**：generic 卡，标题 `Update todo list`——TUI 里工具行的显示来源。

## 2.7 会话投影：`todos` 单元

当组合挂载了 `ctx.sessionProjections` 时，本包注册 `todos` 投影单元——非 UI 消费者
（查询服务、host 协议）由此读取当前清单：

```ts
ctx.sessionProjections.register({
  key: 'todos',
  stateSchema: todosProjectionSchema,        // zod: TodoItem[] | null
  init: () => null,                          // 尚无写入
  apply: (state, event) => {
    if (event.type === 'todo/write') return event.data.todos   // 整表取
    if (event.type === 'turn/start') return null               // 下一轮清空
    return state                                               // 其余事件原样
  },
  wire: { viewSchema: todosProjectionSchema, view: state => state },
  stateVersion: 2,
})
```

要点：

- **fold 与 UI 的语义完全一致**——`turn/end` 保留刚完成的清单、`turn/start` 清空，
  与第一部分「Turn 级生命周期」逐字对应；
- `view` 恒等（状态即视图）；框架驱动该单元，载体经历史尾页与
  `session/projection` 推送帧提供该值；未挂载投影注册表的组合不受影响。

## 2.8 类型声明合并（declaration merging）

本包是「插件扩展会话事件词汇表」的标准范例（见《会话事件词汇表》对应章节）：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 整表快照；回放后写覆盖先写。仅 UI 状态的日志；不做派生历史。 */
    'todo/write': { todos: TodoItem[] }
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前整表（最新 todo/write 快照）；首次写入前为 null。整表规则：后写覆盖。 */
    todos: TodoItem[] | null
  }
}
```

`TodoItem` 的定义刻意写明设计理由：

```ts
export interface TodoItem {
  /** 任务是啥——UI 里显示的简短祈使句。 */
  content: string
  /** 生命周期状态；并行工作时可多项 in_progress。 */
  status: 'pending' | 'in_progress' | 'completed'
}
// 刻意最小：整表替换（last-write-wins）使条目无需稳定身份——没有 id、优先级、activeForm。
```

## 2.9 模型体验（token 与 KV cache）

- **schema**：工具可见的每个请求都有固定 schema token 开销；定义与可见性不变时
  前缀稳定（KV cache 友好）
- **调用历史**：每次调用的参数里保留整个替换列表——token 用量随清单增长，且这些
  参数**保留到压缩（compaction）**；结果本身很小且形状固定
- **KV cache**：仅追加——新可见内容位于可复用请求前缀之后，不使既有缓存失效

## 2.10 已知限制

- **仅单一所有者 scope**：subagent/共享/swarm scope 是有意设置的限制，非 agent
  调用方被拒绝
- **条目形状刻意最小**：content + 三态 status；整表替换不需要稳定 id/优先级
- **整表替换是唯一操作**：没有部分更新、没有回读工具，模型每次全量重发

# 第三部分：dsh-terminal 的 TUI 消费实现

一个消费方如何在 adapter 边界纪律下渲染 todolist——每条机制对应到具体代码。

## 3.1 边界纪律下的接入

`dsh-tool-todo` 在运行时依赖里（peer），但 UI 层**不直接 import**：

- `src/dsh-adapter/effects.ts`：`import type {} from '@deepseek-ai/dsh-tool-todo'`
  ——纯声明合并副作用，把 `'todo/write'` 事件并入类型面，零运行时代码
- `src/dsh-adapter/types.ts`：`export type { TodoItem }`——UI 层经 re-export 间接
  接触上游类型（`verify:boundary` 强制这条纪律）

## 3.2 fold：`todo/write` 与 `turn/start`（`src/frames.ts`）

```ts
case 'todo/write': {
  // 全部完成的清单是「用完的」：常驻面板自我隐藏，流内的工具卡保留为完成记录。
  const todos = event.data.todos
  const plan = todos.every(todo => todo.status === 'completed') ? undefined : todos
  return { state: { ...state, plan }, lines: renderPlanLines(todos) }
}
case 'turn/start': {
  // turn 级生命周期：常驻清单在下一轮清空。
  const closed = closeOpenAssistant(state, event.time)
  return { state: { ...state, ...closed, plan: undefined }, lines: [] }
}
```

三个要点：

- `state.plan` 是常驻清单——fold 纯函数，**恢复会话重放日志时面板自动重建**
- **全部完成自动隐藏**：`todos.every(completed)` 时 plan 置空；流内的
  `● Todo_write (Update todo list)` 工具卡保留为完成记录
- `turn/start` 清空与上游投影的语义逐字一致——消费方与投影各自独立遵守同一约定

## 3.3 纯文本路径：`renderPlanLines`（`src/render.ts`）

M2 纯文本视图（仅测试消费）与 ink UI 保持同一风格：

```ts
export function renderPlanLines(todos: readonly TodoItem[]): readonly string[] {
  const lines = ['● todolist进行中...\n']
  todos.forEach((todo, index) => {
    const mark = todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '◼' : '◻'
    const prefix = index === 0 ? '  ⎿  ' : '     '
    lines.push(`${prefix}${mark} ${todo.content}\n`)
  })
  return lines
}
```

## 3.4 UI：钉在输入框上方的清单面板（`src/renderer.tsx`）

```
（流式帧 / 审批提示）
● todolist进行中...          ← 绿点头部，与工具行同款
  ⎿  ✔ 已完成任务             ← ⎿ 连接符几何（首行 5 列，续行对齐）
     ◼ 进行中任务             ← 工程蓝 #a5d8ff
     ◻ 待办任务               ← dim
❯ ▏                          ← 输入框
```

实现要点：

- **位置**：`TuiApp` 布局中 Overlay 之下、`InputBar` 正上方——显示期间始终钉在
  输入框上方，流式帧在它上方滚动
- **标记映射**：`completed → ✔`（绿）、`in_progress → ◼`（工程蓝 `#a5d8ff`）、
  `pending → ◻`（dim）
- **dim 继承教训**：列表行的 dim 只作用于任务文本
  （`<Text>{prefix}{mark} <Text dimColor>{todo.content}</Text></Text>`）——ink 的
  dimColor 会继承给嵌套 Text，若整行 dim 包裹会把着色标记也压暗
- **子代理视图**：`ChildView` 复用同一组件渲染子代理自己的 plan——每个子代理一个
  独立 fold 的直接受益（见 `subagent.md` 第三部分）

## 3.5 测试覆盖

| 套件 | 覆盖 |
|---|---|
| `tests/frames.spec.ts`（`fold: todo plan`） | 写入即渲染（精确行匹配）、turn/start 清空、跨 assistant 输出保留、全部完成自动隐藏 |
| `tests/renderer.spec.tsx` | 面板渲染 + 标记 + 连接符几何 + 钉在输入框上方的顺序断言 |
| `tests/tui.spec.ts` | driver 级：下一轮清空 plan |

## 3.6 与并行 subagent 的呼应

`allowParallelInProgress: true` 的部署与 `subagent.md` 的「多个子 Agent 的并行执行」
直接呼应——并发子代理同时推进多项任务时，模型可以把多个 todo 标 `in_progress`，
面板上多个 `◼` 并列就是并行工作的可视化。

# 一句话总结

**todolist 的基本原理 = 给模型一个整表替换的任务清单：每次调用全量重发、落一条
`todo/write` 快照事件、回放后写覆盖先写；条目刻意最小（content + 三态），单活跃还是
多活跃由部署策略选择；清单属于唯一调用会话、随 `turn/start` 清空；消费方（如本 TUI）
只需订阅事件流即可渲染常驻面板——工具结果与 UI 状态同源同日志、互不冒充。**
