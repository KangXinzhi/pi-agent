# Pi Agent Harness — 从 0 到 1 设计方案

> 本文档是从零构建一个「可自我扩展的 AI 编码智能体」的设计蓝图。
> 它以 pi-mono 的实际落地决策为蓝本:先讲清楚每个模块"为什么这么设计",
> 再给出接口与分阶段实施路线。目标是让一个工程师(或 agent)按图索骥地搭出全貌。

---

## 1. 定位与需求

### 1.1 项目是什么

一个运行在终端里的 AI 编码智能体(CLI,`bin: pi`):

- 用户输入自然语言指令,agent 自主决定调用哪些工具(read/bash/edit/write/grep…)完成编码任务;
- 支持多种 LLM 提供方(OpenAI / Anthropic / Google / Bedrock…),且模型目录可动态更新;
- 会话可持久化、可分支(fork)、可续跑;
- **可自我扩展**:用户能以 TypeScript 扩展的方式注入自定义工具、命令、UI 组件、甚至自定义 provider;
- 可被其他程序嵌入(JSONL RPC)或远程连接(协议化 RPC)。

### 1.2 核心能力清单

| 能力 | 说明 |
|---|---|
| 多 Provider LLM | 统一 API 屏蔽各厂商差异;仅需要工具调用能力 |
| Agent 循环 | 双层循环:工具调用内循环 + follow-up 外循环 |
| 工具系统 | 带 before/after 钩子、并行/串行执行、流式结果 |
| 会话管理 | append-only JSONL 日志,可分支、可重建状态 |
| 终端 UI | 差分渲染,低延迟、防闪烁、支持图片/IME |
| 扩展系统 | TS 扩展 + 宿主包注入,二进制内可加载 |
| 远程/嵌入 | JSONL RPC + CBOR/unix-socket 协议化 RPC |
| 遥测 | 无后端依赖的契约化遥测,可插拔适配器 |
| 工程化 | 锁步发布、CI 门禁、供应链加固、离线构建 |

### 1.3 非目标(刻意不做)

- 不做内置权限系统(权限交给 OS/容器,见 containerization 方案);
- 不做 GUI/IDE 插件(由生态承担);
- 不追求 CSS 级复杂布局(TUI 保持简单约束布局)。

---

## 2. 总体架构

### 2.1 分层与依赖方向

```
                 ┌────────────── evals (评估框架: pi-harness) ───────────────┐
                 └─────────────────────────────┬─────────────────────────────┘
                                               │
                 ┌─────────────── coding-agent (CLI, bin: pi) ───────────────┐
                 │  main.ts → 三种 mode: interactive / rpc / print          │
                 └──┬──────────┬──────────┬──────────┬──────────────────────┘
                    │          │          │          │
        ┌───────────┘    ┌─────┘    ┌─────┘    ┌────┘
   agent-core        tui        client     protocol
   (agent 运行时)   (终端UI)    (RPC客户端)  (RPC协议)
   (会话持久化: session-backends 可插拔, 如 sqlite-node)
        │              │          │     ┌─────┘
        └──────┬───────┘          │     │
           pi-ai (统一多Provider LLM API)  server (RPC服务端, 实验性)
                │
           pi-telemetry (零依赖遥测契约)
```

依赖规则(从 0 到 1 就必须定死):

1. **单向、自底向上**:上层可依赖下层,下层绝不依赖上层。这保证每个包可独立测试、独立发布。
2. **telemetry 零依赖、protocol 只依赖 typebox** —— 它们是地基,必须最薄。
3. **tui 是纯渲染库,绝不碰 RPC/agent 逻辑**;RPC 栈只存在于 coding-agent 的 mode 层。
4. 所有跨层数据用 **TypeBox schema 校验**,层与层之间是"可验证的边界"而不是隐式约定。

### 2.2 两条集成路径(重要)

- **生产路径(进程内)**:interactive-mode 直接驱动 AgentSession,渲染/事件/工具执行都在同一进程,不经过 RPC。
- **远程路径(实验性)**:`--mode rpc`(JSONL)或 protocol/client/server(unix socket + CBOR),供其他应用嵌入或远程连接。

设计决策:TUI 层与 RPC 层解耦,才能让两条路径并存 —— 这是架构上必须预留的接缝。

### 2.3 全局技术选型

| 决策点 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript,仅 erasable 语法(Node strip-only) | 免编译产物、Node/Bun 双跑 |
| 包管理 | npm workspaces monorepo,依赖精确 pin | 单 lockfile 作为依赖真相 |
| 校验 | TypeBox(TypeBox schema) | 一处定义,运行时校验 + 静态类型双得 |
| 构建 | esbuild;Node 包 + Bun 单文件二进制双产物 | 覆盖两种分发形态 |
| 模型数据 | 代码生成(脚本抓上游 → JSON → TS shard) | 上千模型元数据不手工维护 |

---

## 3. 模块设计(按依赖顺序,从地基到屋顶)

### 3.1 telemetry — 遥测契约

**职责**:定义显式、回调式的遥测上下文契约,不绑定任何后端。

```ts
interface TelemetryContext {
  span(name: string, attrs?: Record<string, unknown>): TelemetrySpan;
  // 显式传递,无全局 current-span
}
interface TelemetrySpan {
  setAttribute(k: string, v: unknown): void;
  addEvent(name: string, attrs?: Record<string, unknown>): void;
  end(error?: unknown): void;
}
```

**设计要点**:提供 `NOOP_TELEMETRY_CONTEXT` 和 `InMemoryTelemetryContext`(参考实现 + 一致性测试),应用自行接 OpenTelemetry/Sentry。**Why**:遥测不该阻塞主链路,也不该引入重依赖;契约化 + 可插拔让它成为地基而非负担。

### 3.2 protocol — RPC 消息协议

**职责**:运行时无关的 RPC 词汇表。TypeBox schema 定义全部消息;线格式为 `[uint32 大端长度][单条定长 CBOR(RFC 8949 子集)]`。

关键消息族:

- `ClientMessage` = hello | request(envelope,含 `id` 关联)
- `ServerMessage` = hello(带 ServerSnapshot)| response(ok/error)| event(envelope)
- `ServerEvent` = server_snapshot | session_snapshot | session_progress | session_removed
- `TranscriptItem`(user/assistant/tool 各状态)+ 增量 `TranscriptProgress`(item_started/assistant_delta/item_updated/item_finished)

**设计要点**:CBOR 而非 JSON 传输(紧凑、流式安全);解码器增量式、抗分片;设防护上限(16MiB/帧、64 层嵌套,元素数由帧长隐式约束);`PROTOCOL_VERSION` 做握手版本校验。

### 3.3 ai — 统一多 Provider LLM API(核心之一)

**目标**:一套 API 调用所有厂商,且"只面向有工具调用能力的模型"(agentic 聚焦)。

三个核心抽象:

```ts
interface Model<TApi extends Api> {
  id: string; name: string; api: TApi; provider: ProviderId; baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;       // pi 思考等级 → 各厂商取值
  input: ("text" | "image")[];
  cost: ModelCost;                           // $/M tokens
  contextWindow: number; maxTokens: number;
  compat?: /* 各厂商 compat 标志 */;
}

interface Provider<TApi extends Api> {
  id: ProviderId; name: string; auth: Auth;
  models: Model<TApi>[];
  refreshModels?(): Promise<Model<TApi>[]>;  // 动态目录
  stream(model, context, opts?): AssistantMessageEventStream;
  streamSimple(model, context, opts?): AssistantMessageEventStream;
}

interface Models {                           // 注册表 + 请求入口
  getModel(id): Model | undefined;
  stream(...): AssistantMessageEventStream;  // lazyStream:同步返回、异步认证在其后
  refresh(); checkAuth(); login(); logout();
}
```

**关键架构决策**:

1. **传输层与 provider 解耦**:`src/api/` 下每个厂商协议实现为一个 `ProviderStreams`(`stream`/`streamSimple`,可选 `fetchDeferred`),全部 **lazy 加载**(`lazyApi(() => import(...))`),避免启动即拉起所有厂商 SDK。provider 工厂只是把 `{id, baseUrl, auth, models, api}` 组装起来的十几行代码。**Why**:新增厂商 = 新增一个 api 传输 + 一个工厂,不动核心。
2. **模型目录代码生成**:`generate-models.ts` 从 models.dev + 特殊源抓取 → 生成 `providers/data/*.json` + manifest(带 hash 校验)→ TS shard → `models.generated.ts` 聚合。**Why**:上千模型元数据手工维护必 drift;生成 + manifest 校验保证一致性。动态目录(OpenRouter/Copilot/Bedrock)运行时经 `ModelsStore`(etag/checkedAt)热刷新。
3. **跨厂商归一化在边界做**:`transform-messages.ts` 统一 tool-call ID 长度、非视觉模型图片降级、thinking block 回放;约束采样(json_schema/grammar)、deferred tools(工具延迟加载)也是"按 API 能力分派"。
4. **认证**:环境变量(per-provider 映射 `env-api-keys.ts`)+ 凭据存储 + OAuth 流程,统一由 `applyAuth()` 在请求前解析合并。

### 3.4 agent — Agent 运行时(核心之二)

**目标**:与具体厂商无关的 agent 引擎:prompt → 工具调用 → 结果回灌 → 直到完成。

**双层循环**(`agent-loop.ts`):

```
外循环 (follow-up):
  内循环 (工具调用):
    发出 LLM 请求 (streamAssistantResponse, 是 LLM 唯一边界)
    解析 toolCall:
      - stopReason == "length" → 不执行截断参数
      - 否则执行工具 (并行/串行), 结果推回 context
    直到停止 (prepareNextTurn 可换模型/思考等级; shouldStopAfterTurn)
  内循环结束 → 取 follow-up 消息, 有则继续外循环
```

**工具系统**:

```ts
interface AgentTool<TParams extends TSchema, TDetails> {
  name: string; label: string; description: string;
  parameters: TParams;                          // TypeBox
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}
// 钩子: beforeToolCall(可 block) / afterToolCall(可 override 结果/terminate)
```

**状态双层**:
- 内存态 `AgentState`(模型、thinkingLevel、tools、messages、pendingToolCalls)由 `Agent` 类持有;
- 持久层 `Session`:`SessionTree` 建立在 **append-only、带 seq/parentId 的 JSONL 日志**上,Entry 类型(message/model_change/compaction/branch_summary…);`reducer.ts` 从日志重建状态。

**Why JSONL 而不是数据库**:append-only 天然支持分支(fork = 新 lane 链到 parentId)、审计、增量同步;不用引入存储引擎。代价是读时重建,由 compaction(摘要压缩)缓解。

**Harness 层(可选但强烈建议)**:`AgentHarness` 把 `ExecutionEnv`(FileSystem/Shell 抽象)注入内置工具(bash/read/edit/write),并带 durable state reducer —— 让 agent 核心可脱离 CLI 独立复用。

### 3.5 tui — 差分渲染终端 UI

**职责**:纯渲染/输入库,不含 agent 逻辑。

极简契约:

```ts
interface Component {
  render(width: number): string[];   // 每行一个字符串,不得超过宽度
  handleInput?(data: string): void;  // 原始终端输入(含 ANSI)
  invalidate(): void;                // 丢弃缓存重渲染
}
```

**两种渲染器**:
- `TuiMainScreen`(终端 scrollback 模式):**差分渲染** —— 比较新旧行数组找 firstChanged/lastChanged,相对光标移动 + `\x1b[2K` 只清重绘变化区间;变化在视口上方则回退全量重绘;所有更新包在 `\x1b[?2026h/l` 同步输出里防闪烁。**Why**:全量重绘在慢终端上闪烁且破坏 scrollback。
- `TuiAltScreen`(备用屏):约束布局系统 `VStack/HStack/ScrollView`,每帧重建布局树(不重建组件状态),支持滚动、轮询跟随、滚轮路由。

**其余**:渲染节流 16ms(键盘输入直通)、Kitty/iTerm2 内联图片、IME 光标定位(APC escape marker)、Markdown/Editor/Autocomplete 组件。

### 3.6 client / server — 协议化 RPC(实验性)

- **client**:`ByteTransport`(unix socket,须预认证)→ `Connection`(hello 握手)→ `PiClient`(按 request-id 关联响应)→ `SessionHandle/SessionLease`(独占/共享租约、attach/detach/重连)。
- **server**:`PiServer` 每连接状态机(awaitingHello→handshaking→ready,握手超时 5s)→ `LiveSessionManager` 执行 7 种 Command → `ServerSnapshotPublisher` 广播快照。**关键**:不提供独立服务,应用自供 `PiServerService` 实现。

**Why 放在 coding-agent 之下、独立成包**:协议化 RPC 是"嵌入/远程"的接缝,独立成包让双路径成立,同时避免污染进程内主路径。

### 3.7 coding-agent — CLI、扩展系统与三种模式(屋顶)

**入口流**:`cli.ts` → `main.ts`(解析参数 → 建 SessionManager → 项目信任解析 → 建 cwd 绑定服务 → mode 分发)。

**三种 mode**:
- `interactive`:直接驱动 `AgentSession` + `pi-tui` 渲染(约 50 个组件);
- `rpc`:`runRpcMode()` JSON 行协议(stdin 收命令/stdout 出事件),供嵌入;配套类型化 `RpcClient`;
- `print`:`-p` 非交互输出。

**核心对象**:
- `AgentSession`(唯一中枢:prompt loop、事件、compaction、重试、bash、扩展绑定);
- `AgentSessionRuntime`(会话生命周期 + cwd 绑定服务);
- `SessionManager`(JSONL 会话树:fork/resume/continue/session-id)。

**扩展系统(自我扩展的根基)**:

- 用 **jiti 加载 TS 扩展模块**;
- 通过 **virtualModules 把打包进 Bun 二进制的宿主包(pi-ai/pi-tui/typebox 等)注入扩展**,保证"单文件二进制形态下扩展仍能 import 宿主包";
- `extensions/types.ts` 定义完整扩展 API:自定义工具、slash 命令、widget/UI 组件、markdown transformer、自定义 provider;
- `resource-loader` 统一加载 AGENTS.md/CLAUDE.md、扩展、skills(SKILL.md)、prompt 模板、主题 —— 这同时是"pi 能读取自身上下文"的机制。

**Why jiti + virtualModules**:扩展要即写即用、还能在编译产物里跑,这是权衡后的组合;代价是 API 面必须稳定(types.ts 即公共契约)。

---

## 4. 从 0 到 1 实施路线图

> 每阶段都有**可运行、可验证**的产出,不是纯纸上设计。阶段间保持主分支可发布。

### 为什么是这个顺序(全局视角)

参考当前系统的**真实演进架构**(git 历史)而非纯理论依赖序。真实的 pi 演进验证了一条原则:

**先做垂直切片,在"真的需要"时才抽层,横切关注点最后收。**

- 2025-08(起点):`agent` + `tui` 同日建立 —— 第一天就是"能聊天的垂直切片";一周后(08-17)才抽出 `ai` 统一层
- 2025-10:session 存储重构(10-06);`coding-agent` 产品 CLI 诞生(10-17,比 agent 晚两个月)
- 2025-11:`--mode rpc`(JSONL 嵌入契约)随 CLI 一起长出来 —— 嵌入优先
- 2026-07:才补 protocol/client/server 远程 RPC 层
- 2026-08(近期):telemetry 契约 + sqlite 会话后端 —— 横切关注点最后抽取

本路线图与之对齐,并在 git 基础上做**两处全局修正**(git 未必最优):

1. git 里 `ai` 是第 2 周才抽的;这里把它提前到 A 阶段的最小形态,让垂直切片自带 provider 抽象,避免返工。
2. git 里 telemetry/protocol 很晚才建;这里保持"最后建",但 A–E 阶段就用**最简实现占位**(内联日志、JSON 直传),抽层时再替换 —— 不先铺用不到的地基。

### 提交规范(参考 temp.md 节奏)

- **一次只做一个任务**:先读该任务规格 → 写代码 → 写测试 → 跑通 → commit。不留"测试后补"。
- commit 格式:`{feat,fix,docs}[A1]: <msg> `,正文附测试结果,例如:

  ```
  feat(A1): add openai-responses transport 

  tests: 8 unit passed (mock fetch)
  ```

- **测试与代码同 commit**;三层测试(unit / integration / e2e),e2e 只在有环境时激活。
- 阶段出口是质量门:未通过不进下一阶段。

---

### A 垂直切片 — 先跑通"能聊天的 agent"

> 目标:一个能交互对话、能单轮 `-p` 输出的最小 agent;先不做工具、不做多 provider、不做持久化。
> 演进锚点:真实 pi 起点 `a74c5da1`(monorepo 初始化);`agent`+`tui` 2025-08-09 同日建立,`ai` 一周后 `f064ea0e1`(2025-08-17)。

#### A1 monorepo 骨架
- **技术要点**:npm workspaces + 根 tsconfig(仅 erasable 语法,Node strip-only)+ .npmrc(save-exact、min-release-age=2)+ biome + husky。
- **验收**:空仓库 `npm install` 成功;`npm run check` 全绿;新增依赖被 pin。

#### A2 最小 ai
- **技术要点**:核心类型 Model/Provider/Models + Context + AssistantMessageEventStream(接口见 §3.3)+ 1 个传输(openai-responses,含 lazyApi)+ 1 个 provider 工厂 + env 认证。
- **验收**:mock fetch 下事件流折叠正确;缺 key 报可读错误;≥8 单测。

#### A3 最小 agent
- **技术要点**:单轮 prompt→stream 循环(先不做工具循环),`streamAssistantResponse` 即 LLM 边界;支持 abort。

  ```ts
  runLoop(prompts, context, config, signal, streamFn): EventStream<AgentEvent, AgentMessage[]>
  ```

- **验收**:能输出一句话、能 abort;≥10 单测。

#### A4 最小 tui
- **技术要点**:Component 契约(render(width)/handleInput/invalidate)+ TuiBase 调度(16ms 节流,键盘直通)+ TuiMainScreen 差分渲染(三策略:全量/增量/回退)+ 同步输出防闪烁。
- **验收**:帧序列与预期 escape 一致;≥12 单测。

#### A5 垂直集成
- **技术要点**:interactive chat demo 把 A3+A4 接起来(能聊、流式刷新、Ctrl+C 中止)。
- **验收**:tmux 冒烟完成一次对话。

#### A6 最小 print 模式
- **技术要点**:cli.ts → main.ts → runPrintMode 端到端。
- **验收**:有 key 出话、无 key 报错、`--model/--provider` 生效;1 e2e。

#### A7 冒烟 + CI 骨架
- **技术要点**:`./pi-test.sh`(tsx 直跑源码)+ 根 `test.sh`(非 e2e 测试选择)+ ci.yml(lint + typecheck + 测试)。
- **验收**:push 触发 CI 全绿。
- **阶段出口 A**:`pi -p` 与交互 chat 双闭环;换 provider 只需换工厂。

### B ai 抽层 — 多 provider 化 + 工具调用

> 目标:provider 从 1 变多时,把 A2 的最小实现正规化为统一层。
> 演进锚点:真实 pi 抽出 ai 后即集成 models.dev(`02a9b4f0`)与统一模型系统(`9c3f32b9`),当月完成。

#### B1 传输层解耦
- **技术要点**:ProviderStreams 契约 + lazyApi;每个新协议一个 `src/api/*.lazy.ts`。
- **验收**:lazy 加载不拖慢启动;≥6 单测。

#### B2 工具调用契约
- **技术要点**:Tool/ToolCall/ToolResultMessage + ToolChoice(TypeBox 参数校验)。
- **验收**:工具消息往返;≥8 单测。

#### B3 跨厂商归一化
- **技术要点**:transform-messages —— tool-call ID 归一、非视觉模型图片降级、thinking block 回放。
- **验收**:同一 context 过两厂商输出一致;≥10 单测。

#### B4 多 provider 工厂
- **技术要点**:anthropic/google/mistral/deepseek 各一个,共用 createProvider。
- **验收**:每厂一个 e2e(仅 dev);≥6 单测。

#### B5 模型目录生成
- **技术要点**:models.dev 数据 + generate-models 脚本 → JSON + manifest 校验 → TS shard。
- **验收**:生成结果校验通过;--list-models 可用;≥5 单测。

#### B6 认证深化
- **技术要点**:credential store、OAuth(如 Claude Pro/Max)、动态目录 ModelsStore(etag/checkedAt)。
- **验收**:登录/登出/刷新闭环;≥10 单测。
- **阶段出口 B**:--list-models 展示全目录;换 provider 零改 agent 代码。

### C agent 引擎正规化 — 双层循环 + 工具系统

> 目标:从"单轮回复"进化为"自主多步工具调用"。
> 演进锚点:真实 pi 的 session 存储重构(`e5cf25a2`,2025-10-06)前后,agent 从循环成熟到能支撑产品 CLI。

#### C1 双层循环
- **技术要点**:runLoop —— 内层工具循环 + 外层 follow-up;streamAssistantResponse 为 LLM 唯一边界(buildProviderContext + getApiKey + 事件折叠)。

  ```
  外循环 (follow-up):
    内循环 (工具调用):
      发 LLM 请求 → 解析 toolCall → 执行(并行/串行) → 结果回灌 → 直到停止
    内循环结束 → 取 follow-up 消息, 有则继续
  ```

- **验收**:循环状态迁移单测;≥10 单测。

#### C2 工具契约
- **技术要点**:AgentTool(typebox parameters、execute、executionMode)+ beforeToolCall(block)/afterToolCall(override/terminate)。接口见 §3.4。
- **验收**:钩子调用顺序测试;≥8 单测。

#### C3 执行管线
- **技术要点**:prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall → createToolResultMessage;并行(先预检后并发)/串行;`stopReason==length` 时不执行截断参数。
- **验收**:并行结果聚合正确;≥12 单测。

#### C4 ExecutionEnv
- **技术要点**:FileSystem/Shell 抽象 + Node 实现,工具只依赖抽象。
- **验收**:mock env 注入测试;≥8 单测。

#### C5 read/write 工具
- **技术要点**:read(offset/limit + 图片 base64)/ write(建父目录、幂等)。
- **验收**:各自单测;≥8 单测。

#### C6 edit/bash 工具
- **技术要点**:edit(精确替换 + diff + 文件队列串行化防竞争)/ bash(输出截断 + 全量存临时文件 + 超时)。
- **验收**:各自单测;≥12 单测。

#### C7 Agent 状态包装
- **技术要点**:AgentState、steering/follow-up 双队列、abort、subscribe/processEvents(事件归约)。
- **验收**:事件归约成状态正确;≥10 单测。

#### C8 最小 compaction
- **技术要点**:token 估算 + 摘要生成 + 触发策略。
- **验收**:超阈值后上下文被压缩;≥8 单测。
- **阶段出口 C**:`pi -p "读 package.json 把 name 写到 /tmp/x.txt"` 自主完成多步工具调用。

### D 会话持久化

> 目标:`-c` 续跑上下文完整;fork 互不污染;崩溃后可重建。
> 演进锚点:真实 pi 2025-10-06 `e5cf25a2` 才做 session storage 重构 —— 持久化是 agent 能用起来后才有需求。

#### D1 数据模型 + codec
- **技术要点**:Entry(seq/parentId)+ LaneRecord + SessionStorage 接口 + append-only JSONL codec(增量解码)。

  ```ts
  type Entry = { id: string; seq: number; parentId?: string; timestamp: number }
             & ({ type: "message"; ... } | { type: "model_change"; ... }
              | { type: "compaction"; ... } | { type: "branch_summary"; ... } | { type: "custom"; ... })
  ```

- **验收**:codec 往返 + 损坏文件报错;≥10 单测。

#### D2 SessionTree + reducer
- **技术要点**:Session 树实现 + reducer 从日志重建内存状态。
- **验收**:任意日志前缀重建一致;≥10 单测。

#### D3 存储实现
- **技术要点**:InMemory + Jsonl 双实现 + conformance 套件。
- **验收**:两个实现过同一套测试;≥15 单测。

#### D4 SessionManager
- **技术要点**:会话列表/创建/resume/continue/fork/session-id 语义 + 会话树持久化。
- **验收**:fork 互不污染、续跑完整;≥12 单测。
- **阶段出口 D**:`-c` 续跑、fork 隔离、崩溃重建。

### E 产品化 — coding-agent CLI + 交互模式

> 目标:从"agent 库"变成"日常可用的编码 agent 产品"。
> 演进锚点:真实 pi 的 coding-agent `ffc9be88`(2025-10-17)才诞生,交互模式 `ba8d8029`(2025-11-11)成熟 —— 产品 CLI 是独立于 agent 核心的一层。

#### E1 CLI 参数层
- **技术要点**:args 解析/校验、migrations、项目信任、config 路径解析(锚定项目根,不依赖 CWD)。
- **验收**:--help 完整、非法参数报错;≥10 单测。

#### E2 三 mode 骨架
- **技术要点**:interactive / rpc(先占位 JSONL)/ print 分发,`resolveAppMode` 统一出口。
- **验收**:三种 mode 都能启动;3 e2e。

#### E3 交互组件化
- **技术要点**:interactive-mode 组件化(assistant-message/bash-execution/footer/session-selector…)+ 流式 delta 渲染。
- **验收**:tmux 冒烟长对话滚动不闪;≥8 单测。

#### E4 状态区
- **技术要点**:pending 队列、working/retry/compaction 状态、widget 区。
- **验收**:状态切换正确;≥6 单测。

#### E5 resource-loader
- **技术要点**:AGENTS.md/CLAUDE.md、skills、prompt 模板($1/$@ 替换)、主题统一加载。
- **验收**:加载顺序 + 诊断输出;≥12 单测。

#### E6 bash 执行器
- **技术要点**:进程树 kill、输出截断/累积、超时。
- **验收**:超时/中断正确回收进程;≥10 单测。
- **阶段出口 E**:日常交互可用;`pi` 在终端里完成真实编码任务。

### F 扩展系统

> 目标:20 行自定义工具扩展即写即用;Bun 单文件二进制内可加载。
> 演进锚点:真实 pi 2025-12 扩展/subagent/skills 爆发 —— 扩展是产品成熟后的放大器。

#### F1 loader
- **技术要点**:jiti 加载 TS 扩展 + virtualModules 注入宿主包(pi-ai/pi-tui/typebox),保证 Bun 二进制内可解析。

  ```ts
  // extensions/types.ts 为核心公共契约,改动按 breaking 评审
  interface Extension { name: string; setup(api: ExtensionAPI): void | Promise<void> }
  ```

- **验收**:源码态 + 二进制态各跑通一个扩展;≥8 单测。

#### F2 公共契约
- **技术要点**:extensions/types.ts —— Extension/ExtensionFactory/ToolDefinition/RegisteredCommand 核心子集。
- **验收**:契约单测;≥8 单测。

#### F3 工具/slash 扩展
- **技术要点**:自定义工具、slash 命令、命令注册。
- **验收**:每类一个示例扩展;≥6 单测。

#### F4 UI/provider 扩展
- **技术要点**:widget/UI 组件、markdown transformer、自定义 provider(含 auth)。
- **验收**:每类一个示例扩展;≥6 单测。

#### F5 内置扩展 + 文档
- **技术要点**:内置扩展清单、examples/extensions/、extensions.md。
- **验收**:文档步骤可复现。
- **阶段出口 F**:20 行扩展即写即用;Bun 二进制内同扩展可加载。

### G 远程/嵌入 RPC

> 目标:双进程会话共享同一份 JSONL;断线重连状态一致。
> 演进锚点:真实 pi 的 JSONL 嵌入 `68092ccf`(2025-11-12)很早就存在;protocol/client/server 2026-07 才建 —— 嵌入优先、协议化远程后置。

#### G1 rpc mode 完善
- **技术要点**:JSONL 命令/事件协议 + 类型化 RpcClient(先于 protocol 层)。接口见 §3.7。

  ```
  stdin:  {"type":"prompt","id":1,...}   stdout: {"type":"response",...} / 事件流
  ```

- **验收**:嵌入方驱动一次完整会话;≥10 单测。

#### G2 protocol
- **技术要点**:TypeBox 消息族 + CBOR 编解码 + 增量解码器 + 防护上限(16MiB/帧、64 层,元素数由帧长隐式约束)。
- **验收**:跨进程编解码一致性 + 抗分片;≥15 单测。

#### G3 client
- **技术要点**:ByteTransport(unix socket 预认证)→ Connection(hello 握手)→ PiClient(request-id 关联)。
- **验收**:连接状态机单测;≥12 单测。

#### G4 server
- **技术要点**:PiServer 每连接状态机(握手超时 5s)+ LiveSessionManager(7 种 Command)+ ServerSnapshotPublisher;PiServerService 由应用提供。
- **验收**:会话快照广播正确;≥12 单测。

#### G5 RemoteSession
- **技术要点**:TUI 作为客户端连远程 server(attach/detach/重连 + 租约)。
- **验收**:双进程共享 JSONL、断线重连一致;≥8 单测。
- **阶段出口 G**:嵌入(JSONL)与远程(CBOR)双路径打通。

### H 横切抽取与工程化收尾

> 目标:把 A–E 阶段占位的最简实现抽成契约/可插拔;发布与供应链闭环。
> 演进锚点:真实 pi 的 telemetry 契约 + sqlite 会话后端 2026-08-05 才抽 —— 横切关注点在系统跑稳后才值得固化。

#### H1 telemetry 契约
- **技术要点**:把内联日志抽成 TelemetryContext/TelemetrySpan(接口见 §3.1)+ NOOP/InMemory + conformance 测试。
- **验收**:三个实现过同一套测试;原有日志行为不变;≥10 单测。

#### H2 会话后端可插拔
- **技术要点**:session-backends 接口化 + sqlite-node 实现。
- **验收**:两后端过同一套 conformance;≥10 单测。

#### H3 模型目录管线终态
- **技术要点**:manifest 校验、离线构建快照、ModelsStore 动态刷新。
- **验收**:离线构建可用;check:model-data 通过。

#### H4 测试分层
- **技术要点**:harness + faux provider(不碰真实 API key)、回归目录(test/suite/regressions/)。
- **验收**:./test.sh 全绿且不触发 e2e。

#### H5 发布脚本
- **技术要点**:锁步版本(release:patch/minor)+ 逐包 CHANGELOG + 版本同步。
- **验收**:dry-run 产物正确。

#### H6 本地 smoke + 线上发布
- **技术要点**:release:local 仓库外 smoke(Node + Bun)+ OIDC npm 发布 + announce 验证(R2 标记)。
- **验收**:仓库外 smoke 通过;发布后标记可读。

#### H7 供应链加固
- **技术要点**:shrinkwrap + 生命周期脚本 allowlist、依赖 pin、npm audit 定时。
- **验收**:check:shrinkwrap 通过、audit 干净。

#### H8 evals
- **技术要点**:pi-harness 评估框架 + 关键任务集。
- **验收**:基线评估可复现。
- **阶段出口 H**:发布闭环打通;供应链干净;测试不碰真实 API key。

### 里程碑排期(参考真实演进节奏)

| 阶段 | 预估工作量 | 真实演进用时 | 里程碑判定 |
|---|---|---|---|
| A 垂直切片 | 1-2 天 | 首周(agent+tui 同日,ai 一周后) | `pi -p` + 交互 chat 双闭环 |
| B ai 抽层 | 1-2 周 | ~1 个月(08-17 → 09) | --list-models 全目录,换 provider 零改 agent |
| C agent 引擎 | 1-2 周 | ~2 个月(08 → 10) | 多步工具任务自主完成 |
| D 会话持久化 | 3-5 天 | 2025-10(与 C 重叠) | `-c` 续跑、fork 隔离、崩溃重建 |
| E 产品化 | 1-2 周 | 10-17 诞生,11 月交互成熟 | 日常交互可用 |
| F 扩展系统 | 1-2 周 | 2025-12 爆发 | 20 行扩展即用 + Bun 可加载 |
| G 远程/嵌入 | 1-2 周 | 嵌入 11 月,协议层 2026-07 | 双路径打通 |
| H 横切+工程化 | 1-2 周 | 2026-08(近期) | 发布闭环 + 供应链干净 |

> **每天推进方式**:一次只做一个任务:读该任务规格 → 写代码 → 写测试 → 跑通 → commit(`feat(E1): 描述` + 测试结果)。到 C 末尾就有第一个完整闭环(能自主多步工具调用),到 E 末尾接入日常使用会有明显正反馈。

---

## 5. 质量与工程化要点

### 5.1 测试策略(关键决策)

- **测试分层**:单元(纯逻辑)/ 集成(harness + faux provider)/ e2e(真实 API,仅在有 env 时激活)。
- **agent 测试用 faux provider 而非真实 API** —— 可控、免费、不碰 token。这是 agent 类项目最重要的测试基建。
- **TUI 用 node:test + 帧断言**;tmux 冒烟脚本验证交互态。
- 每个 issue 回归测试落在独立文件:`test/suite/regressions/<issue>-<slug>.test.ts`。

### 5.2 供应链加固

- 直接外部依赖精确 pin;`min-release-age=2` 防"当天发布"的依赖注入风险;
- 发布 CLI 自带 shrinkwrap(锁传递依赖),生成时对**生命周期脚本**设 allowlist —— 新增带脚本的依赖必须人工审查;
- CI 用 `npm ci --ignore-scripts`;定时 `npm audit`。

### 5.3 发布流程

- **锁步版本**:所有包共享一个版本号,一次发布全量更新;patch=修复+新增,minor=破坏性变更。
- 发布前必须跑 `release:local` 仓库外 smoke(Node + Bun 双产物、交互态)。
- 标签触发 CI:OIDC 信任发布 npm + 验证 announce(R2 标记),`pi.dev/api/latest-version` 只读该标记。

---

## 6. 关键取舍与风险

| 取舍 | 代价 | 缓解 |
|---|---|---|
| JSONL 会话而非数据库 | 读时重建成本 | compaction + 增量 reducer |
| 生成式模型目录 | 生成脚本复杂(2.9k 行) | manifest 校验、离线构建快照 |
| 差分渲染 TUI | 渲染逻辑复杂 | 清晰的三策略(全量/增量/回退) |
| jiti + virtualModules 扩展 | API 面必须冻结 | types.ts 即公共契约,严格评审 |
| RPC 栈为实验性 | 双路径维护成本 | 严格解耦,协议版本化 |

**最大的架构风险点**:`AgentSession`(编码 agent 的中枢,3.4k 行)容易膨胀成上帝类 —— 从 0 到 1 时应把"事件流、compaction、重试、扩展绑定"拆成独立模块,用接口隔离,而非塞进一个类。

---

## 7. 结论

从 0 到 1 的顺序可以概括为:**先做垂直切片(agent + tui + 最小 ai,能聊天)→ 在"真的需要"时抽层(ai 多 provider → agent 引擎 → 会话持久化)→ 产品化(coding-agent CLI + 交互模式)→ 放大器(扩展系统)→ 远程/嵌入(RPC)→ 横切收尾(telemetry / 会话后端 / 发布 / 供应链)**。核心是先打通"能聊天的垂直切片",再逐层抽厚;抽层永远发生在需求真实出现之后,而不是一上来就铺全部地基。每个阶段结束都有可运行的验证点;依赖方向保持单向、边界保持 TypeBox 可校验,是这套架构能持续演进而不出乱子的根本。

---

## 8. 附录:真实踩坑点(提前规避)

> 以下坑点来自真实 pi 的代码与历史,按"踩到的时间点"排序,从 0 到 1 时应提前规避。

1. **erasable TS 约束(A1 就锁死)**:禁 `enum`/`namespace`/`module`/`import =`/parameter properties。tsconfig 一开始就开 strip-only 模式,否则后期大批量返工(仓库全部 `packages/*/src` 都受此约束)。
2. **AgentSession 上帝类膨胀(C7 起警惕)**:真实 pi 的 `AgentSession` 长到 3.4k 行。从 C 阶段就按"事件流 / compaction / 重试 / 扩展绑定"拆独立模块,用接口隔离,不要全部塞进中枢类。
3. **`models.generated.ts` 只经生成脚本改(B5)**:手工修改必被 `npm run check` 拒绝;改 `scripts/generate-models.ts` 后重新生成,生成的 diff 即使含无关上游元数据变化也可提交。
4. **并行工具写文件竞争(C3/C6)**:edit/write 必须经 `file-mutation-queue` 按文件串行化,否则并行工具调用同时改同一文件产生竞态。
5. **截断参数不执行(C3)**:`stopReason == "length"` 时不要执行 toolCall —— 截断的 JSON 参数会破坏工具调用,直接标失败。
6. **bash 输出截断(C6/E6)**:长输出必须截断到尾部 N 行/字节,并把全量存到临时文件供后续读取;否则一段 `cat` 就能打爆上下文。
7. **主屏 vs 备用屏语义不同(E3)**:`TuiMainScreen` 依赖终端 scrollback,不能假装它有 sticky 行/嵌套滚动;只有 `TuiAltScreen`(备用屏)才有约束布局系统。把两种语义混在一起是 TUI 最常见的返工来源。
8. **扩展 API 面必须冻结(F2)**:jiti + virtualModules 让扩展在 Bun 单文件二进制里也能 `import` 宿主包;`extensions/types.ts` 就是公共契约,任何改动按 breaking 评审(先加默认值再改,别硬删字段)。
9. **tui 渲染节流与输入直通(E1)**:全量重渲染要节流(16ms)但键盘输入必须直通 `requestImmediateRender`,否则输入延迟感知明显 —— 这是交互手感的分水岭。
10. **会话 JSONL 增量与读写分离(D1)**:会话日志 append-only、增量解码、崩溃后可重建;不要在内存里维护唯一真相再整体落盘。

---

## 9. 使用建议

1. **新建项目目录** → 按 §2.1 建包骨架 → 从 A1 开始逐个任务做,每个任务按"提交规范"一次一个 commit。
2. **每个任务完成后**对照该任务的验收标准自测,达到"可运行 + 测试绿"再进入下一个。
3. **做到 C 末尾**就有了第一个完整闭环(自主多步工具调用),值得停下来验证一次;**到 E 末尾**接入日常交互使用会有明显正反馈;之后的 F/G/H 是放大器与收尾。
4. **每阶段结束**在阶段出口处打勾,更新对应包的 CHANGELOG `[Unreleased]` 节,保持"随时可发布"。
