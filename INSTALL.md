# 安装说明（写给 AI 看的）

你在给用户装 **dsh-life-mode**：一个 DSH 的插件套装，给长对话用。

这份文件是**操作规程**，不是教程。逐条执行；每一步后面有「验证」，验证不过就停下来按
「失败怎么办」处理。**不要猜、不要跳步、不要顺手改别的文件。**

用户的原话大概率是「帮我装 <这个仓库的链接>」。你按下面走完，回来告诉他重启一下。

---

## 0. 动手前先确认

- 用户在 **Windows** 上跑 DSH 桌面版（目前只支持 Windows，脚本是 PowerShell）
- `~/.dsh/profiles/` 下面至少有一个带 `package.json` 的 profile
- 用户知道三件事：会装三个本地 bundle、会多一个记忆 MCP 进程、装完要重启一次 DSH

如果用户不想装记忆层，后面所有步骤都加 `-NoMemory`，并且跳过第 4 步里 memory-mcp 那一条。

---

## 1. 拿到代码

用户直接给了本地路径就用那个路径。否则：

```powershell
git clone https://github.com/<owner>/dsh-life-mode.git "$env:USERPROFILE\dsh-life-mode"
```

没有 git 就用别的方式拿到目录。下文用 `<repo>` 指这个目录。

**验证**：`<repo>\bundles\life-context\index.js` 存在。

---

## 2. 干跑一次（不改任何东西）

```powershell
powershell -ExecutionPolicy Bypass -File "<repo>\scripts\install.ps1"
```

**验证**：输出里没有以 `[x]` 开头的行，末尾列出了 `1)` 到 `4)` 四步 `plugin_manager` 调用。

**失败怎么办**：把 `[x]` 那几行原样贴给用户，**停下**。脚本没写任何东西，机器状态没变。
常见原因：DSH 没装过、找不到 node、源码目录不对。

---

## 3. 真装

```powershell
powershell -ExecutionPolicy Bypass -File "<repo>\scripts\install.ps1" -Apply
```

（跳过记忆层就加 `-NoMemory`。）

**验证**：输出里出现这三行中的至少前两行——

```
[ok] 代码已拷好
[ok] 占位符已替换
[ok] 记忆层就位              ← 只有装了记忆层才有
[ok] config.json 已指向新目录  ← 只有装了记忆层才有
```

**失败怎么办**：如果是 `npm install 失败`，说明网络不通。核心功能（预设 + 上下文压缩）
**不需要**记忆层，可以让用户重跑一次 `-NoMemory`，或者你直接把命令换成带 `-NoMemory` 的再跑。

这一步做了什么：把仓库拷到 `~/.dsh/life-mode`，把 YAML 里的 `@NODE@` / `@HOME@`
换成真实路径，在 `~/.dsh/life-mode/memory` 里装官方 `@modelcontextprotocol/server-memory`。
**没有碰 DSH 的 profile 配置。**

---

## 4. 注册三个 bundle

用 DSH 自己的 `plugin_manager`，**不要手改 `package.json`**。

把 `@HOME@` 换成 `%USERPROFILE%\.dsh\life-mode` 的实际路径（正斜杠更稳）：

```js
plugin_manager({ action: 'install_bundle', target: 'link:C:/Users/<你>/.dsh/life-mode/bundles/life-preset' })
plugin_manager({ action: 'install_bundle', target: 'link:C:/Users/<你>/.dsh/life-mode/bundles/life-context' })
plugin_manager({ action: 'install_bundle', target: 'link:C:/Users/<你>/.dsh/life-mode/bundles/memory-mcp' })   // 跳过了记忆层就别装这条
```

**验证**：

```js
plugin_manager({ action: 'list_bundles' })
```

三个包都要是 `installed: true`、`enabled: true`：`dsh-life-mode-preset`、`dsh-life-mode-context`、
`dsh-life-mode-memory`。

**失败怎么办**（这一步是整套流程里最没把握的一步，卡住不奇怪）：

- 如果 `link:` 规格被拒 → 改成传纯绝对路径（`C:/Users/.../bundles/life-preset`）再试一次。
- 如果提示找不到那个包 → 说明 `install.ps1` 没真正跑成功，回第 3 步检查那几行 `[ok]`。
- 如果 `enabled` 是 `false` → 用第 5 步打开。
- 如果报版本不满足（`engines.dsh`）→ **不要**去开版本豁免，直接告诉用户版本对不上、停下。
- 以上都不行 → 停下。把 `list_bundles` 里这三个包的**原始条目**贴给用户看，
  **不要**自己手改 `package.json` 去硬凑。

---

## 5. 确认已启用

```js
plugin_manager({ action: 'set_bundle', target: 'dsh-life-mode-preset',  enabled: true })
plugin_manager({ action: 'set_bundle', target: 'dsh-life-mode-context', enabled: true })
plugin_manager({ action: 'set_bundle', target: 'dsh-life-mode-memory',  enabled: true })   // 没装就跳过
```

**验证**：再 `list_bundles` 一次，三个都 `enabled: true`。

---

## 6. 重启 DSH

**告诉用户重启 DSH。** 预设是在会话创建时冻结的，不重启的话「生活模式」不会出现在
新建会话的选项里。

重启后验证（让用户新建一个会话，选「生活模式」）：

- 回一句话，应该是**短句口语**，不是条目、不是总结
- 说「看看上下文」，应该能调出 `context_map` 而不是报工具不存在

两句都对，装好了。

---

## 装完告诉用户什么

一两句就够，别写成报告：

- 新建会话时能选「生活模式」了
- 想换性格，改 `~/.dsh/life-mode/bundles/life-preset/cordis.patch.yml` 里的 `prefix:`
- 不想要记忆层：重装时加 `-NoMemory`
- 后悔了：跑 `scripts\uninstall.ps1 -Apply`，记忆数据会备份到 `~/.dsh/life-mode-backups/`

---

## 绝对不能做的事

- **不要手改** `bundles/memory-mcp/cordis.patch.yml` 里的 `@NODE@` / `@HOME@`。它们由脚本替换。
- **不要手改** profile 的 `package.json`。那是 `plugin_manager` 的活。
- **不要把预设 id `life` 改成别的**。`life-context` 靠它认人（`config.json` 的 `presets`）。
- **不要开版本豁免**去强行装一个版本不满足的包。
- **不要**在没有备份的情况下删 `~/.dsh/life-mode/memory/`。

---

## 回滚

```powershell
powershell -ExecutionPolicy Bypass -File "<repo>\scripts\uninstall.ps1"          # 干跑
powershell -ExecutionPolicy Bypass -File "<repo>\scripts\uninstall.ps1" -Apply   # 真删
```

它会摘掉 profile 里的三个 bundle 登记（先备份 `package.json`），把 `memory/` 挪到
`~/.dsh/life-mode-backups/<时间戳>/`，再删安装目录。然后重启 DSH。

如果连脚本都跑不了（DSH 起不来、PowerShell 坏了），另有三条手工路：

1. 用记事本打开 `~/.dsh/profiles/<name>/package.json`，把 `dsh-life-mode-*` 三个
   依赖和 `dsh.profile.bundles` 里对应三项删掉
2. 删掉 `~/.dsh/life-mode` 目录
3. 重新打开 DSH

---

## 它会改你哪些东西

| 位置 | 改什么 | 能不能撤回 |
|---|---|---|
| `~/.dsh/life-mode/` | 新建，装代码和记忆数据 | 删掉即可 |
| profile 的 `package.json` | 加三个依赖和三条 bundles 登记 | `uninstall.ps1` 或 `remove_bundle` |
| `~/.dsh/life-mode-backups/` | 卸载时才建，放备份 | 自己删 |
| 网络 | 只在 `npm install @modelcontextprotocol/server-memory` 时联网 | — |

**它不碰**：你的会话记录、别的插件、`AGENTS.md`、模型配置、账号凭据。
