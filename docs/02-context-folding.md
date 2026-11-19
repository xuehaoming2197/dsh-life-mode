# 区间压缩：怎么压中间那一段

## 为什么前缀压缩不够

DSH 内置的压缩（以及绝大多数框架）只有一个可动的边界：「从最早压到什么时候」。它能
解决「上下文满了」，解决不了「中间这一段已经没用了，但后面还有用」。

真实长对话里，值得丢的东西很少在开头。开头通常是最重要的需求；结尾是正在聊的事。
脏东西堆在中间——重复思考、失败的尝试、几十次工具调用。

## 三个边界规则（都是试出来的）

`compactRegion(start, end, agent, signal)` 不接受任意位置。踩完之后这三条是硬规则：

| 规则 | 报错 | 原因 |
|---|---|---|
| `end` 必须是 surface 上的节点 | `end seq N not found in surface` | 它在 surface 里找这个位置 |
| `end` 必须落在**回合开头** | `end seq N is not a balanced boundary` | 劈开一个回合会破坏消息结构 |
| `start` 不能是 `nodes[0]` | `node 0 holds the system prompt…` | 第一个节点持有 system prompt，只有特定服务能改 |

### 回合开头怎么找

`user/message` 事件在会话日志里**没有 `turn` 字段**，轮次号是后来才有的。所以不能直接
按 turn 查 seq，要配对：

```js
// 每个 user/message 的 seq，配上它后面第一个带 turn 的事件
function turnBoundaries(session) {
  // 扫事件，遇到 user/message 记下 seq 当 pending，
  // 遇到第一条带 turn 的事件就把 {turn, seq: pending} 收下
}
```

拿到的 `{turn, seq}` 里，`seq` 一定是一个回合的开头——按它下刀，工具调用和它的结果
天然不会被劈开（它们是同一个回合内部的东西）。这条约束不用额外检查，结构上就满足了。

## 最要命的一点：失败不回滚

`compactRegion` 的执行顺序是**先写后校验**：

```
写 compaction/start  →  调模型生成摘要（约 15 秒）  →  写 compaction/summary
                                                          ↓
                                                     然后才检查 end 合不合法
                                                          ↓
                                                     不合法 → 抛错
```

**抛错时前面那两条事件已经落盘了。** 如果这次调用命中了「end 不在 surface」或
「不是回合边界」，会话里就会多出一组孤儿 `compaction/start` + `compaction/summary`，
数量一多，会话直接读不出来：

```
SessionFormatError: compaction cannot shadow the protected system head
```

这就是 `context_fold` **只试一次**的原因。绝不搞「这个边界不行换下一个」的候选循环——
每试一次就可能往用户的主会话里写一组垃圾。

```js
// 只挑一个 start、一个 end，直接调，失败就收手
const startEntry = usable.find((b) => wantFrom === null || b.turn >= wantFrom)
const endEntry   = usable.find((b) => b.turn > toLine)
```

## 先记后忘

压掉的那段就没了，逐字内容找不回来。所以 `context_fold` 支持 `remember`：

1. 先把要点写进记忆图谱（`create_entities` + `add_observations`）
2. 写失败 → 直接返回，**不压**
3. 写成功 → 才动 `compactRegion`

宁可这次不压，也不能压掉找不回来的东西。

## 一次压多段

`compactRegion` 一次只处理一个区间，所以「多段」只能**一段一段调**。这带来三个必须处理的事：

**顺序从后往前。** 先压靠后的段。压前一段不会动到后一段的边界，反过来不敢保证——
而且每压完一段 `surface` 就变了，旧边界立刻作废，必须重取 session 重算：

```js
// 每段进来都重新拿一次，不能用循环外那份
const session = deps.sessionOf(agent)
const bounds = turnBoundaries(session)
```

**重叠和相邻的合并。** `[{10,20}, {25,30}, {21,24}]` 会并成 `[{10,30}]`——
21-24 和 25-30 本来就连着，拆两段压没意义，还多一次失败机会。
真正留缝的（`{10,20}` + `{26,30}`）才保持两段。

**一段失败，整轮收手。** 不是「跳过这段继续下一段」。因为 `compactRegion` 失败不回滚、
会留孤儿事件，这时候再往会话上写，等于把一个还能救的会话往死里推。
失败那段之后的都不再尝试，结果里如实列出哪几段压了、哪几段没动。

## 冷却按时间算，不按轮次

一开始的限速是「距上次压缩至少隔 N 轮」。这个判断在压中间段时是坏的：**压中间段不会
让轮次号往前走**。压完 120-180，你还在第 400 轮，第二次调用会被永久卡住。

改成按时间：默认 5 分钟。

## 压完怎么确认

`session.surface.nodes` 就是模型实际看到的节点列表。压完重建一次，看轮次有没有断：

```
压之前： 358 359 … 394 395 … 415 416 … 429
压之后： 358 359 … 394 [摘要] 416 … 429
                └ 原样 ┘        └ 原样 ┘
```

断口正好是 `fromTurn` 和 `toTurn + 1` 之间，两侧完整，就是对的。

## 真坏了怎么办

`scripts/repair-session-log.mjs`：

```powershell
node .\scripts\repair-session-log.mjs --file <会话日志> --dry   # 先看
node .\scripts\repair-session-log.mjs --file <会话日志>          # 真修（会先备份）
```

它做的事：找到第一组孤儿 `compaction/*`，把日志**截断**到它前面的 `turn/end`，然后把
zstd 重写成「一帧是头，其余一帧一条事件」的格式。

两个硬约束，改这个脚本之前先知道：

- **不能删事件**。事件的 `seq` 必须连续，中间挖掉一条就会 `seq gap`。
  只能截断（丢掉尾部的），不能从中间抽。
- **第一帧必须恰好是一行头**。多一行少一行都会 `first frame is not exactly one header line`。

代价是：截断点之后的事件全丢。所以修之前一定 `--dry` 看清丢多少。
