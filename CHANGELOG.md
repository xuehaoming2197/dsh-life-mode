# 变更

## 未发布

- **一次压多段**：`context_fold({ranges: [{fromTurn, toTurn}, …]})`，最多 8 段，段与段可以不相邻。
  重叠或相邻的自动并成一段；从后往前压，每压一段都重取 session 重算边界。
  任意一段被拒就整轮收手（`compactRegion` 失败不回滚，继续写只会更糟），
  结果里逐段说明哪几段压了、哪几段没动。
- 单段的老用法 `context_fold({fromTurn, toTurn})` 行为完全不变。

## 0.2.0 — 2026-11-19

首个公开版本。

- **生活模式预设**：性格写在预设前缀里，每轮只算一次；默认不动工具；空正文用括号短语兜底。
- **区间压缩**：`context_map` 看自己在哪一段，`context_fold({fromTurn, toTurn})` 只压中间一段，
  两侧原样保留。
- **选择性记忆**：按 Generative Agents 那套 `相关度 + 重要性 + 强度` 打分召回，艾宾浩斯曲线衰减，
  core / active / archive 三层，日流水攒够了自己压成日摘要。
- **安装**：`install.ps1` 幂等、默认干跑；注册走 `plugin_manager`；`uninstall.ps1` 带备份。
- 路径全部参数化，`LIFE_MODE_HOME` 可改数据目录。
