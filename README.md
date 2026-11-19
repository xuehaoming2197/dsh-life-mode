# dsh-life-mode

给 [DSH](https://www.deepseek.com/harness/) 的长对话层：**会自己管上下文的聊天模式。**

聊到三四百轮，会话不会突然变卡、变笨、忘记前面说过什么——因为它会像人一样，
把「下午玩得比较多」这种话压出来，把没用的细节丢掉，把要紧的记住。

---

## 三个问题，三个东西

**一、长对话里，上下文只会越堆越重。**

内置压缩基本都是**前缀式**：截掉一整段早期的历史，压成一份摘要，后面留着。这是一种
妥协——因为大部分框架只能改「从哪往后」的边界。

可现实里真正该压的往往在**中间**：一个下午的重复思考、几十次工具调用、试了又试的
死路，它们结束了、没后续价值了，却横在对话正中间谁也动不了。

这个包给你 `context_fold`：**指定轮次区间，只压那一段，前面和后面一个字都不动。**

```
压之前：  [需求] [决策] [试错][试错][试错] [结论] [最近在聊]
                     └──── 该压的在这 ────┘

压之后：  [需求] [决策] [ 一段摘要 ]        [结论] [最近在聊]
          └──── 原样 ────┘                 └── 原样 ──┘
```

**二、AI 记忆都是只进不出的仓库。**

装个记忆插件，攒几千条观察，然后每轮往里塞最相关的一堆，越塞越慢，塞的还是三年前的
废话。

这个包的记忆会**忘**：按艾宾浩斯曲线衰减（默认 4 天减半），14 天没被想起来就归档，
一天流水攒够了自己压成「日摘要」。分层是 core / active / archive，归档是软删，随时能翻回来。

**三、每轮重新告诉它「你是谁」，是在烧钱。**

大多数方案把性格写成一段每轮都注进对话的文本。聊 400 轮，就是同一个自我介绍说了 400 遍。

这个包把性格写进**预设前缀**——它只在会话开头算一次。每轮的动态注入只留真正会变的东西：
这一轮用得上的几条记忆，加上一条很短的写作风格。实测从每轮 773 字降到 241 字。

---

## 实测

在一个真实会话上（429 轮，边聊边攒记忆）：

- 每轮动态注入 **241 字**（性格完全不重复注入）
- `context_fold({fromTurn: 395, toTurn: 415})` 之后，重建会话看到的是
  `358 … 394 [摘要] 416 … 429` —— 中间 21 轮变成一段，两侧完整
- 记忆图谱 633 条观察，召回时只挑 2 条，还给每轮带去上下文

---

## 装

把这行发给你的 DSH：

```
帮我装：https://github.com/xuehaoming2197/dsh-life-mode
```

DSH 会读仓库里的 [`INSTALL.md`](./INSTALL.md)——那是写给 AI 的规程，带逐步验证和回滚。
装完重启一次，新建会话时就能选「生活模式」。

不想让 AI 动手，自己跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1          # 干跑，什么都不改
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Apply   # 真装
```

**目前只支持 Windows**（脚本是 PowerShell，YAML 里的路径是 Windows 形式）。

---

## 和类似项目的关系

这条思路不是我们首创的，诚实地列一下：

- **[pi-midcompact](https://www.npmjs.com/package/pi-midcompact)**（Pi coding agent 生态）
  是离得最近的一个，做的是同一件事——「上下文中段压缩」，两侧保留原文。区别在**谁决定**：
  它要求人工审查、人跑 `/midcompact:commit`，agent 无权提交；我们是让模型自己判断、自己压。
  它面向编码任务、支持多个不连续区段；我们面向聊天、一次一个区间。两条路都成立，选的信任模型不同。
- **MemGPT / Letta、Mem0、Zep、A-MEM** 都在做 agent 记忆，工程比我们重得多，要服务、要向量库。
  我们的记忆打分直接沿用了 **Generative Agents**（Park et al., 2023）的
  `相关度 + 重要性 + 时间衰减`，衰减曲线用艾宾浩斯。这部分**不是我们的贡献**，
  差异只在于我们真的会淡忘、会归档，而不是只进不出。
- **[What to Keep, What to Forget](https://ar5iv.labs.arxiv.org/html/2607.08032)** 指出所有
  fold / prune / rewrite 都不可逆，"策略觉得不重要的细节就永远没了"。这正是 `context_fold`
  会先把 `remember` 写进记忆图谱、再压的原因——**先记后忘**。

---

## 它会改你什么

| 位置 | 改什么 |
|---|---|
| `~/.dsh/life-mode/` | 新建，装代码 + 记忆数据 |
| profile 的 `package.json` | 加 3 个依赖 + 3 条 bundles 登记，走 `plugin_manager` |
| 网络 | 只有装记忆层时 `npm install @modelcontextprotocol/server-memory` 一次 |

**不碰**：你的会话记录、别的插件、`AGENTS.md`、模型配置、账号凭据。

安装脚本默认**干跑**，`-Apply` 才写盘；`uninstall.ps1` 会把记忆备份到
`~/.dsh/life-mode-backups/<时间戳>/` 再删。核心功能（预设 + 区间压缩）不需要联网，也不需要记忆层
（`-NoMemory`）。

---

## 配置

`~/.dsh/life-mode/bundles/life-context/config.json`，改完立刻生效，**不用换对话**。

| 键 | 默认 | 作用 |
|---|---|---|
| `presets` | `["life"]` | 这套上下文挂给哪些预设；写 `["*"]` 就是所有会话都挂 |
| `allowFold` | `true` | 关掉就只剩 `context_map`，工具表里连 `context_fold` 都不出现 |
| `k` | `2` | 每轮注入几条记忆 |
| `maxChars` | `260` | 注入内容的总字数上限 |
| `halfLifeDays` | `4` | 记忆强度减半的天数 |
| `minRel` | `0.06` | 相关度低于这个就不注入 |
| `foldSegmentTurns` | `10` | `context_map` 按多少轮一段来分段 |
| `foldCooldownMinutes` | `5` | 两次压缩之间至少隔多久 |
| `injectMemory` | `true` | 没有记忆层时设 `false` |

性格在 `bundles/life-preset/cordis.patch.yml` 的 `prefix:` —— 改它就能换形象，别处不用动。

---

## 目录

```
bundles/life-preset/    生活模式预设：性格写在 prefix 里
bundles/life-context/   上下文层：注入 + context_map / context_fold
bundles/memory-mcp/     记忆层：官方 memory MCP（写）+ 自带索引 MCP（召回）
persona/life-style.md   每轮注入的写作风格，短
scripts/                install / uninstall（默认干跑）
docs/                   设计、压缩、记忆、踩过的坑
INSTALL.md              给 AI 的安装规程
```

---

## 已知限制

- 只支持 Windows，且只在 DSH `0.2.1-rc.3` 上验证过
- 这套代码在一个跑了 429 轮的会话上长期运行，`install.ps1` 也实测过干跑和临时目录真装；
  但**没有在一台全新机器上从零复现过完整安装流程**。第一次装遇到问题请提 issue
- `compactRegion` 失败时**不回滚**，会在会话日志里留孤儿事件，把会话搞成读不出来的样子。
  所以 `context_fold` 只试一次，失败就停手。真坏了用 `scripts/repair-session-log.mjs` 修，
  细节见 [`docs/02-context-folding.md`](./docs/02-context-folding.md)
- 一次只能压一个连续区间，不支持 pi-midcompact 那种多个不连续区段 + 保留洞
- 记忆层依赖官方的 `@modelcontextprotocol/server-memory` 来写图谱，没自己实现写入

---

## License

MIT。用出问题自己担，但来提 issue 我会看。
