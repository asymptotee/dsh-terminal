# 压缩系统：原理与机制

> 基于 deepseek-harness 的子系统文档（`docs/subsystems/compaction.zh.md`）与
> `packages/compaction/` 四包 README 整理。姊妹篇：《记忆系统》讲压缩在记忆层次中的
> 位置，《会话事件词汇表》讲事件模型，《Subagent 基本原理与实现》讲另一种上下文
> 管理策略（子代理隔离）。

# 第一部分：基础

## 1.1 压缩是什么

模型上下文窗口有界且昂贵——对话推进、工具结果堆积会让窗口逼近上限。**压缩
（compaction）是窗口压力的泄洪闸**：把较早的历史范围折叠成一段结构化摘要检查点，
替换掉原始内容，腾出窗口空间继续工作。

三条设计原则贯穿整个系统：

1. **释放窗口，不丢记忆**——被遮蔽的事件完整保留在持久日志里（见 7.1）
2. **崩溃安全**——事务以括号事件括住，中途崩溃表现为可检测的遗留锁而非虚假完成
3. **便宜的先用**——能用无模型剪枝解决就不花摘要的模型调用成本

## 1.2 能力 seam：三件套 + 可选前置

与 bash 同构的能力 seam 架构，**不在 agent loop 主干**（可选能力）：

| 角色 | 包 | ctx key |
|---|---|---|
| Service Definition | `dsh-compaction` | `ctx.compaction` |
| Provider（后端） | `dsh-compaction-basic`（token 压力 + 摘要） | 注册 `ctx.compaction` |
| Consumer | `dsh-command-compact`（`/compact` 用户命令） | 注册到 `ctx.commands` |
| 可选前置 | `dsh-compaction-tool-result-pruner`（无模型剪枝） | `ctx.toolResultPruner` |

与 bash seam 的区别：该接口必然依赖 `dsh-session` 与 `dsh-llm`——动词作用于 agent
所有的 Session，持久摘要事件使用 ContentBlock 词汇。基于 tokenizer 或模板的后端是
实现同一接口的兄弟包（唯一子类钩子是受保护的 `summarize()`）。

## 1.3 服务操作面

`CompactionEngine` 的四个操作：

| 方法 | 用途 |
|---|---|
| `compactIfNeeded(agent, trigger, signal)` | 自动策略：`pressure`（常规压力）或 `context-overflow`（提供方确认溢出，可更激进） |
| `compactNow(agent, signal, sourceCommandId?)` | 空闲会话的显式缩减——即使未达压力；作为轮次之间的 agent maintenance 运行，无有效范围时返回 null 且不写入 |
| `compactRegion(start, end, agent, signal?)` | 显式范围（两端均含、按 surface 位置）的强制压缩 |
| `toolPairingBalancedBefore/After(session, seq)` | 边界 helper：检查 seq 前后的工具调用/结果配对平衡 |

手动路径的预期失败分类：`busy`（活动锁）/ `cancelled` / `changed`（范围变更）/
`summary`（摘要失败）/ `commit`（部分变更后失败）/ `persistence`（标记已闭合但
flush 失败）。

# 第二部分：事件词汇

## 2.1 三个日志事件（log-only）

压缩通过声明合并为 SessionEventMap 扩展三种事件，**三者都只写日志、绝不进
surface**——只有产生消息的事件才到达模型：

| 事件 | 载荷要点 | 作用 |
|---|---|---|
| `compaction/start` | `{turn}` | 获取锁——数字标识尚未结束的自动轮次，`null` 标识独立手动尝试 |
| `compaction/summary` | `{summary, rawOutput?, llmStreamCall?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage?}` | 安全摘要投影 + 被遮蔽边界对/seq/token 估算 + 调用 envelope；写入日志后该一次性请求可由「日志 + 代码」重建 |
| `compaction/end` | `{turn, error?}` | 释放锁；`error` 记录失败尝试 |

## 2.2 锁语义：崩溃安全

锁括住**整个**操作：先追加 start，然后摘要生成、写入 summary 记录与替换消息，
最后才追加 end。**最后释放锁意味着操作中途崩溃会表现为可检测的遗留锁**（有 start
而无匹配 end），而非一个虚假声称压缩已完成的 end。

细节：

- 标记表示锁的时间点，不是排他容器——摘要等待期间，不相关的空闲注入可以出现在
  start 与 end 之间
- 活动的未匹配 start 阻塞所有入口点（报 `busy`）
- 较新 `session/end-seed` 之前的未匹配 start 是先前生命周期留下的陈旧证据，被忽略

## 2.3 唯一的 surface 变更

摘要本身承载在一条带 `surfaceOp: { op: 'replace', start, end }` 的 `user/message`
上——这是摘要压缩执行的唯一 surface 变更。成功结果（`CompactionResult`）返回：
三个事件的 seq、摘要内容块、被遮蔽的范围与 seq 集合、估算 token 数。注意
shadowedRange 是 **surface 位置跨度**而非数值区间——替换可能让可见 seq 非单调
（`start` 可以大于 `end`），权威的遮蔽集合是 `shadowedSeqs`。

# 第三部分：触发与执行流程

## 3.1 三种触发

| 触发 | 入口 | 时机与语义 |
|---|---|---|
| **pressure**（自动） | 串行 `agent/pre-step` listener | 派生请求前检查压力；使用最新持久路由请求的容量 |
| **context-overflow**（恢复） | `agent/request-error` | 提供方已确认溢出——绕过常规压力与保留策略，执行剪枝后尝试一次最大平衡头部缩减 |
| **手动** | `/compact` → `compactNow` | 空闲会话；预留空闲接纳、使用 `turn: null` 标记对，允许所选 span 之外追加仅追加上下文 |

压力压缩在串行 pre-step 中运行，先于请求推导——压缩结果直接影响下一次请求的内容。

## 3.2 执行流程（compaction-basic 的完整策略）

```
① 测量：ctx.tokenMeter 在同一已消费日志 revision 上计量最新规范化
   envelope + 当前表层——含实际系统提示词、工具、路由、assistant 完成、
   工具结果、缓冲上下文与 steering
② 阈值判断：floor(路由上下文窗口 × thresholdRatio)，默认 0.8
③ 可选剪枝（无模型）：toolResultPruner 改写超大工具结果——
   确定性的头/中/尾保留，按 Unicode code point 切分（不拆代理对）
   → 重新测量 → 若压力已回安全区则【跳过摘要】
④ 选范围：压缩最旧的完整表层单元，保留近期尾部
   （retainRatio 默认 0.16 或 retainTokens 绝对预算）；
   切分点调整到工具调用/结果配对平衡的位置——
   配对必须保住，但轮次边界不保护失控轮次内的旧步骤
⑤ 摘要：一次性 ctx.llm.stream() 调用——
   逐字回放会话自己的系统提示、工具 schema、被遮蔽区域消息（含图片引用），
   把压缩指令作为最后一条 user 消息追加 → 复用提供方热前缀 KV Cache
⑥ 收敛：拒绝不能缩小源内容的摘要；按 compactionRetries 重试头部检查点压缩，
   仍无法回到阈值以下则抛出异常
⑦ 框定：替换 user 消息用 <compacted-summary> 标签 + 检查点前导（见 5.1）
```

## 3.3 摘要输出的安全处理

只有返回的**文本**进入检查点：

- **推理（reasoning）与工具调用被排除**——防止泄露私有推理、防止产生遗留调用
- 图片输出以 `UNSUPPORTED_CONTENT` 失败，而不是静默消失
- 摘要调用把 `GenerateOptions.purpose` 设为 `compaction`（适配器可转发归因标记），
  但不触碰模型可见的请求体

## 3.4 无模型剪枝的产出

可选 pruner 报告每次持久内容替换（`PrunedEntry`：originalSeq / replacementSeq /
callId / charsBefore / charsAfter）与聚合节省（`PruneResult`）。每次替换保留完整
事件数据（只改 content）、引用被遮蔽节点以便重放恢复，并紧接一条
`compaction/prune` 影子计价事件——纯消费者无需逐节点状态即可减掉它。低于压力的
步骤检查**绝不剪枝**。

# 第四部分：摘要提示词

## 4.1 固定 8 节结构

摘要模型收到的指令要求输出固定 Markdown 结构——**每节必留、按序、空节写
"(none)"、用简洁条目而非散文**：

```
## Primary Request and Intent      用户的原始与演化目标（措辞要紧处逐字引用）
## Key Technical Concepts          技术、框架、模式、约定
## Files and Code                  确切路径：为何重要、关键变更或片段
## Errors and Fixes                错误：如何解决 + 相关用户反馈
## Pending Jobs                    明确要求但未完成的工作
## Current Work                    检查点时刻正在进行什么
## Next Step                       唯一下一步（与最近请求直接对齐）或 "(none)"
## Critical Context                决策及理由、约束、用户偏好、开放问题、继续所需数据
```

## 4.2 规则

- 逐字保留：文件路径、命令、错误字符串、标识符、数值、函数签名、语法片段
- 忠实记录用户反馈与显式指令，**尤其是纠正**
- **不许提及这次摘要请求或上下文被压缩过**
- 只输出检查点文本——不调工具、不做其他动作
- 已有 `<compacted-summary>` 视为**先前检查点**：不逐字复制——保留仍为真的事实、
  丢弃过时的、把新信息合并进同一结构的单一整合摘要（增量收敛）

# 第五部分：模型体验与代价

## 5.1 会话模型看到什么

替换发生后，下一个请求收到检查点前导 + 空行 + 摘要块：

> *This is an automatically generated checkpoint condensing an earlier span of the
> conversation to free up context. Treat the captured context as established
> background and build on it without restating it. Continue the task directly from
> the messages that follow, without acknowledging this checkpoint.*
>
> `<compacted-summary>` …根据数据生成的摘要… `</compacted-summary>`

检查点替换已选的较早范围，后面跟随逐字保留的近期单元。摘要保留到后续压缩将其替换
（合并进新检查点）。

## 5.2 KV cache 的诚实记账

**它是替换，而非仅追加**：每个检查点使从第一个被替换历史 token 起的复用失效；
该范围之前未更改的请求前缀仍可复用。

摘要器调用本身的缓存策略：回放的系统提示词、工具与被遮蔽区域消息与会话最后一个
已路由请求**逐字匹配**——提供方热前缀 cache 可复用至尾随指令之前，只有指令与摘要
输出未缓存。把摘要器路由到不同提供方/模型、或压缩非头部范围，都会放弃这份复用。

## 5.3 摘要模型看到什么

逐字回放的会话（与上次已路由请求相同的系统提示词、工具 schema、被遮蔽区域消息）+
最终一条压缩指令。**会话模型绝不会看到这个私有请求或其推理**——只有返回文本被存储。
这是一次独立模型调用：输入 = 回放前缀 + 固定指令，输出受 `maxTokens` 限制，收敛
重试可能多次支付该成本。

# 第六部分：配置与失败处理

## 6.1 配置（`BasicCompactionConfig`，全部可选）

| Key | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 在 `floor(路由窗口 × ratio)` 处压缩 |
| `retainRatio` | `0.16` | 逐字保留的近期表层预算（窗口比例）；与 `retainTokens` 互斥 |
| `retainTokens` | — | 保留的绝对预算；必须低于已解析阈值 |
| `summarizationProvider` / `summarizationModel` | `''` | 成对设置；空对回退到最新已记录请求目标，再回退 agent 目标 |
| `maxTokens` | `8192` | 摘要调用的生成上限（可含推理 token） |
| `compactionRetries` | `1` | 压力仍高于阈值时的额外尝试次数 |
| `maxOverflowRetries` | `1` | 溢出恢复的最大重试次数；`0` 禁用恢复 |
| `modelPolicies` | `[]` | 精确 `{provider, model, ...partialPolicy}` 覆盖（匹配不依赖 listModels） |
| `auto` | `true` | 注册步骤边界压力与溢出恢复 listener；`false` 则仅手动 |

顶层策略字段是每个已路由模型的默认值；`modelPolicies` 对精确提供方/模型对应用部分
覆盖。配置校验响亮失败：无法识别的键、重复目标、互斥保留形式、`retainRatio` 不低于
`thresholdRatio` 都会使插件加载失败。

## 6.2 失败处理

- **活动的未匹配 start = 持久锁** → 新请求报 `busy`；陈旧标记（较新 seed 之前）被忽略
- 摘要与 span 变更失败以错误闭合、**会话表层保持不变**，但尝试仍留在日志里
- 闭合失败会有意留下阻塞性的未匹配标记（宁可 busy 也不虚报完成）
- 压力检查中的运行故障发出警告并继续；只有此前没有替换推进表层时，溢出恢复失败才
  保留原始提供方错误
- 取消独立于失败分类，完成清理与持久化后抛出原始 abort 原因——仍有最终决定权
- 摘要失败保留最新持久表层：自动路径记录警告并携带完整超预算历史继续

## 6.3 已知限制

- **计量准确度取决于固定启发式**：可复用提供方用量缺失时回退到字符数 + 结构开销
- **溢出分类由适配器维护**：提供方措辞可能改变；DeepSeek 适配器把可识别的上下文
  限制失败规范化为 `CONTEXT_WINDOW_EXCEEDED`
- **表层压缩无能为力处**：系统/工具/前缀溢出、不可分的非工具单元、剪枝后仍超窗的
  工具单元；可选 pruner 只修复工具对内的文本型结果主体
- **`compactRegion` 要求未结束轮次**：完全关闭的会话上手动调用抛「no open turn」
- 一个过大的保留单元或请求 envelope 无法通过表层压缩修复

# 第七部分：与记忆系统的关系

## 7.1 释放窗口，不丢记忆

- 被遮蔽的事件**完整保留在持久日志**里——`shadowedSeqs` 精确记录哪些节点被遮蔽；
  压缩只释放上下文窗口空间，长期记忆毫发无损，重放日志仍可完整重建
- **检查点是增量的**：后续自动周期把先前检查点合并进新摘要（保留仍真事实、丢弃
  过时、单一整合）——不是叠加副本
- 在《记忆系统》的层次模型里，压缩是短期记忆（窗口）的管理机制：它改变窗口里
  「看到什么」，从不改变日志里「发生过什么」

## 7.2 与其他上下文管理策略的分工

| 策略 | 手段 | 代价 |
|---|---|---|
| 压缩 | 摘要替换较早历史 | 一次摘要调用 + 缓存部分失效 + 细节损失 |
| 子代理隔离（subagent.md 1.1） | 子级烧自己的窗口，只回流蒸馏结果 | 委派开销；父级从一开始就不承担中间过程 |
| 无模型剪枝 | 确定性裁剪超大工具结果 | 零模型成本；只作用于工具结果 |

三者互补：隔离是「事前避免污染」，剪枝是「便宜的局部瘦身」，压缩是「最后的泄洪」。

# 一句话总结

**压缩系统 = 「测量（tokenMeter）→ 阈值（0.8）→ 无模型剪枝优先 → 选范围（保近期
尾部、工具配对平衡）→ 复用热前缀的摘要调用 → <compacted-summary> 检查点替换」的
事务性流水线；括号事件保证崩溃安全、增量检查点保证收敛、shadowedSeqs 保证底层
日志永不丢失——它管理的是窗口里「看到什么」，从不触碰日志里「发生过什么」。**
