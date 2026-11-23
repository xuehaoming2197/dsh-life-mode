# 变更

## 未发布

- **可以自己写摘要**：`context_fold({..., summary: "一句话"})` 不跑模型，直接把该段换成你给的话。
  默认摘要要重读整段原文，这个模式省掉那次调用；代价是没有八段结构，全靠你写。
  区间里工具调用不配对会直接拒绝（不配对就替换，会话会坏）。
  需要 `allowSelfSummary: true` 打开——它自己写 compaction 事件，漏一环整条会话就读不出来了。
- **边界只认 surface**：`turnBoundaries` 里那些被压过的回合边界不在 surface 上了，
  拿它当 `end` 会被拒（not found in surface），拿它当替换边界更糟。现在只挑还在 surface 上的。
- 新增 `scripts/check-session-order.mjs` 和 `scripts/fix-orphan-checkpoint.mjs`：
  前者在写自定义事件后验顺序，后者修「检查点没有对应 start」的坏会话。
- **压缩工具可以铺到所有会话，不再只限生活模式**。新增 `toolPresets`：谁拿
  `context_map` / `context_fold`；不填就跟 `presets` 一样。
  这样能只给工具、不注入陪聊口吻——把「没话说就回（嗯）」铺到写代码的会话上显然不合适。
- `presets` 的含义收窄成「谁算陪聊」：输出铁律 + 风格 + 记忆注入。

## 0.3.0 — 2026-11-19

- **一次压多段**：`context_fold({ranges: [{fromTurn, toTurn}, …]})`，最多 8 段，段与段可以不相邻。
  重叠或相邻的自动并成一段；从后往前压，每压一段都重取 session 重算边界。
  任意一段被拒就整轮收手（`compactRegion` 失败不回滚，继续写只会更糟），
  结果里逐段说明哪几段压了、哪几段没动。
- 单段的老用法 `context_fold({fromTurn, toTurn})` 行为完全不变。
- **首个在干净机器上跑通的完整安装**：Win10 20H2 + DSH `0.2.1-rc.3`，无 git / 无 node 的机器，
  从 zip 下载到重启后用上「生活模式」。`plugin_manager` 的 `link:` 规格确认可用。
- 文档补上没装 git 时用 zip 下载的具体做法。

## 0.2.0 — 2026-11-19

首个公开版本。

- **生活模式预设**：性格写在预设前缀里，每轮只算一次；默认不动工具；空正文用括号短语兜底。
- **区间压缩**：`context_map` 看自己在哪一段，`context_fold({fromTurn, toTurn})` 只压中间一段，
  两侧原样保留。
- **选择性记忆**：按 Generative Agents 那套 `相关度 + 重要性 + 强度` 打分召回，艾宾浩斯曲线衰减，
  core / active / archive 三层，日流水攒够了自己压成日摘要。
- **安装**：`install.ps1` 幂等、默认干跑；注册走 `plugin_manager`；`uninstall.ps1` 带备份。
- 路径全部参数化，`LIFE_MODE_HOME` 可改数据目录。
