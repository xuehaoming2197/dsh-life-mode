# dsh-life-mode

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](./INSTALL.md)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4B6EF5.svg)](https://www.deepseek.com/harness/)

A long-conversation layer for [DSH](https://www.deepseek.com/harness/): **a chat mode that manages its own context.**

Four hundred turns in, the session should not slow down, get dumber, or forget what you said
earlier — because it compresses the way people do: "spent most of the afternoon gaming" is
enough, the rest of the afternoon is noise.

---

## Three problems, three pieces

**1. In a long conversation, context only grows.**

Built-in compaction is almost always **prefix-based**: cut a stretch of early history, replace
it with a summary, keep the recent part. That is a compromise — most frameworks can only move
the *start* boundary.

But what actually deserves to go usually sits in the **middle**: an afternoon of repeated
reasoning, dozens of tool calls, dead ends that ended and lead nowhere — yet they sit in the
middle of the conversation where nothing can touch them.

This package gives you `context_fold`: **name a turn range, and only that range is folded.
Everything before and after stays byte-for-byte.**

```
before:  [req] [decisions] [retry][retry][retry] [conclusion] [recent chat]
                          └───── fold this ─────┘

after:   [req] [decisions] [ summary ]           [conclusion] [recent chat]
         └── untouched ──┘                       └─ untouched ─┘
```

**2. Every "AI memory" is a warehouse that only takes in.**

Install a memory plugin, accumulate thousands of observations, then stuff the most relevant
ones into every turn — slower and slower, and half of it is trivia from a year ago.

This memory **forgets**: it decays on an Ebbinghaus curve (half-life 4 days by default), moves
to `archive` after 14 days without being recalled, and compresses a day of chatter into a day
summary once it is long enough. Tiers are `core / active / archive`; archiving is a soft delete
and can always be restored.

**3. Re-telling it who it is, every turn, is burning money.**

Most setups put the personality in a block that gets injected into the conversation every turn.
Over 400 turns that is the same self-introduction 400 times.

Here the personality lives in the **preset prefix** — evaluated once when the session is
created. Per-turn injection only carries what actually changes: a couple of memories that matter
right now, plus a very short style note. Measured: **773 → 241 characters per turn.**

---

## Measured

On a real session (429 turns, memory accumulating as we chatted):

- **241 characters** of dynamic injection per turn (personality never re-injected)
- after `context_fold({fromTurn: 395, toTurn: 415})`, the rebuilt session reads
  `358 … 394 [summary] 416 … 429` — the middle 21 turns became one block, both sides intact
- 633 observations in the graph; recall picks 2 per turn

---

## Install

Send this to your DSH:

```
install this for me: https://github.com/xuehaoming2197/dsh-life-mode
```

DSH will read [`INSTALL.md`](./INSTALL.md) — a procedure written **for an agent**, with a
verification step for every stage and a rollback path. Restart once, then pick "生活模式"
(Life Mode) when creating a session.

Or run it yourself:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1          # dry run
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Apply   # for real
```

**Windows only for now** (PowerShell scripts, Windows paths in YAML). The UI strings are Chinese.

---

## Prior art

We did not invent this idea. Honestly:

- **[pi-midcompact](https://www.npmjs.com/package/pi-midcompact)** (Pi coding agent) is the
  closest: same concept — *mid-context compression*, keeping both sides. The difference is **who
  decides**. It requires human review; only the user can run `/midcompact:commit`. Here the model
  decides and folds on its own. It targets coding work and supports multiple non-contiguous
  regions; we target conversation, one range at a time. Both are valid; they pick a different
  trust model.
- **MemGPT / Letta, Mem0, Zep, A-MEM** all do agent memory, with far more machinery — services,
  vector stores. Our recall score is straight from **Generative Agents** (Park et al., 2023):
  `relevance + importance + recency`, decayed on an Ebbinghaus curve. **That part is not our
  contribution.** The difference is that this memory actually forgets and archives.
- **[What to Keep, What to Forget](https://ar5iv.labs.arxiv.org/html/2607.08032)** points out
  that all fold / prune / rewrite is irreversible — "a detail the policy judged unimportant is
  gone." That is exactly why `context_fold` writes `remember` into the memory graph *before*
  folding.

---

## What it touches

| Location | Change |
|---|---|
| `~/.dsh/life-mode/` | created: code + memory data |
| profile `package.json` | +3 deps, +3 bundle entries (through `plugin_manager`) |
| network | one `npm install @modelcontextprotocol/server-memory`, only if you install the memory layer |

It does **not** touch your session logs, other plugins, `AGENTS.md`, model config, or credentials.
`install.ps1` is a dry run unless you pass `-Apply`. `uninstall.ps1` backs up memory data to
`~/.dsh/life-mode-backups/<timestamp>/` before deleting.

Core features (preset + interval folding) need no network and no memory layer (`-NoMemory`).

---

## Docs

Chinese only, in [`docs/`](./docs):

- `01-design.md` — the three layers and the tradeoffs
- `02-context-folding.md` — how interval folding works, boundary rules, failure modes, repair
- `03-memory.md` — scoring, decay, tiers, day summaries
- `04-pitfalls.md` — every landmine we stepped on

## How this was made

To be explicit about the split: **the human supplied the initial idea and the decisions
along the way. The code was written by DeepSeek.**

The calls that made this what it is — "fold a middle range instead of truncating the
front", "memory has to actually forget", "keep the personality in the prefix instead of
re-injecting it every turn" — came from the human. Wiring the APIs, figuring out the
boundary rules, hitting the failure modes and fixing them, writing the docs and the
installer — that was the model, working inside DSH, turn after turn.

Which is why the code looks grown rather than designed. Every entry in
`docs/04-pitfalls.md` was a wall we actually walked into.

## License

MIT.
