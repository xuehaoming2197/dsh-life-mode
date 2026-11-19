# 给 agent 的说明

这个仓库是 **dsh-life-mode**：一个给 DSH 用的插件套装（生活模式预设 + 上下文区间压缩 + 会遗忘的记忆）。

- 用户让你「装这个」→ 打开 [`INSTALL.md`](./INSTALL.md)，**按它的步骤走**。那是规程，每步都带验证。
- 用户想改东西 / 提 issue → 先看 [`docs/`](./docs)，里面写了设计取舍和踩过的坑。
- **不要**直接改 `bundles/memory-mcp/cordis.patch.yml` 里的 `@NODE@` / `@HOME@` 占位符。
- **不要**手改用户的 profile `package.json`，注册 bundle 用 `plugin_manager`。

一句话：装它靠 `INSTALL.md`，懂它靠 `docs/`，别自由发挥。
