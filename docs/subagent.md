# Subagent 基本原理与实现

> 原理部分与任何具体 UI/宿主无关；实现部分基于 `@deepseek-ai/dsh-subagent@0.1.2-rc.1`
> 的真实源码（`lib/index.js` bundle：descriptor / child-agent / continuation /
> run-settlement / 服务主体）与 deepseek-harness monorepo 的源码
> （`packages/subagent/` 下的 `subagent-in-process-driver`、`subagent-spawn-in-process`、
> `tool-subagent`；`packages/core/` 下的 `agent`（注册表）、`agent-loop`（工厂与
> step 调度器）、`tools`（并发分类））；第三部分基于 dsh-terminal 的 TUI 消费实现；
> 运行时基础（Node.js 事件循环与 I/O 多路复用）并入第二部分末尾。

# 第一部分：基本原理

## 为什么需要 subagent

一个 agent 把所有工作都自己做，会遇到四个根本问题：

1. **上下文污染**——调研一个陌生代码库要读几十个文件，这些中间过程全部进入主对话的
   上下文窗口，挤占真正重要的推理空间；
2. **串行瓶颈**——多件互不依赖的工作只能一件件做；
3. **无法特化**——某些子任务用更便宜/更快的模型、更窄的工具集、不同的人格更合适；
4. **风险耦合**——一段失控的探索（死循环、误操作）会拖垮整个会话。

subagent 的解法：**把工作委派给一个独立的子 agent，它在自己的会话里烧自己的上下文，
父级只收一份蒸馏后的结果**。中间过程再冗长，回流到父级的只是一条最终消息。

## 核心模型：委派 = 「任务外包 + 结果回流」

```
父 agent
  │  委派请求：任务描述（prompt）+ 标签 + 约束（模型/工具/深度/人格）
  ▼
子 agent（一个完整的 agent：自己的会话、自己的 turn/step 循环、自己的事件日志）
  │  在自己的上下文里独立完成工作（读文件、跑命令、写代码……）
  ▼
结算：最终输出 + 停止原因（completed / aborted / error / refusal）
  │
  ▼
父 agent 的上下文里追加一条「结算通知」——子代理的收尾消息
```

三个要点：

- **子代理不是函数调用，是一个完整 agent**——它有自己的事件溯源会话日志（与主会话
  同一套事件词汇：turn/step/chunk/message/tool），因此完全可观察、可重放；
- **父级看到的是蒸馏结果，不是过程**——回流只有子代理的最终 assistant 内容；
- **权限在委派时固定**——子代理的权限范围启动即定死，内部无法扩大（需审批的操作
  自动拒绝），越界需求只能在回复里说明、由父级处理。

## 会话树：血缘与隔离

每个子代理是一个真实会话，头部携带 `parentSession` 指向父会话——由此形成一棵**会话树**：

```
root session
 ├─ child A（parentSession = root）
 │   └─ grandchild（parentSession = A）
 └─ child B（parentSession = root）
```

- **血缘可发现**：沿着 parentSession 链就能枚举任何节点的直接子级或完整后代树，
  不需要加载任何 agent——观察与执行分离；
- **隔离是硬边界**：子代理崩溃或行为异常无法破坏父级会话；每个子代理的失败以
  结构化的停止原因 + 安全诊断结算，父级据此决策；
- **深度可控**：委派可以递归（子代理再委派），但深度上限（maxDepth）在委派时声明，
  防止无限套娃。

## 两种形态：一次性 vs 可继续

| 形态 | 心智模型 | 适用 |
|---|---|---|
| **one-shot** | 「外包一单活」：跑一次，交一份结果，生命周期结束 | 调研、代码审查、独立子任务 |
| **continuable** | 「雇一个长期助手」：持久会话，可以反复发后续消息、可以打断它当前的活而不销毁它 | 长期协作、需要多轮交互的子任务 |

continuable 的关键机制：

- **冷恢复**——直接 child 不在内存时，从持久化会话日志恢复（事件溯源的红利：
  日志即完整状态）；
- **相邻消息（Steer）**——父↔子之间按序投递消息；正在工作的子在最近的 step 边界
  接收，空闲的子被唤醒开启新轮次；
- **结算通知进父级轮次流**——子的每次驻留运行结算时，父级在自己的事件流里收到通知。

## 生命周期全景

```
委派 → 建立（构建子 agent / 预留身份）→ 发布（所有权交给调用方）
→ 运行（子代理自己的 turn/step 循环，事件持续落日志）
→ 结算（四种停止原因之一）
→ 结果回流（结算通知进父级上下文）
→ [continuable] 等待后续消息 / 冷恢复，循环回「运行」
```

失败语义统一：**要么拥有一段在线运行，要么一无所有**——建立失败时资源全部回滚，
不存在「半死不活」的中间态。

# 第二部分：dsh-subagent 的实现

> 本部分按第一部分的每条原理，给出对应的具体实现。

## 总览：委派流程图的每一步 → 实现位置

| 流程图环节 | 具体实现 |
|---|---|
| ① 委派请求（prompt + 标签 + 约束） | 模型侧：`dsh-tool-subagent` 的工具参数 → `SubagentStartRequest`；服务侧：`start()` 六步校验 |
| ② 创建子 agent（自己的会话/循环/日志） | one-shot：共享 driver `startInProcessRun`（铸 SessionId → 三助手 → `ctx.agents.create()`）；continuable：管理器 `agents.create()` / `agents.resume()`（冷恢复）；`agents.create` 内部的工厂创建事务见「子 Agent 创建的完整链路」专节 |
| ③ 子级在自己上下文里独立工作 | 子代理就是普通 Agent，跑标准 turn/step 循环；权限被策略捕获三件套钉死；continuable 子级的初始提示词被追加回传指引 |
| ④ 结算（输出 + 停止原因） | one-shot：`settleRun` / `runOutcome`；continuable：`finishDisposal` child-first 释放 → `observer.capture` 捕获终态 |
| ⑤ 结算通知追加进父上下文 | `notifySettlement`：`settlementSummary` 生成开头句 + `createUserMessage`（`source.kind: 'subagent-settled'`、`form: 'notice'`）+ inject / followup 分发 |

## seam 架构：一个服务，多个提供方

`ctx.subagents`（`SubagentRuntime`）是**具名提供方注册表**——委派约定与后端实现分离。
启用委派需要三件套：服务 + 提供方后端 + 面向模型的委派工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'                    # 服务（注册表 + 路由）
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'   # 提供方后端（其一）
- name: '@deepseek-ai/dsh-tool-subagent'               # 委派工具（模型看到静态工具）
  config: { provider: spawn, toolName: subagent }
```

**注册的具体实现**：`registerProvider` 是一个 cordis generator effect——重名直接抛
`DUPLICATE_PROVIDER`；effect 的 cleanup 段从 Map 删除并发 `subagent/provider-removed`。
这就是「注册受 effect 作用域约束、HMR 安全」的落地：热重载时旧 effect 清理、新 effect
重注册，而**已交付给持有者的运行不受影响**（它们不在注册表里，在调用方手里）。

**spawn 提供方本体**（`dsh-subagent-spawn-in-process`，全部实现仅 64 行）：

```ts
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false   // spawn 子级从零开始——绝不看到父对话
  start(request) { return startInProcessRun(request, {}) }        // 无种子 → 共享 driver
  prepareContinuable() { return Promise.resolve({}) }             // 不贡献种子
}
export function apply(ctx, config) {
  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName))  // 默认名 'spawn'
}
```

对照 fork 提供方：`inheritsParentContext = true`，start 时携带**父级已完成轮次**作为
seed——所以工具描述会按此切换措辞（见下节）。

## 模型侧入口：委派工具 `dsh-tool-subagent`

流程图第 ① 步的发起方——模型看到的静态工具，把工具参数映射成委派请求。

**工具参数**（模型写的只有两个 + 可选调度）：

```ts
parameters: {
  description: '3-5 词的委派任务简述（用作 label，也是 UI 显示名）',
  prompt:      '完整的自包含任务描述',
  run_in_background?: boolean,   // 可选调度请求
}
```

**部署配置**（工具行 config，模型不可见）：`provider`（路由到哪个提供方）、`toolName`
（默认 `subagent`，多实例须异名）、`backgroundMode`（`one-shot` 默认前台 /
`continuable` 默认后台）、`agentOptions` / `persona` / `toolFilter`（每个子级的默认约束）、
`maxDepth`（默认 **3**；`0` = 完全禁止委派；`'provider-managed'` = 预算归提供方）。

**工具描述随提供方形态切换**（`providerWording(inheritsParentContext)`）：

- spawn（`false`）→ 「委派**自包含**任务……它看不到本对话，prompt 必须包含它需要的一切」
- fork（`true`）→ 「委派给**继承本对话**的子代理（种入全部已完成轮次）……只需说明新增部分」

**三条执行路径**（`execute`）：

| 路径 | 触发 | 实现 | 返回 |
|---|---|---|---|
| 前台 | 默认（one-shot 模式） | `ctx.subagents.start()` → `settleForegroundRun`：等待 `run.result`，非 completed 停止原因**抛错**（携带诊断 + 部分输出——部分答案仍到达父级，但注册表把 throw 转成 `isError`），随后无条件 dispose | `{kind:'foreground', runId, output}` |
| 后台 one-shot | `run_in_background: true` | `ctx.jobs.start({kind:'subagent', ...})`——job 预检完成后才 spawn，任务持有自己的 AbortController；结果经 `settleStart` 映射 | `{kind:'background', jobId}`（`job_output` 收集 / `job_kill` 停止） |
| 后台 continuable | continuable 模式默认 | `ctx.subagents.startContinuable()`——**inbox 接受即兑现**，此调用既不等待也不收集结果 | `{kind:'continuable', subagentId}`（结算通知由 runtime 送达；`send_message` 开后续轮） |

**工具注册跟随提供方生命周期**：监听 `subagent/provider-added` / `-removed`——提供方
后到时工具才注册（拼错的提供方名会留在日志里可见），提供方离开时工具注销。挂载时
校验 `maxDepth` 数值上限必须有 `depthLimit` 能力（配置错误在挂载点响亮失败，不拖到
首次委派）。

`presentCall` 是 generic 卡：标题 = description——这正是 TUI 里子代理工具行的显示来源；
`isConcurrencySafe: true`（子级从不写父会话，唯一的父侧写入是同步可交换的插入）。

## 「兑现即发布」的具体实现：`start()`

服务 `start()` 的真实代码路径（bundle `lib/index.js`）：

```js
async start(name, request) {
  const provider = this.expectProvider(name)        // ① 按名查注册表，缺失响亮失败 NO_PROVIDER
  this.assertCapabilities(provider, request)        // ② 能力矩阵逐项校验
  assertSubagentMaxDepth(request.maxDepth)          // ③ 深度上限合法性
  if (request.outputSchema !== undefined) assertObjectJsonSchema(...)  // ④ schema 校验
  const descriptor = snapshotSubagentDescriptor({   // ⑤ descriptor 快照（见下节）
    mode: 'one-shot', provider: name, ...label })
  const resolved = { ...request, descriptor }
  // ⑥ 唯一的 await：提供方建立子 agent —— 兑现前失败 = 无运行、无事件、无资源泄漏
  return observeRun(this.emitLifecycle, name, request.parent, await provider.start(resolved))
}
```

- **⑥ 是「兑现即发布」的全部**：`provider.start()` 的 promise 兑现时子代理已真实存在，
  所有权即刻转移；拒绝时调用方手里没有任何东西需要 dispose，也不发任何运行事件
- `observeRun` 包装返回的 run：发布时 emit `subagent/start(info)`，监听 `run.result`
  结算后 emit `subagent/end(info)`——生命周期事件按**委派 parent 作用域分发**，
  parent 作用域的监听者只看到自己的委派

**能力矩阵**（②）的实现是五组 `{when, cap}` 对照表：请求携带 `agentOptions` 就要求
提供方声明 `agentOptions` 能力，`outputSchema`/`maxDepth`/`toolFilter`/`persona` 同理——
第一个缺失的能力即抛 `UNSUPPORTED_CAPABILITY`。这就是「请求了不具备的能力响亮失败、
不静默降级」。

## Descriptor：`subagent/descriptor` 事件的具体实现

descriptor 是「冷恢复的依据」原理的落地，实现要点：

- **版本化**：`SUBAGENT_DESCRIPTOR_VERSION = 3` 盖章进每条事件；`foldSubagentDescriptor`
  要求逐字匹配——版本不符返回 `undefined`（该 child 无法被当前运行时分类），而不是猜测
- **显式字段快照，而非 AgentOptions 对象**：快照只取声明过的字段
  （one-shot：`version/mode/provider/label`；continuable 额外 `agentProvider/agentModel/
  agentReasoningEffort/persona/toolFilter`）。原因写在源码注释里：一个无关的扩展字段
  不能仅仅因为「不是 JSON」就让冷恢复失败；新增组合输入必须是**刻意的版本变更**
- **刻意省略的字段**：`subagentDepth`（冷恢复信任持久化头部的 `delegationDepth` 单调下限）、
  `outputSchema` 与 `maxTokens`（它们属于单次 Activation 的结果契约/预算，不属于持久组合）
- **fold 语义**：子代理日志里**第一条** descriptor 是权威——建立提供方恰好追加一条，
  后续同类型事件不能改写已声明的组合
- **严格解析**：未知字段、错误类型一律抛错——持久化的日志必须与声明的 schema 完全一致

## 会话树的具体实现：`childSessionMeta` 与深度记账

「血缘」原理的落地是子会话创建元数据（`child-agent` 模块，one-shot 提供方与
continuation 管理器共用同一个家）：

```js
function childSessionMeta(parent, childDepth, isSeeded) {
  return {
    cwd: parentHeader.cwd,                        // 继承父的工作区
    agentPreset: 父的 LIVE scope chain 读出的 preset,  // 不是从 header 读！
    parentSession: parentHeader.id,               // ★ 血缘链的写入点
    isSeeded,                                     // 是否继承父日志前缀
    origin: 'subagent',                           // 粗粒度产品来源
    delegationDepth: childDepth,                  // 必须活过持久化的递归预算
  }
}
```

两个细节：

- **preset 从父的活作用域链读取而非 header**——父在空白期切换过 preset 时，它运行在
  新组合上而 header 还记着旧的；记录活值才能让子代理的历史可重建（否则冷读子代理会
  按部署默认重建出它从未有过的工具集）
- **深度记账**（`resolveChildDepth`）：`delegationDepthOf(parent) + 1`，持久化头部是
  **单调下限**——被恢复的父不能装作顶层重新委派；超过 `maxDepth` 抛 `SubagentDepthError`

**谁真正调用创建**：one-shot 路径由共享 driver `dsh-subagent-in-process-driver` 执行
（见下文专节），continuation 管理器走自己的创建/冷恢复分支：

```js
// continuation 管理器的创建分支（lib/index.js）
const handle = create === undefined
  ? await this.ownerCtx.agents.resume({ resumeSessionId, agentOptions, setup })  // 冷恢复路径
  : await this.ownerCtx.agents.create({ sessionId, meta, agentOptions, setup })  // 新建路径
```

子代理创建出来就是一个**普通 Agent**：自己的 turn/step 循环、自己的事件日志、注册进
同一个 `ctx.agents` registry——「子代理是完整 agent」原理的落地就是「没有特殊 agent，
只有多了一行 `parentSession` 元数据的普通会话」。

## 选项继承的具体实现

「子级继承父级路由」的原理落地为两步：

```js
// ① 父值解析：最新 requestHeader 拥有 provider/model/reasoningEffort
//    （请求时选择的结果），创建选项只是首次请求前的回退
function parentAgentOptionsForDelegation(parent) {
  const config = parent.session.requestHeader()?.config
  return config === undefined ? { ...parent.options }
    : { ...除路由外的创建选项, provider: config.provider, model: config.model, ... }
}

// ② 子选项解析：父值打底 → 请求覆盖 → 盖章子深度
function resolveChildAgentOptions(parent, requested, childDepth) {
  const resolved = { ...父的 provider/model/effort/maxTokens, ...requested, subagentDepth: childDepth }
  // 关键规则：改了路由（provider/model 变了）而没显式点名 effort
  // → 删掉继承的 effort，让新模型解析自己的默认值
  if ((resolved.provider !== 父provider || resolved.model !== 父model)
      && requested?.reasoningEffort === undefined) delete resolved.reasoningEffort
  return resolved
}
```

## 权限固定的具体实现

「权限启动即定死」的原理落地为三个协作函数：

1. **`captureDelegatedPolicyOverrides(parent)`**——委派瞬间**同步**捕获（必须在子级
   启动的第一个 await 之前调用：父后来的策略切换属于父的未来，不属于这个子级）。
   只捕获父会话的**显式沙箱覆盖**（绝不带部署默认或一次性授权），审批策略无论父
   是什么一律钉死 `'never'`
2. **`appendDelegatedPolicyOverrides(childSession, overrides)`**——把捕获的策略作为
   `source: 'delegation'` 事件追加进**子级自己的日志**（`sandbox/mode`、`approval/policy`），
   落在任何 fork 种子之后（新鲜策略赢陈旧种子）——子级的有效策略**仅凭自己的日志
   即可重建**
3. **`applyChildComposition(childCtx, parent, composition)`**——创建窗口内组装子级：
   先 join 父的 preset（否则子级看到空工具注册表），再注册固定的
   `subagent:delegation` 运行时上下文句（即第一部分引用的委派范围声明——作为
   runtime-context 贡献而非 system-prompt section，让部署的 system prompt 在父子间
   保持统一），最后叠加子级自己的 persona section 与 `tools.restrict(toolFilter)`

## 一次性 driver 的具体实现：`startInProcessRun`

spawn 与 fork 提供方共用的驱动（`dsh-subagent-in-process-driver`）——流程图第 ② 步
的 one-shot 完整代码路径：

```ts
export async function startInProcessRun(request, options): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()       // 发布前取消 = 无声失败
  const childDepth = resolveChildDepth(parent, request.maxDepth)
  const childId = SessionId(randomUUID())                       // ★ 子会话 id 在这里铸造
  const activationBoundary = seed?.length ?? 0                  // fork 种子边界（结果只读边界之后的事件）
  const inherited = captureDelegatedPolicyOverrides(parent)     // 首个 await 之前捕获策略

  const setup = (childCtx): void => {                           // 创建窗口内的组装
    appendDelegatedPolicyOverrides(childCtx.agent.session, inherited)
    applyChildComposition(childCtx, parent, { persona, toolFilter })
    if (request.outputSchema !== undefined) structured = attachStructuredRuntime(...)
    attachDescriptorAppend(childCtx, request.descriptor)        // descriptor 延迟追加（见下）
  }

  const handle = await parent.ctx.agents.create({               // ★ 真正的创建调用
    sessionId: childId,
    meta: childSessionMeta(parent, childDepth, activationBoundary),
    ...seed !== undefined ? { seed } : {},                      // fork 的种子
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(handle, signal, prompt, childId, activationBoundary, structured)
}
```

三个关键机制：

- **descriptor 的 turn 内追加**（`attachDescriptorAppend`）：挂一个 `agent/pre-step`
  钩子，在子级初始轮次的**第一个 enter 决策后、首次请求前**追加
  `subagent/descriptor`——「Providers append it turn-enclosed in the child's
  initial turn」的实现
- **驱动已发布的运行**（`drivePublishedRun`）：caller 的 signal abort →
  `child.cancel({kind:'parent'})`；结果通道 = `child.followup(user 角色的 prompt)` →
  `child.whenIdle()` → 读结果；dispose = `Promise.allSettled([handle.dispose(), result])`
  ——结果通道拥有运行故障，dispose 只报告释放失败
- **从事件读结果**（`readResult`）：只读**边界之后**的事件——
  `foldConsumedWork(own).end` 取最后一条 `turn/end`，`finalAssistantOutput(own)` 取
  规范输出选择（**部分答案在取消/截断后仍然存活**）

**词汇桥**：会话事件的 `turn/end` reason 到 seam 停止原因的映射（`toStopReason`）——
这张表连接了《会话事件词汇表》与本文档：

| TurnEndReason | SubagentStopReason | 说明 |
|---|---|---|
| `completed` | `completed` | 正常完成 |
| `max-tokens` | `max-tokens` | 撞输出上限 |
| `aborted` | `aborted` | 取消 |
| `blocked` | `refusal` | **pre-step 拒绝丢弃了已认领的提示词 = 任务被拒绝**，调用方不得读作已完成 |
| `error` / `interrupted` / 其他 | `error` | 无记账轮次的取消也归入这里——绝不虚报成功 |

另有两条覆盖规则：caller 取消且记录原因非 completed → 强制 `aborted`；要求结构化输出
但 completed 时没捕获到值 → 改判 `error`（取消则 `aborted`）。

## 子 Agent 创建的完整链路：`ctx.agents.create()` 内部

driver 调用的 `ctx.agents.create()` 往下是一条**三层委托 + 创建事务**流水线：

```
① subagent driver / continuation 管理器
      parent.ctx.agents.create({ sessionId, meta, seed?, agentOptions, signal, setup })
                        │
② AgentRegistry（core/agent）—— 只是转发
      Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
      （工厂由 agent-loop 在构造时注册：ctx.agents.setFactory(this)）
                        │
③ AgentLoop.createAgent（core/agent-loop）—— 真正的创建事务
      sessions.prepare(id, { seed, meta })   ← 会话预备（铸日志）
      → prepare()                             ← 未发布窗口组装
      → setup(childCtx)                       ← driver 的组装回调在这里跑
      → publish()                             ← 原子发布
```

**会话预备（`sessions.prepare`）**：认领会话 id、创建全新的事件日志——meta（cwd、
parentSession、origin、delegationDepth、agentPreset、isSeeded）写进会话头；fork 形态
的 seed 事件在这里种入。id 认领是串行化屏障，失败即弃。

**`prepare()`——未发布窗口的组装**（创建事务核心，按源码顺序）：

1. 前置校验：`assertAgentOptions` + fiber 活性 + caller signal 已中止则直接抛
2. **三源取消融合**：caller signal ∪ owner fiber 卸载 ∪ factory 拆除 → 一个
   `AbortController`，在任何资源存在之前注册——「scope 还在铸造时到达的卸载也能找到
   可用的 disposer 而不是泄漏」
3. **反向拆除预注册**：memoized 的 `dispose`（停机器 → 等 idle → 拆 scope → 离开两个
   registry → 释放簿记）注册进 factory 追踪和 owner effect——中途卸载全量回滚
4. 构造机器：`new ReactLoopAgent(loopCtx, id, options, session)`——子 agent 拥有
   **自己的 cordis scope**（setup 里注册的 persona / 工具裁剪 / 委派声明对父级和兄弟
   不可见）

**setup 在未发布状态下执行**：`await raceAbort(setup?.(prepared.agent.ctx), ...)` →
`setupCommit?.commit()` → `publish()`。setup 失败 → `prepared.dispose()` → 什么都没
发布——「兑现即发布」的下半句（拒绝时无运行可 dispose）。

**`publish()`——原子发布序列**：

```ts
detachSession = agent.ctx.sessions.enter(session)              // 进 registry（未公告，可拆除）
detachAgent   = loopCtx.agents.enter(agent, ownerCtx.agent)    // ★ 权威碰撞边界
agent.ctx.sessions.announce(session)                           // 公告会话
loopCtx.agents.announce(agent)                                 // 公告 agent → agent/created
emitAgentEvent(loopCtx, agent, 'agent/session-start', ...)
```

关键设计是 **enter / announce 两段式**：`enter` 是「插入但不公告」——权威碰撞边界
（并发 create/resume 可以都预备，但只有一个精确条目能发布），`owner` 记录运行时
所有权（区别于会话头的持久血缘）；`announce` 才对外可见并发事件——从这一刻起
`ctx.agents.get(childId)` 可解析、`subagent/start` 发出、TUI 面板行出现；每步之间
`assertLive()` 防止同步监听者触发的拆除后继续发布。

**交付**：返回 `AgentHandle { agent, dispose }`，所有权移交 driver——从此子 agent
就是一个跑标准 turn/step 循环的普通 Agent。一句话：**会话预备 → 未发布窗口 → 原子
发布，任何一步失败全量回滚，发布成功即所有权移交**。

## 结算的具体实现：`settleRun`

「结果回流」原理的落地（one-shot 背景 Task 路径）：

```js
async function settleRun(run) {
  outcome = runOutcome(await run.result)   // ① 等终态结果并映射
  await run.dispose()                      // ② 释放子资源（失败与①的失败合并上报）
  return outcome
}

function runOutcome(result) {
  switch (result.stopReason) {
    case 'completed': return { status: 'completed', output: 最终文本块拼接 }
    case 'aborted':   return 无诊断 ? { status: 'killed' }        // 本地取消
                                    : { status: 'failed', detail }  // 提供方诊断的远程中止
    case 'error': case 'max-tokens': case 'refusal':
                      return { status: 'failed', detail: `${stopReason}; diagnostic: ${...}` }
  }
}
```

停止原因到任务结果的映射有明确语义：**本地取消是 killed（预期内），带诊断的远程
中止与其他失败都是 failed 且不携带部分输出**。

## 结果回流父级的具体实现：`notifySettlement`

流程图第 ⑤ 步「父上下文追加结算通知」的完整实现（continuable 路径）：

**1) 无条件通知**——对每个调用方已拿到 id 的 child 一律通知：最需要通知的情形
（token 封顶、模型失败、被取消、被拆除）恰恰是子代理没机会自己汇报的情形。
两个例外：首次接受前就回滚的物化保持沉默（调用方已被告知 child 未建立）；
父级不在线不算错误——子级自己的 Session 仍是持久记录。

**2) 开头句按停止原因生成**（`settlementSummary`，五个变体 + 兜底）：

| stopReason | 文案 |
|---|---|
| `completed` | `Background subagent <id> finished and will do no further work unless you send it more.` |
| `aborted` | `... was stopped before it finished.` |
| `max-tokens` | `... ran out of room before it finished.` |
| `refusal` | `... declined the task.` |
| `error` | `... failed before it finished.` |
| 未知（合并可扩展） | `... ended abnormally (<reason>) before it finished.`——宁可报未完成也不静默算成功 |

**3) 组装 user 角色消息**：

```js
createUserMessage({
  content: [ { type: 'text', text: summary },
             ...(有收尾消息 ? [{ text: 'Its closing message:' }, ...terminal.output]
                            : [{ text: 'It left no closing message.' }]) ],
  source: { kind: 'subagent-settled', form: 'notice',   // 结算来源标记
            summary: boundContextSummary(summary), senderSessionId: activation.childId },
})
```

**4) 分发分支**：

- 父级自己的血缘已在收尾（teardown）→ `parent.inject(message)`——只落日志不唤醒
  （拆除不是开新轮次的理由）
- 否则 → 唤醒式投递：父级空闲则 `parent.followup(message)` 直接开启新轮次
- **永不阻塞拆除**；投递失败记日志后丢弃——为了重试一条通知而扣住子代理，会把
  它的整个祖先链永远钉在 waiting 状态

**5) 串行化保障**：`ChildLock` 对每个 child 的投递/释放/拆除操作做 promise 链
排队——同一 child 的结算序列严格有序。

> one-shot 路径的回流不走 notifySettlement：结果经 `settleRun` 映射为 Task outcome，
> 由委派工具作为工具结果返回给父级模型。

## Continuable 的具体实现：Activation 与 inbox

continuation 管理器（约千行的最大模块）的职责与关键设计：

- **一个 continuable child = 一个持久 Session + 至多一个进程内 Activation**。
  Activation 是「重建出的子 Agent 的一段驻留期」——它**不是**请求/结果/取消/Task
  边界：可以执行多个 FIFO 轮次，且它创建的后代还在跑时保持驻留
- **Agent inbox 是唯一的轮次队列**——管理器只拥有驻留权，Agent 循环拥有全部轮次
  排序与执行；任何 continuable 路径都不创建 Task 或中间结果包装
- **结算通知是管理器自己的活**（`notifySettlement`）：驻留结束权独占于管理器，所以
  告知父级也只能由它做——外部 `subagent/end` 监听者做不对（载荷里没有 parent 名、
  child handle 彼时已 dispose、唤醒父级结算观察者的 release 已经跑完）
- **冷恢复**：直接 child 无 Activation 时，从持久化会话重建（`agents.resume` 路径）——
  授权要求确切的在线 parent，但子选项只从持久 descriptor 重建（不恢复旧预算、不继承
  父当前预算，按恢复路由的默认值走）
- **所有权图与 child-first 释放**：`drainContinuableDescendants` 先关闭准入，同步停
  可见后代 Activation，再等已准入的物化完成、child-first 释放整棵森林；单个
  Activation 的拆除（`finishDisposal`）同样 child-first：先取消（`cancel({kind:'parent'})`）
  等 idle、释放后代、flush 最终状态、捕获终态，再 dispose handle 并通知结算
- **初始提示词的回传指引**（`continuableInitialPrompt`）：continuable 子级的首条
  提示词被追加一段固定文本——告知父代理 id，并要求完成前用
  `send_message({ agent_id: <parentId>, message: "<自包含结果>" })` 回传；明确说明
  「父级共享工作区但不会自动收到你的转录/工具输出/推理」，且发消息不结束自己的轮次。
  这就是「父级只收蒸馏结果」原理在 continuable 形态下的落地

## 多个子 Agent 的并行执行

三层设计——模型侧发起、调度器并发、运行时承载（运行时细节见下文「运行时基础」节）。

**第一层：模型在一条消息里发起多个委派**——委派工具声明并发安全：

```ts
// tool-subagent
isConcurrencySafe: () => true,   // 子级从不写父会话——唯一的父侧写入是同步可交换的插入
```

工具注册表（`core/tools`）按此分类每次调用：声明且返回 true → `{kind: 'parallel'}`；
未声明或 false → `{kind: 'exclusive'}`。工具的 prompt section 直接教模型「把独立的
委派放进同一条 assistant 消息」。

**第二层：step 内的工具调度器**（`agent-loop/tool-calls.ts`）——契约一句话：
「独占调用构成屏障，并行调用跑在有界滚动池里」：

```ts
// 滚动池：不断补位启动，直到达到上限
while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) { ... }
// 启动前重新分类：后来的调用若被重分类为 exclusive，等当前池排空，留给下一个屏障
```

同一 step 里多个并发安全的 `subagent` 调用滚动池并发启动（上限 `maxParallelToolCalls`，
默认 10），结果按提交顺序回传；混入独占工具则等池排空后单独跑（屏障），防止竞态。

**第三层：并行的物理承载——单进程异步并发**：

- 每个子 agent 是独立的 `ReactLoopAgent`：自己的会话、自己的 inbox（唯一轮次队列）、
  自己的循环——彼此没有共享可变状态，天然可交错
- 子代理的工作是 I/O 密集（等 LLM API、读文件、等子进程），事件循环交错这些等待就是
  完美的并发（原理见下文「运行时基础」节）
- 局限：CPU 密集工作在同进程内不会真并行；需要真·进程并行时用进程外提供方
  （ACP/Codex/Claude Code）

**并发治理**：所有权图跟踪每个 Activation 的后代；`ChildLock` 只对同一个 child 的
投递/释放/拆除做 promise 链串行化——**不同 child 之间完全独立并发**。

两处呼应：todo 工具的 `allowParallelInProgress: true` 就是为并发子代理场景准备的
（允许多个 todo 同时 `in_progress`）；TUI 面板给每个并发子代理一行独立展示。

## 运行时基础：协作式异步并发与 I/O 多路复用

上节「单进程异步并发」承载的物理基础。关键词：**单线程、非阻塞、协作式**。

### Node.js 事件循环上的协作式异步并发

**单线程 + 事件循环**：JavaScript 只在一个线程上执行；这个线程不停地
「取任务 → 执行到结束 → 发起的 I/O 交给底层 → 完成的回调进队列 → 取下一个任务」。
执行 JS 的只有一个线程，但**「等待」不占用这个线程**。

**协作式 vs 抢占式**（与多线程的本质区别）：

| | 多线程（抢占式） | 事件循环（协作式） |
|---|---|---|
| 切换时机 | 操作系统随时打断你 | **只在 `await`/回调处主动让出** |
| 一段代码执行中 | 可能被任意打断 | **绝不被打断，一口气跑完** |
| 共享数据 | 需要锁，有竞态 | 两个 await 之间天然原子 |

「协作」= 切换点是你自己写的：每个 `await` 就是一次主动让出。并发不是「同时执行
代码」，而是「**同时处于等待，谁的事办好了谁先跑**」——多个子代理各自 `await`
自己的 LLM 响应，等待期间线程空闲，先返回的先恢复。

**为什么子代理场景契合**：工作 I/O 密集（等 API/文件/子进程），十个子代理并发线程
几乎无压力；协作式 = 免费的隔离（两个 await 之间不被打断，无需锁——continuation
管理器因此只需 per-child 的 promise 链而非互斥锁）。

**局限**：CPU 密集会卡死所有人（一个自私的同步任务饿死整个进程）；任意瞬间只有
一段 JS 在跑，不是真并行——真·并行计算需要 worker 线程或多进程（进程外提供方的
另一个存在理由）。

### 底层原理：从 select 到 epoll

事件循环的底层分四层：

**① JS 与微任务（V8）**——Promise 回调是微任务：每个宏任务执行完，V8 立刻清空整个
微任务队列再进入下一轮；这是 `await` 恢复执行的落点。

**② 事件循环本体（libuv）**——不是 V8 的，是 C 库 libuv 实现的六阶段循环：

```
   ┌───────────────────────────┐
┌─►│ timers        （到期定时器回调）
│  │ pending callbacks（上轮遗留的系统回调）
│  │ idle / prepare  （内部用）
│  │ poll ★        （阻塞等 I/O 就绪 —— 系统调用在这里！）
│  │ check         （setImmediate 回调）
│  │ close callbacks
└──┴───────────────────────────┘
```

`poll` 阶段的超时按最近的定时器精确计算——「既不漏定时器，又能睡到最晚」。

**③ I/O 多路复用**——`poll` 阶段按操作系统分派：

| 平台 | 机制 | 模型 |
|---|---|---|
| **Linux** | **`epoll`**（`epoll_create` / `epoll_ctl` / `epoll_wait`） | reactor（就绪通知） |
| macOS / BSD | **`kqueue`** | reactor |
| Windows | **IOCP** | **proactor（完成通知）**——内核直接完成读操作并交付数据 |
| 古老系统 | `poll` / `select`（仅兜底） | reactor |

`select` 是这一机制的史前形态，被淘汰的原因：**O(n) 扫描**（每次调用把全量 fd 集合
拷进内核线性扫描；epoll 在内核维护注册表，`epoll_wait` 只返回就绪的那几个）、
**1024 fd 上限**、每次重传全量集合。epoll 把等待成本从「用户态轮询」变成
「内核事件驱动」：网卡中断 → 就绪链表 → `epoll_wait` 醒来直接返回。

**④ 线程池**——内核无法异步的部分由 libuv 线程池（默认 4 线程）兜底：普通文件读写
（Linux 内核层面文件永远「就绪」，慢的是磁盘）、DNS 解析走线程池；网络 socket 走
真·epoll 不占线程池；子进程退出经信号 fd 挂进 epoll。

**串起来——一个子代理等 LLM 响应的完整底层路径**：

```
agent: await fetch(LLM API)
  → socket 注册进 epoll 实例（epoll_ctl）
  → libuv poll 阶段: epoll_wait(阻塞, 超时=最近定时器)
  → 网卡收到响应字节 → 内核中断 → 就绪链表加入该 socket
  → epoll_wait 返回 → libuv 触发可读回调 → HTTP 解析 → resolve Promise
  → V8 清空微任务队列 → await 之后的代码恢复执行 → agent loop 推进
```

十个子代理并发 = 十个 socket 挂在**同一个 epoll 实例**里，一次 `epoll_wait` 同时
监视全部——这就是单线程能「同时等所有人」的物理基础。

## 服务操作面与生命周期事件（汇总）

| 方法 | 职责 |
|---|---|
| `start(name, request)` | 具名提供方上建立已发布的 one-shot 运行（见上） |
| `startContinuable(spec)` | 建立持久 child 并投递初始提示词；inbox 接受即兑现 |
| `sendMessage(sender, targetId, content)` | 相邻 Steer：在线目标最近 step 边界接收；空闲目标开新轮；缺席直接 child 冷恢复 |
| `interrupt(targetId, authority)` | 中断在线 child 当前轮；未认领 inbox 与已发布后代保留 |
| `listChildren` / `listDescendants` | 发现：直读会话存储 + 投影缓存（`subagent` 投影是唯一的模式/标签分类器），不加载 agent |
| `drainContinuableChildren` / `Descendants` | 释放选定驻留 child / 整棵后代森林（child-first） |
| `remoteExportList` / `prompt` / `interruptByParent` | 浏览器控制面（Typert remote 面） |

Cordis 事件：`subagent/provider-added` / `-removed`、`subagent/start(info)` / `end(info)`
（载荷：runId、provider、SessionId、local、stopReason、lastAssistantMessage?）。

## 模型体验（两条注入）

**结算通知**（parent 收到的 user 角色消息，runtime 生成）：

> `Background subagent <child-id> finished and will do no further work unless you send it more.`
> （或被停止/耗尽额度/拒绝任务/失败时的对应句子）
> `Its closing message:` + 子级的最终 assistant 内容（无内容则 `It left no closing message.`）

对父级请求 append-only，位于可复用前缀之后（KV cache 友好）。

**委派范围声明**——即上文 `applyChildComposition` 注册的 `subagent:delegation` 固定句。

## 已知限制（节选）

- ACP 子级仍为一次性，且无法通过追踪枚举
- child → parent 投递要求直接 parent 在线——无持久 parent mailbox
- 取消收敛期间存在唤醒缺口
- 驻留仅限进程内——Activation inbox 与所有权图不跨进程协调
- 已接受但未落日志的消息崩溃后不回放
- 生命周期事件目前只供观察，延续/决策接口待具体消费方

# 第三部分：dsh-terminal 的 TUI 消费实现

一个消费方如何在不依赖 subagent 包的情况下展示子代理——每条机制对应到具体代码。

## 事件路由的具体实现（`src/index.ts`）

`session/event` 是全局事件总线，所有会话的事件都流经这里。driver 的归属判定：

```ts
ctx.on('session/event', (session, event) => {
  if (session.header.id !== agent.session.id) {
    // 会话头部的 parentSession 指向本会话 → 直接子代理
    if (session.header.parentSession === agent.session.id) foldChildEvent(session.header.id, event)
    return   // 更深的后代留在它们自己的会话里，不进面板
  }
  trackUsage(event)
  adopt(foldEvent(state, event, deps).state, event.type !== 'assistant/chunk')
})
```

`session.header.parentSession` 就是第二部分 `childSessionMeta` 写入的那个字段——
消费端与写入端在同一个会话树约定上会合，中间不需要任何 subagent 包的类型面。

## 子代理条目的具体折叠：`foldChildEvent`

```ts
const foldChildEvent = (childId, event) => {
  let entry = children.get(childId)
  if (entry === undefined) {
    entry = { label: `subagent ${childId.slice(0, 8)}`,   // descriptor 到达前的占位标签
              startedAt: event.time, inputTokens: 0,
              state: createFrameState(),                   // ★ 独立 fold 状态
              fading: false, fadeAt: undefined }
    children.set(childId, entry)
  }
  // descriptor 的结构化读取——不 import 包，按事件的形状读字段
  if ((event as { type: string }).type === 'subagent/descriptor') {
    const label = (event.data as { label?: unknown }).label
    if (typeof label === 'string' && label !== '') entry.label = label
  }
  // token 累计：每条 assistant/message 的 input + cache-read
  if (event.type === 'assistant/message' && event.data.usage !== undefined)
    entry.inputTokens += event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0)
  // 与主流完全同一个纯 fold——子代理的流式帧/工具卡/plan 面板天然成立
  entry.state = foldEvent(entry.state, event, deps).state
  scheduleRender(event.type !== 'assistant/chunk')   // 流式 chunk 80ms 合批，其余立即
}
```

三个实现要点：

- **结构化读取**正是「观察与执行分离」的落地：UI 只需要事件的形状，descriptor 的
  版本校验/严格解析留给上游
- **fold 复用**：`foldEvent` 对任何会话的事件流都成立（事件溯源的会话长得一样），
  所以子代理详情视图零专门渲染代码地支持它自己的流式帧、工具卡、todolist 面板
- **占位标签策略**：`subagent <id前8位>` 保证 descriptor 迟到时面板行也有可读身份

## 面板行的具体计算

面板切片**每次渲染时计算**而非存进基础视图——所有渲染路径自动拾取 roster 变化：

```ts
function rosterRows(): SubagentRow[] {
  return [...children.entries()].map(([childId, entry]) => ({
    childId, label: entry.label,
    ...childActivity(entry.state) === undefined ? {} : { activity },  // 最新工具卡标题
    startedAt: entry.startedAt, inputTokens: entry.inputTokens, fading: entry.fading,
  }))
}
function withPanel(base: RenderView): RenderView {   // 每个渲染出口都过这里
  const rows = rosterRows()
  if (rows.length > 0) { next.subagents = rows; ... }
  if (openChild !== undefined) next.openSubagent = { childId, label, state: 该子的 FrameState }
  return next
}
```

## 键盘导航的具体实现

面板焦点是一个整数游标 `panelSelected`（0 = main 行，1..n = 子代理行）+ `openChild`：

| handler | 行为 |
|---|---|
| `onPanelOpen`（`↓`） | `panelSelected = 0`——焦点从输入框进面板 |
| `onPanelMove(delta)` | `Math.min(children.size, Math.max(0, panelSelected + delta))`——含 main 行的夹取 |
| `onPanelEnter` | 选中 0 → 清游标回输入框；选中 k → `openChild = 第 k 个子 id`，开详情视图 |
| `onPanelBack`（Esc） | 详情开着 → 关详情；否则 → 焦点回输入框 |

所有 handler 首行 `if (exiting) return`——退出流程启动后输入一律忽略（防止拆卸期间
对正在 dispose 的 agent 排队工作）。

## 焦点模式与视图替换（`src/renderer.tsx`）

```ts
const focusMode = opened !== undefined ? 'child'
  : view?.subagentSelected !== undefined ? 'panel' : 'input'
```

- **InputBar 在所有焦点模式下保持挂载**——它独占唯一的 stdin 监听器；child 模式下它
  渲染为空、只把 Esc 路由回输入焦点（卸载重挂会丢监听器）
- **主流 scrollback 保持挂载**：`<Static>` 的输出已进终端滚动缓冲，child 视图只替换
  它下方的活动区——返回时主流不会重新发射
- `ChildView`：分隔线 + `● subagent: <label> (Esc 返回)` 头 + 子代理自己的 plan 面板
  （若有）+ 完整帧流的只读转录

## 淡出生命周期的具体实现

每秒心跳 tick（`SUBAGENT_PANEL_TICK_MS = 1000`）里的两段逻辑：

```ts
for (const [childId, entry] of children) {
  // 结算检测：agent 离开 registry（run 结算）→ 开始 5s 淡出倒计时
  if (!entry.fading && entry.state.frames.length > 0
      && agents.get(SessionId(childId)) === undefined) {
    entry.fading = true
    entry.fadeAt = now + SUBAGENT_FADE_MS          // 5_000
  }
  // 到期移除（正打开详情时不移除——用户还在看）
  if (entry.fading && entry.fadeAt !== undefined && now >= entry.fadeAt && openChild !== childId)
    children.delete(childId)
}
```

设计取舍：上游的 `subagent/end` cordis 事件是另一条结算信号路径，但 TUI 用
**registry 观察**实现同等效果——后者不依赖任何 subagent 包的类型面，与零 import
原则一致；`frames.length > 0` 守卫防止从未产出内容的幽灵行闪现淡出。

## 相关常量一览

| 常量 | 值 | 用途 |
|---|---|---|
| `SUBAGENT_PANEL_TICK_MS` | 1 000 | 心跳：耗时刷新、淡出检查（也驱动 `✢ Running…` 秒数） |
| `SUBAGENT_FADE_MS` | 5 000 | 结算后的淡出倒计时 |
| `STREAM_RENDER_INTERVAL_MS` | 80 | 流式 chunk 的渲染合批窗口 |


# 一句话总结

**subagent 的基本原理 = 把工作委派给一棵会话树上的独立 agent：子级烧自己的上下文、
落自己的事件日志，父级只收蒸馏结果；one-shot 外包一单活，continuable 雇一个可反复
对话的长期助手；「兑现即发布、严格相邻、发布即边界」是实现的不变式骨架——每条原理
在实现里都有唯一的家：血缘在 `childSessionMeta`，权限固定在策略捕获三件套，冷恢复
在版本化 descriptor，结算回流在管理器独占的 `notifySettlement`；消费方（如本 TUI）
只需会话树的血缘与事件流即可完整观察——观察与执行天然分离。**
