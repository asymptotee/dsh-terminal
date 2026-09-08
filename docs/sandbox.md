# 沙箱机制：原理与实践

> 基于 deepseek-harness monorepo 的 sandbox 家族源码（`packages/sandbox/` 三包的
> README 与 src）、Claude Code 源码（`src/utils/sandbox/`）与
> dsh-terminal 的消费实现整理。姊妹篇：《会话事件词汇表》《Subagent 基本原理与实现》。

# 第一部分：基础原理

## 1.1 沙箱是什么

「沙箱」（sandbox）是一个**受限的执行环境**——名字来自儿童玩沙的沙坑：孩子在里面
怎么折腾都行，但沙子出不了坑。

把一个程序放进「透明的笼子」里运行：

- **里面**：程序正常执行，自己感觉不到限制
- **笼壁上**：操作系统内核强制划定的边界——哪些目录可写、哪些只读、哪些进程不可见
- **外面**：宿主系统的其余部分完全不受影响

关键区别：沙箱不是「程序自觉不越界」，而是**内核强制它越不了界**——就算程序想干坏事
（或被注入的恶意指令驱使），系统调用会在内核层被直接拒绝。

AI agent 特别需要它：模型发起的 bash 命令是**模型生成的命令**——可能被提示词注入、
可能犯错。沙箱就是那道保险：

```
模型: bash("rm -rf ~/important_data")
  → 沙箱边界（内核强制）：~/important_data 不在可写工作区
  → 命令被拒绝 ❌ —— 数据安然无恙
```

**三档模式**（dsh 的划分，仅管文件操作）：

| 模式 | 能做什么 | 直觉类比 |
|---|---|---|
| `read-only` | 只能读，任何写入被拒 | 博物馆——看可以，摸不行 |
| `workspace-write` | 工作区内可读写，工作区外只读 | 自己的办公室——里面随便布置，走廊不能动 |
| `danger-full-access` | 不受文件限制 | 没有沙箱（名字直白地告诉你这很危险） |

**两条设计底线**（dsh 特别强调）：

1. **故障关闭（fail-closed）**：笼子造不出来时**拒绝运行命令**，绝不静默裸奔
2. **诚实报告完整度**：机制只能部分约束时如实报 `partial`，不夸大成 `full`

## 1.2 bubblewrap 是什么

**bubblewrap（命令 `bwrap`）是 Linux 上的无特权沙箱工具**——把任意一条命令关进内核
命名空间构成的「气泡」里执行。名字来自气泡垫：把东西包在一层保护性气泡里。

**出身**：诞生于 Flatpak 项目（Linux 桌面应用的沙箱化打包系统），后独立成项目。
使用者包括 Flatpak、浏览器沙箱设施，以及 AI agent 系统（dsh 与 Claude Code 的
Linux 后端都选它）。

**核心卖点——无特权（unprivileged）**：传统隔离手段（chroot、容器）通常需要 root，
bwrap 不需要——靠 Linux 的**用户命名空间（user namespaces）**：

- 进程创建用户命名空间，把自己映射成「root」——但这个权力**只在命名空间内部有效**，
  对宿主系统它依然是普通用户
- 有了这个「假 root」，就能进一步创建 mount/PID/network 等命名空间、挂载文件系统
  ——这些操作原本需要真 root

**工作方式**——给命令拼一个定制的文件系统视图：

```sh
bwrap --ro-bind / / --dev /dev --proc /proc echo ok
      └────┬────┘ └────┬────┘ └────┬────┘ └──┬──┘
           │           │           │         └─ 要执行的命令
           │           │           └─ 全新 /proc（私有进程视图）
           │           └─ 全新 /dev（不碰宿主设备节点）
           └─ 宿主根只读绑定挂载到新环境的 /
```

常用参数：`--ro-bind`（只读挂载）、`--bind`（可写挂载）、`--tmpfs`（临时目录）、
`--unshare-net`（独立网络栈）、`--die-with-parent`（父进程死则连坐）。

**与 Docker 的区别**：

| | bubblewrap | Docker |
|---|---|---|
| 定位 | 沙箱化**一条命令** | 运行**一套环境** |
| 形态 | 单个命令行工具，无守护进程 | daemon + 镜像 + 编排 |
| 文件系统 | 现场从宿主拼凑（bind mount） | 独立镜像分层 |
| 开销 | 几乎为零 | 相对重 |

一句话：Docker 是集装箱，bwrap 是保鲜膜。

## 1.3 「宿主根只读挂载」的具体实现

核心是两个内核特性的组合：**bind mount + mount namespace**，加一个易忽略的细节——
**只读标志是「每个挂载点」的，不是「每个文件系统」的**。

**① bind mount**：把现有目录树「投影」到新位置——不是复制，两个挂载点看到同一批
inode：

```c
mount("/", "/new_root", NULL, MS_BIND, NULL)
```

**② bind 天生可写，必须 remount 才变只读**：

```c
mount("/new_root", "/new_root", NULL,
      MS_BIND | MS_REMOUNT | MS_RDONLY | MS_REC, NULL)
```

Linux 2.6.26 起 `MS_RDONLY` 是**挂载点级**的——同一文件系统可同时挂在 A 处（可写）
和 B 处（只读）互不影响。这正是「沙箱里只读、宿主上照常可写」能同时成立的原因：

```
        共享同一个超级块（底层数据）
           ┌──────────┴──────────┐
  宿主的 / 挂载            沙箱的 / 挂载
  （可写，别人不受影响）     （MS_RDONLY，写 → EROFS）
```

`MS_REC` 递归——源树下的嵌套子挂载一并转只读，防止漏成可写缺口。

**③ bwrap 的完整序列**（系统调用层面）：

```
① clone/unshare：CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID ...
② 新 mount namespace 里搭空的新根（tmpfs）
③ 按参数绑定挂入：--ro-bind → MS_BIND 后 MS_REMOUNT|MS_RDONLY|MS_REC；
   --bind 工作区 → 保持可写；--dev/--proc → 全新实例
④ pivot_root/chroot 进入新根
⑤ exec 目标命令
```

**④ 强制点在内核 VFS**：每次涉及写入的系统调用（`open` 带写标志、`write`、
`unlink`、`mkdir`、`chmod`…），VFS 检查所属 `vfsmount` 的 `MNT_READONLY` 标志，
命中直接返回 `EROFS`——命令连「打开文件准备写」都过不去。

**⑤ 防逃逸：私有 PID namespace**。只读根的经典逃逸路径是 `/proc/<pid>/root` 魔法
链接——它在**目标进程自己的 mount namespace** 里解析。若沙箱进程能看到宿主进程的
`/proc` 条目，`/proc/<宿主pid>/root/` 就通向宿主的可写视图。私有 PID namespace 让
沙箱的 `/proc` 只含沙箱内进程，魔法链接无路可走。

## 1.4 workspace-write 的形态：只读底座 + 两个可写口子

沙箱内的挂载表（按具体程度排列）：

```
挂载点                            类型               可写？
─────────────────────────────────────────────────────────
/                                 宿主根的只读投影    ✗（MS_RDONLY）
<工作区目录>/...                   工作区可写绑定挂载   ✓ ← 口子①
/tmp                              全新 tmpfs          ✓ ← 口子②
/dev                              全新 devtmpfs        —
/proc                             全新 procfs（私有PID）—
```

**口子①**：工作区目录在只读根之下却能写——内核挂载解析规则是「路径命中**最具体**
的挂载点」。工作区被挂了两次：先随宿主根只读投影进来，再叠一个不带 MS_RDONLY 的
绑定挂载：

```
写 <工作区>/foo.py  → 命中工作区可写 bind mount → 成功 ✓
写 ~/outside.txt   → 命中只读根挂载 → EROFS ✗
```

工作区 = 会话创建时记录的不可变 `SessionHeader.cwd`——在哪启动会话，哪就是工作区。

**口子②**：`/tmp` 挂**全新空 tmpfs**（不是宿主的 /tmp），三个理由：工具兼容（编译器/
包管理器/tempfile 都要写 /tmp）、隔离（读不到宿主 /tmp 里的敏感残留，写进去的宿主
也看不到）、临时（内存文件系统，命令退出即蒸发）。

# 第二部分：dsh 的沙箱实现

## 2.1 sandbox 家族架构（三包）

| 包 | 职责 | ctx key |
|---|---|---|
| `dsh-sandbox` | Service Definition：模式词汇 + `confine(argv, policy)` 约定 | `ctx.sandbox` |
| `dsh-sandbox-local` | 本地后端：Linux `bwrap`（优先）/ Landlock；macOS Seatbelt；Windows ACL | 注册进 `ctx.sandbox` |
| `dsh-sandbox-policy` | 策略归属：部署默认 + 逐会话覆盖解析 | `ctx.sandboxPolicy` |

要点：

- 约定一句话：`ctx.sandbox.confine(argv, policy)` 返回用于 spawn 的包装 argv——
  进程及其所有后代都在限制下运行
- **策略随调用传递**：两个消费方可以同时按不同策略限制（bash 用 read-only、受限
  子代理保持状态目录可写）
- **策略解析链**：显式批准的模式 ?? 会话 `sandbox/mode` 事件 fold ?? 部署默认；
  工作区根 = 会话头不可变 `cwd`
- **边界**：只管与宿主共享文件系统/内核的限制（容器/microVM 是替换整个 seam）；
  不表达网络/进程/syscall 限制
- 会话级模式切换的唯一写路径：`setSandboxMode` 追加一条 `sandbox/mode` 事件——
  切换本身就是事件，重放跨重启保留

## 2.2 本部署的现状

`dsh-base`（所有 profile 的第一层）挂了完整沙箱家族：

```yaml
- id: sandbox          → dsh-sandbox-local
- id: sandbox-policy   → mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
                         workspaceRoot: process.cwd()
- id: bash-sandbox     → 包装 bash 命令（60s 超时）
- id: approval         → policy: danger-full-access 时 'never'，否则 'ask'
```

即默认生效模式 = **`workspace-write`**，审批策略 = `ask`。TUI 状态栏的 mode 显示
来自 `sandboxPolicy.resolve({session}).mode`。

**子代理的沙箱语义**：委派时策略被同步捕获（`captureDelegatedPolicyOverrides`）——
只带父会话的显式沙箱覆盖（以 `source: 'delegation'` 事件写进子级日志），**审批策略
一律钉死 `never`**：子代理内部需审批的操作自动拒绝——「权限启动即固定」的沙箱侧实现。

## 2.3 无后端时的处理：fail-closed 与修复指引

后端不可用——bwrap 缺失且 Landlock 也不可用（如 Ubuntu 20.04 这类内核低于 5.13
的版本未装 bubblewrap；Ubuntu 22.04+ 内核自带 Landlock，缺 bwrap 时会自动回退）——
**任何需要约束的
命令都被拒绝**——包括 `ls` 这种只读命令（所有 bash 调用都要经 confine 包装）。
错误文本三段结构：

```
sandbox mode "<mode>" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined.                          ← ① 事实 + 立场
Install bubblewrap or run a Landlock-enforcing kernel (Linux),   ← ② 修复指引：
ensure sandbox-exec is usable (macOS), or ensure the ACL            按平台给具体动作
restricted-token runner can start (Windows)
— otherwise switch the consumer to danger-full-access.           ← ③ 兜底出路
```

**修复指引写进错误文本的设计考量**：这条文本会进入模型上下文（作为工具结果）——
它是给模型和终端用户看的**可行动信息**：模型能转述「需要装 bubblewrap」或申请切换
模式；人不用翻文档；agent 不会陷入反复重试必然失败命令的死循环。fail-closed 但不
fail-silent。执行期 runner 失败还会追加 ` Runner failure: <detail>`。

## 2.4 权限审批系统（`dsh-user-approval`）

dsh 有权限审批，但定位与 Claude Code 相反——不是逐条命令的守门员，而是
**「放宽安全姿态」的唯一人工闸门**。

- **策略词汇**：`ApprovalPolicy = 'ask' | 'never'`（仅两态）
- **请求协议**：`ctx.approval.request({ agent, toolName, callId, reason, signal })`
  → `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
- **分发**：cordis `approval/request` 瀑布事件，多监听者可应答；TUI 只处理自己
  agent 的请求（`req.agent.session.id` 匹配），其余透传 `next()`
- **触发场景**：全仓源码核实，`approval.request` 的唯一生产调用方是
  **沙箱升权**（`escalation.ts`）——日常见到的审批弹窗全是「escalate sandbox to ...」
- **会话级持久化**：审批策略/沙箱模式/preset 三旋钮由 permission-presets 服务管理，
  各自以会话事件持久化

| 场景 | dsh 的应对 |
|---|---|
| 边界内操作 | 沙箱内直接执行，**不审批** |
| 越界操作 | 沙箱**拒绝**（denied），返回升权引导 |
| 模型申请升权 | **弹审批** |
| `danger-full-access` | 无边界可跨，策略 `never`，永不弹 |
| 子代理 | 审批钉死 `'never'`——需审批的操作自动拒绝 |

## 2.5 为什么沙箱内执行不需要审批

沙箱和审批是两层防护，管两种不同的风险：

- **审批的本质**：机制无法保证安全时，让人判断操作是否有害
- **沙箱在场时**：命令物理上碰不到边界外的任何东西——就算模型生成恶意命令，内核
  直接拒绝。风险不是靠人拦住的，是靠机制根本不存在的。此时审批只剩摩擦、没有安全
  增益
- **升权 = 安全姿态变更**：机制保证消失，所以必须人工批准——审批只守这一道门

Claude Code 的 `autoAllowBashIfSandboxed`（沙箱开启时 bash 自动放行）是同一逻辑的
镜像：**沙箱是审批的替代品**；审批存在的意义是弥补机制防护的缺席。

## 2.6 升权授予的范围：一次性的 allowed-once

升权审批的授予**只覆盖那一次调用**——三处源码证据：

1. 工具 schema 写死：`sandbox_permissions` *"Only valid as a **one-shot retry** of an
   operation the sandbox just denied"*
2. `approveEscalation` 返回值注释：*"the granted mode, **consumed by the one call
   that asked**"*
3. 审批结果词汇本身就是 `case 'allowed-once': return mode`——TUI 的 onApproval
   返回的正是这个词汇

机制链：工具在挂载限制后端时向模型广告 `sandbox_permissions`（enum 钉死升权目标
`['workspace-write', 'danger-full-access']`）+ `justification`（必填理由）→
`validateEscalationArgs` 校验配对 → 目标必须**严格更宽**（`WIDER_MODES` 执行时校验，
非更宽直接抛错不弹窗）→ `approveEscalation` 走审批 → 批准后
`resolve({ session, mode: granted })`（显式授权 > 会话策略）→ 授予的模式只盖章在
**本次调用**上。批准理由进审计记录。

`danger-full-access` 直接跳过 confine（不需要后端）——所以无后端机器上升权批准后
命令确实能跑。但会话有效模式不变——**下一条命令又走一遍完整循环**。

## 2.7 工作区内写入与逐文件人审

workspace-write 下工作区内的写入**全部直接执行、不经审批**——「工作区 = 已授权
区域」是设计语义。想让特定文件「写之前过人」，dsh 有三条路：

| 路 | 做法 | 粒度 |
|---|---|---|
| **A. 移出工作区**（推荐） | 敏感文件放工作区外——写被拒 → 升权 → 逐次人工批准 | 精确到文件，零配置 |
| **B. 会话切 read-only** | 所有写入都走升权审批，完事切回 | 粗粒度、彻底 |
| **C. 自定义工具插件** | 审批服务是通用 seam，任何工具可调 `ctx.approval.request`——写一个「敏感路径先审批」的 fs 包装 | 真正的逐文件审批，需自建 |

**dsh 缺的拼图**：沙箱策略词汇是「模式 + 单工作区根」，**没有路径级 allow/deny 列表**
（源码明说「额外可写根目录不属于 SandboxExecutionPolicy」）。dsh 的「人审」触发条件
是**位置**（在不在工作区内），不是路径名单。

# 第三部分：与 Claude Code 的对比

## 3.1 Claude Code 的沙箱现状（源码核实）

- **架构**：`src/utils/sandbox/sandbox-adapter.ts` 适配层包装外部包
  `@anthropic-ai/sandbox-runtime`；CLI 侧负责配置转换、工具接入与 UI（`/sandbox`
  命令、设置页、doctor、违规展示）
- **默认关闭**：`sandbox.enabled ?? false`，opt-in
- **平台**：macOS（Seatbelt）、Linux（Ubuntu 等）；Linux 依赖
  `bubblewrap` + `socat`
- **覆盖维度**：命令执行（Bash/PowerShell）、**网络**（`allowedDomains`、代理端口、
  Unix socket）、文件系统（`allowWrite`/`denyWrite`/`denyRead`/`allowRead`，与
  `Edit(...)`/`Read(...)` 权限规则自动合并）
- **关键联动**：`autoAllowBashIfSandboxed`（默认 true）——沙箱开着时 bash 自动放行
  不弹审批；`dangerouslyDisableSandbox` 单次跳出受 `allowUnsandboxedCommands` 门控；
  `excludedCommands` 是便利功能而非安全边界（源码注释明说）
- **违规弹窗**：沙箱开着且命令违规时弹「Network request outside of sandbox」类弹窗
  ——问「这一条要不要跳出沙箱跑」

## 3.2 同场景对比：「看看 /tmp」（无后端的 Ubuntu 机器）

**dsh**：

```
Bash(ls /tmp) → 沙箱层直接拒绝（fail-closed，无弹窗）
模型读错误指引 → 主动申请升权 danger-full-access
弹窗：Allow Bash? → 问的是「要不要放宽安全模式」
```

**Claude Code**：

```
沙箱默认关闭 → 沙箱层根本不参与
Bash(ls /tmp) → 权限系统弹窗：Allow Bash(ls -la /tmp)?
              → 问的是「要不要执行这条命令」
允许 → 命令裸跑
```

就算显式开了沙箱但依赖缺失：Claude Code 只在启动时警告一次，沙箱静默关闭走同样流程
（除非 `failIfUnavailable: true` 直接启动报错）——**命令永远不会因为「没有沙箱后端」
而失败**。

## 3.3 设计哲学的分野

| 维度 | dsh | Claude Code |
|---|---|---|
| 默认姿态 | **沙箱默认开**（workspace-write）——沙箱是常态 | **默认关**（opt-in）——裸跑+人工审批是常态 |
| 无后端时命令 | **拒绝执行**（fail-closed） | **照常执行**（fail-open）+ 启动警告 |
| 弹窗问什么 | 「升权沙箱模式？」——**安全姿态变更** | 「执行这条命令？」——**单次操作放行** |
| 谁发起升权 | **模型主动**（读错误指引，同轮内申请） | **用户主导**（违规后用户决定） |
| 升权/逃生粒度 | 模式级（三档切换） | 命令级（`dangerouslyDisableSandbox`） |
| 约束维度 | 仅文件 | 文件 + **网络** |
| 路径级词汇 | 无（模式 + 工作区根） | 有（allowWrite/denyWrite 列表） |

一句话：**dsh 把「没有沙箱」当事故处理（拒绝 + 升权审批），Claude Code 把它当常态
处理（警告 + 逐条人工审批）——同一个 `ls /tmp`，前者要你批准一次安全降级，后者只要
你批准一条命令**。

# 一句话总结

**沙箱 = 用内核强制力给程序画的执行边界（bind mount + namespace 拼装文件系统视图）；
dsh 的立场是「没有沙箱就不执行」（fail-closed + 带修复指引的错误文本），审批只守
「放宽边界」一道门且授予是一次性的；Claude Code 的立场是「没有沙箱退回人工逐条审批」
（fail-open）——两套系统对同一个问题的相反回答，源于对「基线安全由谁兜底」的不同选择。**
