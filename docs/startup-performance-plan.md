# 模型启动性能优化计划

## 现状基线

2026-09-18 的真实启动日志：

```text
resources-ready        3 ms
engine-model-ready  3057 ms
preload-complete     41557 ms
startup total        44620 ms
motions             124 / 124
```

当前模型的缓存目录约包含 24.5 MiB JSON 和 16.3 MiB WAV。LPK 缓存准备不是主要瓶颈；主要耗时来自 124 个 motion 的文件读取、JSON 解析和 Live2D motion 对象创建。

当前实现还存在两个性能特征：

1. `loadModel()` 在 `app.stage.addChild(model)` 前等待全部 motion 完成，导致模型显示和交互都被阻塞。
2. `Promise.all()` 同时发起全部 motion 加载。文件读取可以并发，但 JSON 解析和对象创建仍占用 WebView 主线程，会形成明显的 CPU 峰值和功耗峰值。

## 优化目标

- 温缓存启动不再等待全部 motion。
- 首次点击的关键动作不因首次读取或解析而卡顿。
- 限制同时进行的文件读取、JSON 解析和 Live2D 对象创建数量。
- 模型显示后不持续高 CPU 后台预热。
- 通过日志区分缓存、模型、关键动作和后台动作的耗时。
- 不改变 JSON 行为规则、状态机转移和 `NextMtn`/`PostCommand` 语义。

## 总体策略

采用“关键路径预热 + 有界后台预热 + 按需加载”的三级策略，不再启动时同步加载全部 motion。

### 1. LPK 缓存层

保持一次解密展开到版本化缓存目录的方案，但优化缓存命中判断：

- 首次导入或缓存不存在时，执行完整校验、解密、展开和 `.complete` 标记写入。
- 后续启动优先使用源文件大小、修改时间和缓存索引判断版本，避免每次进程启动都读取整个 LPK 计算 MD5。
- MD5 仅用于创建缓存键或发现元数据变化时的校验，不放在每个启动的关键路径上。
- 缓存索引必须绑定规范化 LPK 路径，并在缓存目录缺少 `.complete` 时视为未完成。
- 保留现有归档路径安全检查、大小限制和原子临时目录替换。

### 2. 动作依赖图

模型加载后根据已解析的 JSON 构建动作依赖图，节点为 `group:index`，边包括：

- `HitAreas[].Motion` 指向的动作。
- `init` 条目和当前可用的 Idle 条目。
- `NextMtn`。
- `Command`、`PostCommand` 中的 `start_mtn`。
- `KeyTrigger`、`ParamTrigger`、`ParamHit` 和其他控制器引用的动作。
- 行为树中的条件分支和选项分支。

依赖图遍历需要复用统一的 motion reference resolver，不能通过字符串猜测绕过模型图。对循环边使用 visited 集合，避免配置错误造成无限遍历。

### 3. 关键动作预热

模型显示前只等待关键动作：

- 唯一匹配的 `init` 链。
- 当前 Idle 状态及其必要的 Idle 回退。
- 所有点击区域直接引用的动作。
- 上述动作可达的 `NextMtn`、`PostCommand` 和 `start_mtn` 目标。

关键动作预热使用有界并发，建议默认并发数为 2，并在批次之间让出事件循环。模型只有在模型核心、纹理和关键动作准备完成后才进入可交互状态。

### 4. 非关键动作后台预热

其余动作不阻塞模型首次显示：

- 通过 `requestIdleCallback`，或使用带延迟的 `setTimeout` 任务队列执行。
- 每批只加载少量动作，批次间检查当前帧耗时和交互状态。
- 用户发生点击、拖拽或参数控制时，暂停后台预热，优先加载交互所需动作。
- 页面隐藏、模型切换或销毁时取消后台任务。
- 后台预热必须使用统一的 `MotionResourceCache`，不能重复创建相同 motion 的加载任务。

### 5. 首次动作请求

`AnimationPlayer` 和 Live2D 适配层增加动作资源状态：

```text
unrequested -> loading -> ready
                       -> failed
```

- `ready` 动作立即播放。
- `loading` 动作复用已有 Promise，不重复读取文件。
- `unrequested` 动作由点击事件触发加载；动作加载期间保留状态机和参数变更顺序。
- 关键动作在交互状态为 `ready` 前不能被点击事件重复提交。
- 加载失败记录 motion、来源、模型实例和错误，但不能破坏模型显示或点击区域。

### 6. 音频策略

motion 文件预热不代表音频已经解码。当前模型的 WAV 资源仍可能在首次播放时通过 `SoundManager.add` 加载。

计划分开处理：

- 关键点击动作的音频只做有限预热，不在启动时解码全部语音。
- 音频预热使用独立缓存和并发上限，避免与 motion 解析同时制造 CPU 峰值。
- 音频加载不能阻塞动作参数更新；必要时先启动 motion，再异步接入声音。
- 静音状态下不预热音频。
- 音频对象释放必须与模型生命周期绑定，避免模型切换后持续占用内存。

## 日志与指标

保留当前分段日志，并扩展以下字段：

- `modelId`、`modelPath`、`modelInstanceId`。
- 缓存状态：`cold`、`warm`、`metadata-hit`、`rebuild`。
- 关键动作数量、后台动作数量、加载失败数量。
- 每批动作的数量、耗时和最大帧间隔。
- 首次点击到动作开始的延迟。
- 音频加载耗时和是否阻塞动作开始。

目标日志示例：

```text
resources-ready cache=metadata-hit elapsedMs=...
engine-model-ready elapsedMs=...
critical-motion-ready requested=... loaded=... elapsedMs=...
startup-load-complete elapsedMs=...
background-motion-batch loaded=... elapsedMs=... frameGapMs=...
motion-first-play latencyMs=...
```

## 实施顺序

1. 引入 `MotionResourceCache`，统一加载任务、状态和取消逻辑。
2. 从模型图构建关键动作依赖闭包，增加循环和缺失引用处理。
3. 将启动阶段从“全部 motion”改为“关键动作闭包”。
4. 增加有界后台预热和交互优先级调度。
5. 优化 LPK 缓存的跨进程快速命中判断，避免每次启动读取完整 LPK 做 MD5。
6. 增加关键音频的独立预热和非阻塞播放策略。
7. 使用同一模型重复启动、冷缓存启动、模型切换和交互中断进行对比测试。

## 验收标准

- 温缓存启动日志不再出现等待 124 个 motion 的长阶段。
- 关键动作首次触发不产生明显可见卡顿；日志中的首次动作延迟可解释。
- 后台预热期间 CPU 不持续满载，交互时能够让出资源。
- LPK 缓存命中时不重新解密、不重新展开、不重复写入资源。
- 模型切换和窗口关闭后，后台加载任务和音频对象都能释放。
- 所有行为状态、动作链、Idle 回退和点击区域语义与当前 JSON 规则保持一致。

