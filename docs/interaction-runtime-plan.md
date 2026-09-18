# 交互运行时重构计划

状态：第一阶段已实现，兼容迁移进行中

目标：将模型交互从 `src/main.ts` 中的过程式分支重构为 TypeScript 对象模型、状态机和行为树执行器。实现必须适用于不同模型，不得针对某个 LPK、动作名或参数 ID 编写特例。

## 1. 当前问题

当前 `src/main.ts` 同时负责以下职责：

- Pixi 指针事件和命中区域排序。
- 普通点击、拖拽动作、ParamHit 拖拽和虚拟参数拖拽。
- VarFloats 条件和动作。
- `Command`、`PostCommand`、`NextMtn` 的执行。
- Live2D motion manager 调用、声音等待和 Idle 回退。
- 参数锁、动作完成状态和三状态完成检测。
- 模型加载初始化、稳定命中区域和窗口输入区域。

这些职责互相修改全局变量，导致以下类型的回归：

- 交互动作和普通模型拖拽同时触发。
- 动作完成后错误地回到当前页面或错误 Idle。
- `parameters lock` 被误当作永久状态保存。
- `NextMtn`、`PostCommand` 和完成检测的执行顺序不稳定。
- ParamHit、普通 HitArea 和命令型入口使用了不同的状态路径。
- 首次加载、重新加载和切换模型时残留状态没有统一清理。

## 2. 设计原则

### 2.1 JSON 是行为来源

运行时只解释模型元数据和文档规定的语义：

1. 先解析并规范化字段名。
2. 先检查 `Enabled`、VarFloats、Intimacy 和 PreMtn 条件。
3. 条件不满足时不得执行动作、命令或副作用。
4. 命令型入口不提交 Live2D motion。
5. 文件动作结束后按 `PostCommand`、`NextMtn`、默认 Idle 的顺序处理。
6. `Command` 中的锁必须遵守声明的持续时间；状态持久化必须由明确的状态变量或后续动作表达，不能根据动作名称推断。
7. `HitArea.Motion`、`NextMtn`、`BeginMtn`、`EndMtn`、`MinMtn`、`MaxMtn` 和 `start_mtn` 使用同一个引用解析器。

### 2.2 交互对象不直接操作全局变量

每个交互对象只产生领域事件或执行请求，不直接修改 `currentMotionInfo`、`pendingNextMtn` 等全局状态。全局状态由运行时上下文和事件总线统一维护。

### 2.3 分离“动作播放”和“状态变更”

动作播放是时间过程；VarFloats、Command 和参数锁是状态副作用。两者必须有明确的开始、更新、完成、取消和失败阶段，不能通过一个 Promise 的副作用隐式连接。

### 2.4 普通动作和 ParamHit 是不同协议

- 普通 HitArea 点击或拖拽动作：根据 `HitArea.Motion` 解析动作引用。
- ParamHit：按 pointerdown、pointermove、pointerup 的协议修改参数，并在边界或释放时触发配置的动作。
- 虚拟 ParamHit：只在没有对应 MOC3 参数时使用内部虚拟值和动作 scrub，不得混入普通参数路径。

## 3. 目标模块结构

本次重构直接迁移交互运行时至 TypeScript。当前已新增 `src/interaction/` 领域层，并由 `main.ts` 通过适配器接入；主入口已完成文件迁移，后续继续进行类型收敛和旧逻辑拆分。Vite 继续负责编译。任何来自 JSON、PixiJS 或 Live2D engine 的动态数据必须在边界处转换为显式 TypeScript 类型；运行时内部不得使用无约束的 `any`。

建议目录：

```text
src/interaction/
  contracts.ts       # interfaces、共享类型和领域事件名称
  events.ts          # TypedEventBus 和事件载荷
  modelGraph.ts      # 规范化 JSON，构造交互图和行为树
  references.ts      # Group/Name/Index 引用解析
  conditions.ts      # VarFloats、Intimacy、PreMtn 条件
  stateStore.ts      # VarFloats、参数值、部件锁和快照
  commandRuntime.ts  # Command/PostCommand 解释器
  motionRuntime.ts   # 文件动作、命令动作和动作生命周期
  interactionRuntime.ts # 统一交互链调度器
  hitAreaInteraction.ts # 普通 HitArea 对象
  paramHitInteraction.ts # ParamHit 和虚拟 ParamHit 对象
  behaviorTree.ts    # BehaviorNode、行为树编译与执行
  modelRuntime.ts    # Live2D 模型对象和模型状态机
  appRuntime.ts      # App 状态机和模型生命周期管理
  assetPreloader.ts  # LPK 解密缓存和模型资源预加载协调
```

`src/main.ts` 只保留 Pixi/Tauri 生命周期、模型挂载、指针事件转发和渲染相关逻辑。

## 4. TypeScript Interface 契约

使用 TypeScript `interface` 作为解耦边界，所有运行时实体使用具体 `class` 实现。点击事件、点击框、模型、动画、动作链和状态机都不能只以普通对象或散落函数存在。

`interface` 只定义协作协议；`class` 保存生命周期、状态和行为。实现采用组合优先的小型类，而不是按模型类型建立深层继承树。业务层只依赖 interface，具体 class 通过构造函数注入 Live2D、Pixi、Tauri 和日志适配器。

### 4.1 `InteractionSource` 和点击交互类

所有能够产生交互的对象实现 `InteractionSource`，并由具体 class 承担 pointer 生命周期：

```text
getId() -> string
canStart(context, pointerEvent) -> boolean
start(context, pointerEvent) -> InteractionSession
```

实现 class：

- `ClickInteraction`
- `DragInteraction`
- `ParamHitInteraction`
- `VirtualParamHitInteraction`
- `KeyTriggerInteraction`
- `ChoiceInteraction`

每个 class 必须拥有自己的 `interactionId`、pointer owner、开始时间、结束原因和当前状态，不能依赖全局布尔变量判断是否正在交互。

### 4.2 `HitBox` 点击框类

```text
class HitBox implements HitBoxPort {
  readonly id: string
  readonly name: string
  readonly order: number
  readonly bounds: HitBoxBounds
  readonly sources: InteractionSource[]

  hitTest(point: ScreenPoint): boolean
  selectSource(context: HitTestContext): InteractionSource | null
  update(bounds: HitBoxBounds): void
  dispose(): void
}
```

`HitBox` 负责稳定边界、当前绘制边界、命中顺序和交互源归属。它不负责播放动画，也不直接修改模型参数。模型隐藏 drawable 后，`HitBox` 可以使用最后一个有效边界，但必须通过 `HitBoxBoundsProvider` 注入，不能在点击类里复制边界回退逻辑。

### 4.3 `PointerEventObject` 点击事件类

```text
class PointerEventObject implements PointerEventPort {
  readonly interactionId: string
  readonly pointerId: number
  readonly type: PointerEventType
  readonly button: number
  readonly position: ScreenPoint
  readonly timestamp: number
  readonly targetHitBoxes: HitBox[]

  claim(owner: InteractionSource): void
  isClaimed(): boolean
  preventTap(): void
  release(): void
}
```

Pixi 的原始事件进入系统后立即包装为 `PointerEventObject`。之后只传递该对象，业务 class 不再依赖 Pixi event 对象。一个事件只能被一个交互源 claim，`pointerupoutside` 和 `pointercancel` 必须结束同一个对象。

### 4.4 `MotionRoute`

所有动作引用实现同一解析和执行协议：

```text
resolve(reference, graph) -> ResolvedMotionRoute
execute(context, route, options) -> MotionHandle
```

它负责区分：

- 组引用：按权重和条件选择一个条目。
- 名称引用：选择指定 `Name`。
- 数字引用：选择指定数组索引。
- 不存在或不可执行的引用：返回结构化失败原因，不触发任何副作用。

### 4.5 `ConditionEvaluator`

```text
evaluateEntry(entry, context) -> EligibilityResult
evaluateVarFloat(condition, state) -> boolean
evaluateIntimacy(condition, state) -> boolean
evaluatePreMotion(condition, history) -> boolean
```

条件求值必须是纯函数；条件失败不能改变变量、参数锁、动作历史或 UI。

### 4.6 `StateEffect`

```text
prepare(effect, context) -> PreparedEffect
commit(effect, context, phase) -> void
rollback(effect, context) -> void
```

用于区分：

- VarFloat `init`、`assign`、`add`。
- `@parameter` 直接参数写入。
- `parameters set`。
- `parameters lock` / `unlock`。
- `parts` 和其他视觉状态命令。

动作开始前准备的副作用必须有回滚路径；动作被拒绝、被替换或模型卸载时，不能留下半完成状态。

### 4.7 `MotionPlayer` 和动画类

```text
load(route) -> Promise<LoadedMotion>
play(loadedMotion, options) -> MotionHandle
cancel(handle, reason) -> void
onStart(handle, callback)
onFinish(handle, callback)
onError(handle, callback)
```

该接口是 Live2D motion manager 的适配层。业务层不直接调用 `currentModel.motion()`，也不读取 engine 内部的 reservation 状态。

具体 class：

- `AnimationAsset`：一个 motion 文件及其声音、循环、淡入淡出和元数据。
- `AnimationInstance`：一次播放实例，保存 `motionId`、开始时间、优先级、播放状态、锁句柄和取消原因。
- `AnimationPlayer`：实现 `MotionPlayer`，管理 `AnimationAsset` 和 `AnimationInstance`。
- `CommandAnimation`：无 `File` 的 command-only 动作，使用同一生命周期但不调用 Live2D motion manager。
- `LayerAnimation`：`Idle#N` 等并行动画层的播放实例。

动画播放和动画资源必须分开建模：资源只加载一次，实例可以多次创建、取消和完成。

### 4.8 `InteractionPolicy`

```text
shouldInterrupt(active, incoming, context) -> boolean
selectCompletionTransition(chain, context) -> Transition | null
selectFallbackIdle(graph, context) -> ResolvedMotionRoute | null
```

它承载优先级、可打断性、Idle 回退和完成链策略，避免把这些规则散落在指针事件中。

### 4.9 `ModelAdapter`

```text
getParameter(id) -> number | undefined
setParameter(id, value) -> void
setParameterLock(id, value, durationMs) -> LockHandle
releaseParameterLock(handle) -> void
hitTest(x, y) -> HitAreaName[]
loadMotion(route) -> Promise<LoadedMotion>
destroy() -> void
```

它隔离 Live2D engine 的内部对象、Pixi 容器和 Cubism parameter API。状态机和行为树不得直接访问 `internalModel`。

### 4.10 `ResourcePreloader`

```text
prepareModel(lpkPath, manifest) -> Promise<ModelAssetBundle>
getAssetUrl(bundle, relativePath) -> string
release(bundle) -> void
```

它隔离 LPK 解密、缓存目录、资源清单和浏览器资源地址。前端不会在 pointer 事件中解密或枚举归档资源。

### 4.11 `RuntimeLogger`

```text
debug(event, context) -> void
info(event, context) -> void
warn(event, context) -> void
error(event, context, error) -> void
```

日志接口必须提供 `appSessionId`、`modelInstanceId`、`chainId`、`motionId` 和事件时间。日志输出通过单一 Tauri bridge 写入后端日志文件。

## 5. 领域对象

### 5.1 `AppRuntime` 和应用状态机

应用状态与单一模型状态分开保存：

```text
AppRuntimeState
  cold
  initializing
  ready
  loading-model
  model-ready
  unloading-model
  failed
  shutting-down
```

`AppRuntime` 负责配置、窗口、输入区域、托盘、模型路径、资源预加载请求、模型实例创建/切换/销毁、全局事件总线和日志实例。它不保存具体模型的 VarFloats、参数锁、当前动作或 HitArea 会话。

### 5.2 `ModelRuntime` 和模型状态机

每次成功加载都创建独立的 `ModelRuntime`，模型切换后旧实例必须销毁：

```text
ModelRuntimeState
  created
  resources-preparing
  graph-building
  initializing
  idle
  interacting
  transitioning
  unloading
  failed
  disposed
```

具体 class：

- `Live2DModelObject`：模型显示对象、Pixi 容器、模型资源和 `ModelAdapter` 的拥有者。
- `ModelStateMachine`：只负责模型状态转换和状态转换合法性。
- `ModelStateStore`：保存 VarFloats、参数值、锁、动作历史和当前快照。
- `ModelRuntime`：组合上述对象，并拥有行为树执行器、交互注册表和模型事件总线。

`ModelRuntime` 封装 `Live2DModelObject`、`ModelStateMachine`、`ModelStateStore`、`ModelInteractionGraph`、`BehaviorTreeExecutor`、`InteractionRegistry` 和模型范围 `TypedEventBus`。应用层只能调用 `modelRuntime.dispatch(inputEvent)`、`modelRuntime.load()`、`modelRuntime.unload()`；不允许直接改写模型内部状态。

### 5.3 `ModelInteractionGraph`

模型加载后由规范化 JSON 构造，包含：

```text
motionGroups: Map<GroupName, MotionEntry[]>
hitAreas: Map<HitAreaName, HitAreaDefinition>
paramHitRules: Map<HitAreaName, ParamHitRule[]>
keyTriggers
paramTriggers
stateDefinitions
completionCandidates
idleGroups
initEntries
```

构造阶段完成字段别名归一化、引用索引、HitArea 顺序索引和动作名称索引。构造阶段不得播放动作或修改模型参数。

### 5.4 `InteractionNode`

每个点击区域对应一个节点，节点只描述声明出来的行为：

```text
id
hitAreaName
order
sources[]
route
paramHitRules[]
```

同一个 HitArea 可以同时拥有普通 Motion 路由和 ParamHit 规则，但调度器必须按文档定义的优先级选择协议，不能通过事件冒泡重复执行。

### 5.5 `InteractionChain`

一次交互链由节点和转换组成：

```text
Idle -> HitArea event -> Option/Action -> File motion
     -> PostCommand -> NextMtn or completion transition -> Idle
```

每个链实例具有唯一 `chainId`、当前节点、当前动作、状态快照和取消原因。所有延迟回调必须携带 `chainId`，旧模型或旧动作的回调不能修改新链。

### 5.6 `MotionSession`

表示一次文件动作或命令动作的生命周期：

```text
created -> eligible -> prepared -> requested -> started
       -> playing -> finished
       -> committed / cancelled / failed
```

命令型动作也使用相同生命周期，但 `requested` 后直接进入 `finished`，不调用 Live2D motion manager。

### 5.7 `BehaviorTree`

模型 JSON 在加载阶段被编译为可执行行为树，而不是在点击时临时猜测分支：

```text
Root
  StartupBranch
    InitNode
    StartOrIdleNode
  InteractionBranch[HitAreaName]
    EligibilityNode
    ParamHitNode | MotionRouteNode
    VarFloatActionNode
    CommandNode
    MotionNode | CommandOnlyNode
    PostCommandNode
    NextMotionNode | CompletionNode | IdleFallbackNode
```

节点接口和具体 class：

```text
BehaviorNode.execute(context) -> Promise<BehaviorResult>
BehaviorNode.cancel(context, reason) -> Promise<void>
```

```text
class BehaviorTree
class BehaviorTreeBuilder
class SequenceNode implements BehaviorNode
class SelectorNode implements BehaviorNode
class ConditionNode implements BehaviorNode
class StateEffectNode implements BehaviorNode
class CommandNode implements BehaviorNode
class AnimationNode implements BehaviorNode
class TransitionNode implements BehaviorNode
class CompletionNode implements BehaviorNode
class IdleFallbackNode implements BehaviorNode
```

树结构由 JSON 字段产生。没有对应字段时不生成该节点；不得通过 `touch_drag`、`mission_complete` 等名称猜测业务节点。

### 5.8 对象组合关系

```text
AppRuntime
  -> AppStateMachine
  -> ResourcePreloader
  -> ModelRuntime[]

ModelRuntime
  -> Live2DModelObject
  -> ModelStateMachine
  -> ModelStateStore
  -> BehaviorTree
  -> HitBox[]
  -> InteractionSource[]
  -> AnimationPlayer
  -> TypedEventBus

HitBox
  -> PointerEventObject
  -> InteractionSource
  -> InteractionChain

InteractionChain
  -> BehaviorNode[]
  -> AnimationInstance[]
  -> StateEffect[]
```

所有拥有资源或订阅的 class 都实现 `Disposable`，模型销毁时按反向组合顺序释放：动画实例、交互会话、行为树订阅、HitBox、模型适配器、资源包。

## 6. 全局事件通知

使用一个模型实例范围的 `EventBus`，而不是多个模块直接互相调用。应用另有一个 `AppEventBus`，用于模型切换、配置变化、窗口事件和资源预加载；模型的 `TypedEventBus` 只传播该模型的交互与状态事件。模型卸载时必须取消所有订阅并关闭其事件总线，防止旧模型回调污染新模型。

### 输入事件

```text
pointer.hit-test
pointer.down
pointer.move
pointer.up
pointer.cancel
key.trigger
choice.selected
```

### 领域事件

```text
interaction.started
interaction.rejected
interaction.cancelled
condition.evaluated
state.changed
state.locked
state.unlocked
motion.requested
motion.started
motion.finished
motion.failed
motion.cancelled
chain.transitioned
chain.completed
chain.failed
idle.selected
model.unloaded
```

事件载荷必须包含 `modelInstanceId`、`chainId`、`interactionId` 和动作引用。调试日志直接由事件订阅器生成，业务代码不再到处拼接日志。

## 7. 模型加载和交互链构造流程

### 阶段 A：资源加载

1. LPK 由 Rust 层解析 manifest，并构造模型资源清单：model JSON、MOC3、纹理、物理、表情、motion、声音和封面。
2. 第一次加载该 LPK 时解密并展开清单中的全部需要资源到版本化缓存目录；缓存键绑定 LPK 路径、大小和修改时间。
3. 缓存完成标记写入后，前端只使用缓存文件 URL，不再按单个请求重新打开或解密 LPK。
4. 二次加载相同版本 LPK 时验证缓存标记和 fingerprint，直接复用资源包。
5. 资源预加载发生在 `resources-preparing` 状态，完成后才创建 Live2D 模型；pointer 事件中禁止资源解密、归档扫描或批量预热。
6. 资源层不负责解释交互。

### 阶段 B：图构造

1. 读取模型 JSON。
2. 规范化大小写和 legacy 字段。
3. 建立 MotionGroup、MotionEntry、HitArea、Controller 索引。
4. 解析所有引用但只保存引用，不提前播放动作。
5. 为每个 HitArea 创建一个或多个 `InteractionSource`。
6. 为每个 ParamHit 创建参数规则对象。
7. 从动作的条件和状态动作中建立状态转换图。
8. 识别 `init` 条目、Idle 组、Layer Idle 组和显式完成候选。
9. 使用已解析的节点构造 `BehaviorTree`，并记录每条边对应的原始 JSON 路径，便于日志和调试。

### 阶段 C：运行时初始化

1. `AppRuntime` 创建新的 `ModelRuntime` 并分配 `modelInstanceId`。
2. 创建 `ModelStateStore`，变量初值为文档规定的默认值。
3. 执行唯一匹配的 command-only `init` 条目。
4. 只执行 init 的 `VarFloats`、Command 和 PostCommand，不播放不存在的 File。
5. 根据 Start 或 Idle 规则创建首条行为链。
6. 初始化模型范围事件订阅、输入区域和 ParamHit 控制器。

### 阶段 D：交互执行

1. Pixi 只将指针事件转换成输入事件。
2. `HitAreaResolver` 根据命中区域和 `Order` 找到候选源。
3. `InteractionSource` 根据协议创建会话。
4. `InteractionChain` 依次执行条件、VarFloats、Command、motion、PostCommand 和 NextMtn。
5. 文件动作结束后由唯一的 `ChainCoordinator` 决定下一个节点。
6. 没有显式 NextMtn 时才执行 Idle fallback；Idle 选择必须重新按当前变量求值。

## 8. 状态和锁的严格规则

### VarFloats

- Type 1 只读，不产生副作用。
- Type 2 在文档规定的动作开始阶段执行。
- `init` 只用于初始化，不等同于普通 `assign`。
- `$name` 读取 StateStore 的变量快照。
- `@name` 读取或写入实际 Cubism 参数。
- `add` 不能被误判为状态完成标记。

### Parameters lock

- `parameters lock <id> <value> [duration]` 只在声明的持续时间内生效。
- `duration=0` 的含义必须由统一命令适配层定义并测试，不能在业务层偷偷改成永久锁。
- 动作被取消或模型卸载时释放会话拥有的锁。
- 不允许用动作名、HitArea 名或特定参数 ID 判断是否应永久锁定。

### 状态机所有权

- App 状态只能由 `AppRuntimeStateMachine` 转换。
- 模型状态只能由 `ModelRuntimeStateMachine` 转换。
- VarFloats、参数锁、部件状态和动作历史只能由 `ModelStateStore` 修改。
- 行为树节点通过 `StateEffect` 请求状态变化；不能直接修改 Live2D core model。
- 任何状态变化都发布 `state.changed` 或 `state.locked` 事件，并写入结构化日志。

### 完成链

- 完成候选来自模型图中的显式完成动作和状态转换图。
- 只有所有声明的状态条件满足时才创建完成转换。
- 完成动作结束后，先执行它的 PostCommand，再按显式 NextMtn，否则进入符合当前状态的 Idle。
- 完成链不自动把状态变量重置为零，除非 JSON 中存在对应的 VarFloat/Command；视觉参数恢复也必须通过 JSON 动作或标准 Idle 曲线完成。

## 9. 迁移步骤

### 前端入口迁移

- [x] 设置窗口入口从 `src/config/main.js` 迁移到 `src/config/main.ts`。
- [x] `config/App.vue` 使用 `<script setup lang="ts">`，为 Tauri 配置、模型信息和导入事件增加显式类型。
- [x] 宠物窗口入口从 `src/main.js` 迁移到 `src/main.ts`，保持兼容运行时行为不变。
- [x] 安装并接入 `typescript` / `vue-tsc`，检查设置窗口和已迁移交互运行时模块。
- [ ] 为 `main.ts` 的 Pixi、Tauri、Live2D 边界补齐类型并纳入完整静态检查。

### 第 1 步：抽离纯模型图和条件层

- [x] 新增 TypeScript 规范化模型图、引用解析、条件和状态存储模块。
- [x] 通过 `ModelRuntime` 将 JSON 定义的点击路由接入旧播放器，保持现有动作副作用顺序。
- 为 VarFloats、引用解析、Idle eligibility 增加纯函数测试。
- [x] 暂时由旧 `playMotion` 作为兼容动作适配器，避免 Command/PostCommand 重复执行。

### 第 2 步：实现资源预加载和模型对象

- [x] Rust 层增加按 LPK fingerprint 管理的资源包准备接口。
- [x] 加载时一次解密并展开模型资源清单，后续虚拟资源请求优先读取缓存。
- [x] 新增 `ResourcePreloader`、`ModelAdapter` 和 `ModelRuntime`。
- [x] 将模型卸载纳入 `AppRuntime` 状态机。

### 第 3 步：抽离 MotionSession 和 CommandRuntime

- [x] 新增 `Live2DCommandRuntime`，通过 `Live2DCommandHost` 隔离 Live2D、Pixi 和应用状态。
- [x] `main.ts` 的模型命令解析改为调用 TypeScript 命令运行时，保留现有命令语义和兼容播放器。
- [ ] 统一文件动作和命令动作生命周期。
- [ ] 接管 `Command`、`PostCommand`、锁和回滚。
- 删除 `pendingNextMtn` 的全局单值设计，改为链实例字段。
- 接入事件总线和结构化日志。

### 第 4 步：实现行为树和 HitArea/ParamHit 对象

- 由 ModelInteractionGraph 编译 Startup、普通 HitArea、ParamHit、Command、NextMtn 和 Idle 节点。
- 将普通点击、拖拽动作、ParamHit、虚拟 ParamHit 分成独立对象。
- 统一 pointer capture、pointerupoutside、pointercancel 和 tap 抑制。
- 确保同一 pointer interaction 只能由一个协议消费。

### 第 5 步：实现 ChainCoordinator 和事件通知

- 从模型图生成交互链。
- 处理 NextMtn、PostCommand、Start、Idle 和完成链。
- 为每个链绑定 modelInstanceId 和 chainId。
- 在模型卸载、动作取消、动作失败时取消旧链。

### 第 6 步：替换 main.ts 旧分支

- `main.ts` 只保留适配和生命周期代码。
- 删除旧的全局动作状态和重复条件判断。
- 保留 stable hit bounds、窗口输入区域等渲染层逻辑，但通过接口读取交互状态。

### 第 7 步：删除兼容性重复实现

- 删除旧的 `triggerDragMotions`、分散式 `playMotion` 分支和完成状态特例。
- 保留必要的 legacy 字段归一化，不保留 legacy 执行路径。

## 10. 测试计划

### 单元测试

- Group、Name、Index 引用解析。
- 条件不满足时无副作用。
- command-only 不调用 motion manager。
- File motion 按 `PostCommand -> NextMtn -> Idle` 顺序执行。
- `NextMtn` 不存在时选择当前状态对应 Idle。
- 锁在持续时间、取消和卸载时正确释放。
- ParamHit 的 LockParam、Release、ReleaseType 和边界动作。
- 虚拟 ParamHit 的 scrub、释放和取消。
- 完成状态只触发一次，状态重置后可以再次触发。

### 模型回归场景

至少使用当前测试 LPK 验证：

1. 启动执行 `init#9:init`，初始进入 `Idle:0`。
2. TouchIdle 改变 `idle` 后，后续动作回到对应 `Idle`。
3. TouchDrag1、2、3 分别完成后状态变量和视觉参数正确。
4. 三只熊完成后只触发一次完成动作，然后回到普通 Idle。
5. TouchIdle26 的显式复位链可以再次允许三只熊交互。
6. 模型卸载后旧动作事件不能修改新模型。
7. 第二次加载同一 LPK 不重复解密展开。
8. 资源准备完成前不能创建交互链；准备完成后交互时不触发 LPK 解密。

### 手工验证

```text
make dev
```

记录事件序列而不是只观察最终画面。至少检查：

```text
interaction.started
motion.requested
motion.started
state.changed
motion.finished
chain.transitioned
idle.selected
```

## 11. 验收标准

- 任意 HitArea 的行为都由模型图构造，不存在当前模型专用的参数 ID、动作名或组名判断。
- 每个 pointer interaction 只有一个 owner，点击、拖拽、ParamHit 不重复触发。
- 所有动作链具有可追踪的 `chainId`，日志能还原完整顺序。
- App 和 Model 各自有可验证的状态机，模型切换不会遗留旧状态或旧事件订阅。
- 模型 JSON 已被编译为行为树；交互发生时只执行行为树节点，不临时猜测链路。
- TypeScript 编译无隐式 `any`，外部引擎调用集中在 ModelAdapter。
- Init、Command、PostCommand、NextMtn、Idle 和 ParamHit 的行为与文档一致。
- 通过当前测试 LPK 的三只熊场景和至少一个普通 ParamHit 模型。
- 每个 LPK 版本只在资源准备阶段解密展开一次；运行时不会因为后台预热或重复解密在模型显示后批量阻塞主线程。
- `main.ts` 不再包含状态机、命令解释、条件求值和具体交互协议的实现细节。
