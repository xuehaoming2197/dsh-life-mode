# 踩过的坑

按疼的程度排。每条都写「现象 → 原因 → 怎么绕」。

## 1. 预设是会话创建时冻死的

**现象**：改了 `cordis.patch.yml` 里的人设，重启 DSH，老会话毫无变化。

**原因**：agent 的插件组合在会话创建那一刻就固定了。`agentPresets.select()` 只在第一轮
之前有效，之后换不了。

**绕法**：预设相关的东西（性格、插件清单）改了**必须新开一个会话**。别跟用户说「改好
了刷新一下」——没用。这也是为什么参数要放 `config.json`（每次现读）而不是放预设里。

## 2. `compaction` 服务在某些地方看不见

**现象**：`ctx.get('compaction')` 和 `agent.ctx.get('compaction')` 都返回 `undefined`，
报「压缩服务这会儿不可用」。

**原因**：预设里有一组

```yaml
isolate:
  compaction: true
```

隔离是**对祖先隐藏**——宿主看不见，agent 的 ctx 也看不见。

**绕法**：用 `agentPresets.serviceFor(agent, 'compaction')`，它本来就是拿来跨 scope 取服务的。

```js
function compactionOf(agent) {
  // 四层探：serviceFor → agent.ctx.compaction → agent.ctx.get → 宿主 ctx.get
}
```

四层都探，并且把命中哪一层打进日志。下次它又丢了，一眼能看出是隔离变了还是 API 变了。

## 3. 工具的 `render` 必须是两个参数

**现象**：工具调用成功，返回 `isError: false`，但界面上显示空字符串。看着像「还没接上」。

**原因**：`render(args, value)`。写成 `render(value)` 会拿到第一个参数（就是 args），
返回值莫名其妙的空。

**绕法**：签名永远是 `(_args, value) => …`。写错的话不报错，很阴。

## 4. 同一个 scope 里注册同名 section 会抛

**现象**：`already registered in this scope`。

**原因**：`systemPrompt.section({name, ...})` 返回 disposer，但**没 dispose 就再注册一次**
就炸。而 `agent/pre-step` 是每轮都跑的。

**绕法**：注册结果存在一个按 agent id 索引的注册表里（`globalThis.__xxxRegistry`），
先 dispose 旧的再注册，顺带用文件 mtime 当 `build` 标记，改了代码就重建。

## 5. 工作区的插件文件，热更新根本不生效

**现象**：改完 `index.js`，日志里看不到新行为，重启 DSH 才好。

**原因**：HMR 管的是 client 侧 bundle，宿主侧的工作区插件文件不在它的监听里。

**绕法**：认了。宿主插件改代码 = 重启 DSH。所以别在会话进行中改插件然后骗自己「应该生效了」。

## 6. 会话日志的格式，一个都不能错

**现象**：会话打不开，报

```
SessionFormatError: compaction cannot shadow the protected system head
```

或者 `seq gap N`、`first frame is not exactly one header line`。

**原因**：日志是 zstd **多帧拼接**的。硬约束：

- 第一帧必须**恰好是一行头**，多一个字节都不行
- 事件的 `seq` 必须连续，**不能挖洞**——也就是说不能从中间删事件，只能截断尾部
- `compaction/*` 事件会遮蔽它之前的节点，孤儿事件会让解析器找不到合法的头

**绕法**：见 `02-context-folding.md` 的修复脚本。核心是「截断 + 重写帧结构」，
不是「删掉坏的那几条」。

## 7. `user/message` 事件没有 `turn`

**现象**：想按轮次找位置，结果 `turn` 全是 `undefined`。

**绕法**：`user/message` 的 seq 记下来当 pending，遇到**后面第一条带 `turn` 的事件**
才配对出 `{turn, seq}`。这样得到的 seq 一定落在回合开头。

## 8. 空正文会被系统当成故障

**现象**：模型「想着想着没说话」，正文为空。系统以为出了故障，去催它再说一次，
催出来的话比原来还敷衍。

**绕法**：给模型一条硬规则——**任何一轮必须有正文**，没话可说就回一个括号短语
（好）（嗯）（收到）（……）（睡吧）。这既满足「非空」，又不显得硬要接话。

这条对陪聊类应用是必须的，不是可选的美化。

## 9. 探测工具存不存在，要带 scope

**现象**：明明没注册成功，`tools.get(name)` 却返回了东西；或者反过来。

**绕法**：`tools.get(name, agent.ctx) || tools.get(name)` 两个都试。scoped 注册和全局注册
查法不一样。

## 10. 配置里的相对路径

**现象**：换个机器、换个目录，日志和记忆全写丢了（或者根本没写）。

**绕法**：所有路径通过 `resolvePath(base, file)`：绝对路径原样用，相对路径按
`workspace`（默认 `~/.dsh/life-mode`）解析。数据目录由 `LIFE_MODE_HOME` 覆盖。
安装脚本负责把 YAML 里的占位符换成真实路径。

## 11. 自己写替换消息，必须写全套 compaction 事件

**现象**：会话打不开，报
`SessionFormatError: compaction checkpoint has no matching compaction/start`。

**原因**：自己 append 了一条 `source.kind = 'compact-checkpoint'` 的替换消息，
但没有按顺序写 `compaction/start` → `compaction/summary` → 替换 → `compaction/end`。
会话读取器是个**顺序状态机**：走到检查点消息时，如果当前没有开着的压缩，直接抛。

往日志末尾补一个 `compaction/start` 是**没用的**——状态机早就走过那条检查点了。

**修法**：把那条消息的 `source.kind` 降级成 `user`，替换照旧生效，只是不再被当成压缩检查点。
脚本：[`scripts/fix-orphan-checkpoint.mjs`](../scripts/fix-orphan-checkpoint.mjs)（先诊断，`--apply` 才改，改前备份）。

**教训**：这条路径没有回滚，一次写错就是整条会话读不出来。所以它默认关着
（`allowSelfSummary: false`），要开先在一次性会话里验。

## 教训

最贵的一课是**验证要对拍**：写了个「看起来很科学」的检查（比如按轮次限速），
在边界条件下（压中间段时轮次号不动）完全失效，代码却长得跟正确的一模一样。

后来养成的习惯：**新写的判断逻辑，先拿一个已知答案的输入跑一遍，再信它。**
