/**
 * life-context：生活模式的专属上下文。
 *
 * 每轮（仅当会话 preset 是 life）：
 *   1. 读 persona/life-style.md —— 性格文件，改了立刻生效；
 *   2. 从记忆图谱里按相关度 + 遗忘曲线挑几条，做成摘要帧；
 *   3. 拼成一条 <system-reminder> 插在本轮用户消息后面。
 *
 * 参数全部在 config.json，每次现读，不缓存 —— 改参数不用换对话。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/*
 * 数据目录：默认 ~/.dsh/life-mode。
 * 用 LIFE_MODE_HOME 可以改到别处（多份配置、测试、放别的盘）。
 * 安装脚本把 persona/ 和 memory/ 都放在这里，所以换机器只要改这一个前缀。
 */
const HOME = process.env.LIFE_MODE_HOME || path.join(os.homedir(), '.dsh', 'life-mode')
const MEMORY_DIR = path.join(HOME, 'memory')

const DEFAULTS = {
  k: 2,
  maxChars: 260,
  maxFrameChars: 60,
  halfLifeDays: 4,
  minRel: 0.06,
  styleFile: 'persona/life-style.md',
  injectStyle: true,
  injectMemory: true,
  foldSegmentTurns: 10,
  foldMinTurns: 20,
  log: path.join(HOME, 'life-context.log'),
  workspace: HOME,
  graph: path.join(MEMORY_DIR, 'memory.jsonl'),
  meta: path.join(MEMORY_DIR, 'meta.jsonl'),
  /* 这套上下文挂给哪些预设。默认只给 life；写 ['*'] 就是所有会话都用 */
  presets: ['life'],
  /* false = 只给 context_map（看得见但不下压），不把 context_fold 交给模型 */
  allowFold: true,
  /*
   * 自写摘要（context_fold 的 summary 参数）要不要开。
   * 默认关：这条路径自己写 compaction 事件，写错了整条会话读不出来，还没回滚。
   * 验过再开。
   */
  allowSelfSummary: false,
}

const PUNCT = /[\s\u3000，。、；：！？,.;:!?（）()\[\]【】「」『』“”"'`~～!！?？…—\-·<>《》|]+/g

function normalizeText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(PUNCT, '')
}

function obsKey(entity, text) {
  return crypto.createHash('sha256').update(`${entity}\u0000${normalizeText(text)}`, 'utf8').digest('hex').slice(0, 16)
}

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function loadMeta(file) {
  const map = new Map()
  for (const line of readLines(file)) {
    try {
      const row = JSON.parse(line)
      if (row && row.key) map.set(row.key, row)
    } catch {}
  }
  return map
}

function loadDocs(cfg) {
  const meta = loadMeta(cfg.meta)
  const docs = []
  for (const line of readLines(cfg.graph)) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!row || row.type !== 'entity' || !Array.isArray(row.observations)) continue
    // 人设/成长这两份已经在系统提示里，别重复召回
    if (/人设|成长/.test(row.name)) continue
    for (const text of row.observations) {
      if (!text || typeof text !== 'string') continue
      // 超长的多半是文档/快照，不是"一帧"，不参与召回
      if (text.length > 300) continue
      const m = meta.get(obsKey(row.name, text)) || {}
      docs.push({
        entity: row.name,
        text,
        importance: typeof m.importance === 'number' ? m.importance : 1,
        pinned: Boolean(m.pinned),
        tier: m.tier || 'active',
        createdAt: m.createdAt || '',
        lastUsedAt: m.lastUsedAt || m.createdAt || '',
      })
    }
  }
  return docs
}

function bigrams(text) {
  const s = normalizeText(text)
  const set = new Set()
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
  return set
}

function relevance(queryGrams, text) {
  if (!queryGrams.size) return 0
  const g = bigrams(text)
  if (!g.size) return 0
  let hit = 0
  for (const gram of g) if (queryGrams.has(gram)) hit++
  return hit / queryGrams.size
}

function strengthOf(doc, cfg, now) {
  if (doc.pinned) return 1
  const stamp = Date.parse(doc.lastUsedAt || doc.createdAt || '')
  if (!Number.isFinite(stamp)) return 0.5
  const days = Math.max(0, (now - stamp) / 86400000)
  const halfLife = cfg.halfLifeDays * (1 + Math.max(0, doc.importance || 0))
  return Math.exp(-days / halfLife)
}

/**
 * 挑这轮要想起来的几件事。
 *
 * 关键一条：字面相关度为零的一律不召回——「想的时候才出来」。
 * 以前是 minScore 兜底，importance 够高就能每轮硬塞，这正是用户说的
 * "每轮把 .md 摊开看一眼"的同一种浪费。
 */
function pick(docs, query, cfg) {
  const now = Date.now()
  const q = bigrams(query)
  const minRel = cfg.minRel ?? 0.06
  const scored = []
  for (const doc of docs) {
    if (doc.tier === 'archive') continue
    const rel = relevance(q, `${doc.entity} ${doc.text}`)
    if (rel < minRel) continue
    const str = strengthOf(doc, cfg, now)
    const imp = (doc.importance || 0) / 5
    const score = 0.6 * rel + 0.25 * imp + 0.15 * str
    scored.push({ ...doc, score, rel, str })
  }
  scored.sort((a, b) => b.score - a.score)

  // 先让"关于你"的那一区占一席，再从其余里补
  const profileNames = Array.isArray(cfg.profileEntities) ? cfg.profileEntities : []
  const picked = []
  for (const doc of scored) {
    if (picked.length >= (cfg.profileK || 1)) break
    if (profileNames.includes(doc.entity)) picked.push(doc)
  }
  for (const doc of scored) {
    if (picked.length >= (cfg.k || 2)) break
    if (!picked.includes(doc)) picked.push(doc)
  }
  return picked
}

function tagOf(doc) {
  if (!doc.createdAt) return ''
  const d = new Date(doc.createdAt)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 一行流水：这一轮对方说了什么，留个大概。
 *
 * 以前是拿正则去猜"这句话值不值得记"，结果几乎从不命中，流水常年 0 条。
 * 人不是这么记事的——先把日子过成流水，值不值得留交给后面的日摘要和遗忘曲线。
 */
const PURE_NOISE =
  /^(嗯+|哦+|嗷+|好|好的|行|可以|收到|在吗|在不在|在|哈+|呵+|嘿+|草|6+|\.{2,}|…+|[?？!！~～。，,、\s]+)$/

/*
 * QQ 桥在入站消息前面加一行「（时间 · QQ号：…（角色） 昵称）」。
 * 注意里面有嵌套括号（角色那层），所以不能用 [^）] 截断——要匹配到整行末尾的 ）。
 */
const BRIDGE_STAMP = /^（(?=[^\n]*(?:QQ号|收到这条消息))[^\n]*）[ \t]*\n/

function flowLine(text) {
  /*
   * 顺序要紧：先剥路由头，再压空白。
   * BRIDGE_STAMP 靠行尾的 \n 定位；先把 \s+ 换成空格，\n 就没了，正则永远匹配不上。
   */
  const t = String(text || '')
    .replace(BRIDGE_STAMP, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!t || t.length < 2) return ''
  if (PURE_NOISE.test(t)) return ''
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

/**
 * 本机时间文本。一律用本地时区，不要 toISOString（那是 UTC，会差 8 小时）。
 */
function localNow(ms = Date.now(), withWeek = true) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  const week = '日一二三四五六'[d.getDay()]
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withWeek ? `${day} 周${week} ${time}` : `${day} ${time}`
}

/**
 * 拼本轮那一小条提醒。
 *
 * 预算意识：这段每轮都要进上下文，字数就是钱。
 * 所以只留下"这一轮此刻用得上的东西"——性格在 preset prefix 里，不再重复。
 */
function renderBlock(style, hits, cfg) {
  const budget = cfg.maxChars || 260
  const out = ['<system-reminder>']
  out.push(`【现在】${localNow()}`)
  if (style) out.push(style)

  const lines = []
  if (hits.length) {
    lines.push('【想起】（摘要，别逐字复述）')
    for (const h of hits) {
      const tag = tagOf(h)
      lines.push(`- ${tag ? `[${tag}] ` : ''}${clip(h.text, cfg.maxFrameChars || 60)}`)
    }
  }

  let used = out.join('\n').length + 24
  for (const line of lines) {
    if (used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  out.push('</system-reminder>')
  return out.join('\n')
}

function userTextOf(messages) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user')
  if (!last) return ''
  return (last.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n').trim()
}

/** 配置里的相对路径按 workspace 解析，绝对路径原样用。 */
function resolvePath(base, file) {
  const raw = String(file || '')
  if (!raw) return ''
  return path.isAbsolute(raw) ? raw : path.join(base || HERE, raw)
}

function logLine(cfg, message) {
  try {
    const file = resolvePath(cfg.workspace, cfg.log)
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${localNow(Date.now(), false)} ${message}\n`)
  } catch {}
}

/** 在一个临时 stdio 连接里调一次 memory 工具。 */
function callMemoryTool(mem, calls, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(mem.node, [mem.server], {
        env: { ...process.env, MEMORY_FILE_PATH: mem.file },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    let buffer = ''
    let stderr = ''
    let done = false
    const answers = new Map()
    const finish = (error) => {
      if (done) return
      done = true
      try {
        child.kill()
      } catch {}
      if (error) reject(error)
      else resolve([...answers.values()])
    }
    const timer = setTimeout(() => finish(new Error('memory 服务超时')), timeoutMs)
    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch {}
    }
    child.on('error', (error) => finish(error))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      if (!done) finish(new Error(`memory 服务退出（${code}）${stderr.slice(-200)}`))
    })
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!message || typeof message.id !== 'number') continue
        if (message.id === 1) {
          if (message.error) {
            finish(new Error('memory 服务握手失败'))
            return
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          calls.forEach((call, offset) => {
            send({ jsonrpc: '2.0', id: offset + 2, method: 'tools/call', params: { name: call.name, arguments: call.arguments || {} } })
          })
          continue
        }
        answers.set(message.id, message)
        if (answers.size === calls.length) finish()
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-life-context', version: '0.1.0' } },
    })
  })
}

/**
 * 输出铁律：进系统提示，而不是混在消息流里。
 * 消息流里的规则只是「一条用户消息」，模型会当成可以商量的建议；
 * 系统提示里的才是必须服从的约束。放这里的唯一目的就是让它压得住上下文。
 */
export const OUTPUT_RULE = [
  '【输出铁律】',
  '任何一轮都必须有正文。正文为空是最严重的错误：对方什么都收不到。',
  '没话可说、话题到头、对方那句只是收尾时，回一个括号短语：（好） （嗯） （收到） （……）',
  '括号的意思是"我在，但这句不多说"。不要因为"这轮不该接话"就一个字都不写。',
].join('\n')

/** 放在现有段之后，靠后一点，别抢人格的位置 */
const OUTPUT_RULE_ORDER = 900

/**
 * 每个 agent 按 id 记"已经注册过什么"。
 *
 * 挂在 globalThis 上而不是模块里：改 config.json 会触发热重载、apply 重跑，
 * 模块级变量未必留得住，但同一进程的 globalThis 一定留得住。
 * 不留这一手的话，重载一次就报 already registered，而且那个异常会把
 * 后面的注册整段跳过——工具就一直停在"没挂上"的状态。
 */
/**
 * 每个 agent 记"这一版代码注册过什么"。
 *
 * 挂在 globalThis 上而不是模块里：改 config.json 会触发热重载、apply 重跑，
 * 模块级变量未必留得住，但同一进程的 globalThis 一定留得住。
 *
 * 存 dispose 和 build（本文件的 mtime）是为了能热更新：代码改了 build 就变，
 * 把旧 section / 旧工具 dispose 掉再挂新的。否则热重载后永远跑的是第一次的代码。
 */
const BUILD = (() => {
  try {
    return Math.round(fs.statSync(fileURLToPath(import.meta.url)).mtimeMs)
  } catch {
    return 0
  }
})()

const REGISTRY = (() => {
  const prev = globalThis.__lifeContextRegistry
  if (prev && prev.section instanceof Map && prev.tools instanceof Map) return prev
  const next = { section: new Map(), tools: new Map() }
  globalThis.__lifeContextRegistry = next
  return next
})()

/* ------------------------------------------------------ 让她自己管上下文 */

function msgText(message) {
  const parts = (message && message.content) || []
  return parts
    .filter((p) => p && p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把当前 surface 按轮次切成若干段。
 * surface.nodes 是"模型此刻真正看得见的那串"，压缩过的部分会被替换节点，
 * 所以照它数，而不是照事件总数数。
 */
function surfaceMap(session, segTurns) {
  const nodes = (session && session.surface && session.surface.nodes) || []
  const segs = []
  let current = null
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    const data = event.data || {}
    const turn = typeof data.turn === 'number' ? data.turn : null
    /*
     * 没有 turn 的节点（tool/result、system/message）跟着当前段走。
     * 以前把它们当成独立的 'x' 桶，结果在有轮次的节点之间来回跳，
     * 777 个节点被切成 777 段——地图比地图上的东西还长。
     */
    const bucket = turn === null ? (current ? current.bucket : 'lead') : Math.floor((turn - 1) / segTurns)
    if (!current || current.bucket !== bucket) {
      current = { bucket, turnFrom: turn, turnTo: turn, seqFrom: seq, seqTo: seq, count: 0, label: '' }
      segs.push(current)
    }
    current.seqTo = seq
    current.count += 1
    if (turn !== null) {
      if (current.turnFrom === null) current.turnFrom = turn
      current.turnTo = turn
    }
    /* 记住段里第一条真人消息：压缩区间要从这儿开始，别把开头的系统提示也压掉 */
    if (current.firstUserSeq === undefined && data.message && data.message.role === 'user') {
      current.firstUserSeq = seq
    }
    /* 路标只认人说的话，别拿工具输出的开头当标题 */
    if (!current.label && data.message) {
      const role = data.message.role
      if (role === 'user' || role === 'assistant') {
        const text = msgText(data.message)
        if (text) current.label = clip(text, 30)
      }
    }
  }
  return segs
}

/**
 * 找出「每个 turn 的第一条用户消息」在 surface 上的 seq。
 *
 * 为什么要这么绕：
 *  · compactRegion 的 end 必须是 surface 上真实存在的节点（turn/end 事件不在 surface 里，
 *    直接给它的 seq 会报 "not found in surface"）；
 *  · 又不能随便给个节点，落在 step 中间会报 "not a balanced boundary"；
 *  · user/message 事件本身没有 turn 字段，所以靠它后面那条带 turn 的消息反推。
 */
function turnBoundaries(session) {
  const nodes = (session && session.surface && session.surface.nodes) || []
  const out = []
  let pendingUser = null
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'user/message') {
      pendingUser = seq
      continue
    }
    const data = event.data || {}
    if (typeof data.turn !== 'number') continue
    if (pendingUser !== null) {
      out.push({ turn: data.turn, seq: pendingUser })
      pendingUser = null
    }
  }
  return out
}

function describeMap(session, cfg) {
  const segs = surfaceMap(session, cfg.foldSegmentTurns || 10)
  if (!segs.length) return '上下文还是空的，没东西可看。'
  const lines = [`上下文 ${segs.length} 段（每段约 ${cfg.foldSegmentTurns || 10} 轮）：`]
  segs.forEach((s, i) => {
    const turns =
      s.turnFrom === null || s.turnTo === null
        ? '（开头）'
        : s.turnFrom === s.turnTo
          ? `第${s.turnFrom}轮`
          : `第${s.turnFrom}-${s.turnTo}轮`
    lines.push(`#${i + 1} ${turns} ｜${s.count}条 ｜${s.label || '（无文字）'}`)
  })
  return lines.join('\n')
}

function createContextTools(deps) {
  /*
   * 签名是 render(args, value)：第一个是调用参数，第二个才是 execute 的返回值。
   * 只写一个参数拿到的是 args，args.text 永远 undefined —— 结果是调用了、也执行了，
   * 但模型看到的返回是空字符串，看起来就像"工具没接上"。
   */
  const render = (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]
  const outSchema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  }

  return [
    {
      name: 'context_map',
      description:
        '看看自己现在的上下文长什么样：分成几段、每段是第几轮、那段在说什么。想整理记忆或者决定压掉哪一段之前，先看这個。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: outSchema, render },
      execute: async (_args, exec) => {
        const session = deps.sessionOf(exec.agent)
        if (!session) return { text: '看不到自己的上下文。' }
        return { text: describeMap(session, deps.config()) }
      },
    },
    {
      name: 'context_fold',
      description:
        '把上下文里的某一（几）段压成摘要，前后的内容原样不动。逐字细节会消失，所以先把自己觉得不能忘的写进 remember——那几句会写进记忆，压完还在。压一段用 fromTurn/toTurn；压多段用 ranges（段与段可以不相邻）；都不填就是从头压到"最近 beforeTurns 轮之前"。',
      parameters: {
        type: 'object',
        properties: {
          fromTurn: {
            type: 'integer',
            minimum: 1,
            description: '从第几轮开始压（含这一轮）。不填就从头压。',
          },
          toTurn: {
            type: 'integer',
            minimum: 1,
            description: '压到第几轮为止（含这一轮）。不填就用"最近 beforeTurns 轮之前"那条线。',
          },
          ranges: {
            type: 'array',
            maxItems: 8,
            description:
              '一次压多段：每项 {fromTurn, toTurn}，两头都含，段与段可以不相邻。重叠或相邻的会自动并成一段。最多 8 段。',
            items: {
              type: 'object',
              properties: {
                fromTurn: { type: 'integer', minimum: 1 },
                toTurn: { type: 'integer', minimum: 1 },
              },
              required: ['fromTurn', 'toTurn'],
              additionalProperties: false,
            },
          },
          beforeTurns: {
            type: 'integer',
            minimum: 1,
            description: '不填 toTurn 时生效：最近多少轮原样留着。默认 30。',
          },
          summary: {
            type: 'string',
            description:
              '自己写一段摘要：填了就不跑模型，直接把这段换成你给的话，省掉一次摘要调用。适合"看完一张图，用一句话记下结论"这种。最多 4000 字，建议一两百字。只能配单段（ranges 只有一段或不填）。',
          },
          remember: {
            type: 'string',
            description:
              '压缩前必须记住的要点，一两句话。会先写进记忆再压缩，写了就丢不掉。没想留的可以不填。',
          },
        },
        additionalProperties: false,
      },
      output: { schema: outSchema, render },
      execute: async (args, exec) => {
        const cfg = deps.config()
        const agent = exec.agent
        const session = deps.sessionOf(agent)
        if (!session) {
          deps.log(cfg, 'context_fold 拿不到 session（sessions 服务没给这个 agent）')
          return { text: '看不到自己的上下文，这次没压。' }
        }

        const remember = String((args && args.remember) || '').trim()
        const selfSummary = typeof (args && args.summary) === 'string' ? String(args.summary).trim() : ''
        if (selfSummary && !cfg.allowSelfSummary) {
          return { text: '自写摘要还没开（config.allowSelfSummary 是 false），这次用默认摘要压。' }
        }
        if (selfSummary.length > 4000) {
          return { text: `summary 写了 ${selfSummary.length} 字，太长了；要这么长就别自己写，用默认的摘要。` }
        }
        /* 区间用轮次说：fromTurn 含、toTurn 含。都不填就是"从头压到最近 beforeTurns 轮之前" */
        const clampTurn = (v) => (Number.isFinite(Number(v)) ? Math.max(1, Math.floor(Number(v))) : null)
        const keepTurns = Math.max(1, Number(args && args.beforeTurns) || 30)
        /* ---------- 先把要压的区间定下来 ---------- */
        const rawRanges = Array.isArray(args && args.ranges) ? args.ranges : []
        let runs
        if (rawRanges.length) {
          if (rawRanges.length > 8) return { text: '一次最多压 8 段，分几次来吧。' }
          const picked = []
          for (const r of rawRanges) {
            const f = clampTurn(r && r.fromTurn)
            const t = clampTurn(r && r.toTurn)
            if (f === null || t === null) {
              return { text: 'ranges 里每一段都要写 fromTurn 和 toTurn（轮次，两头都含）。' }
            }
            if (t < f) return { text: `区间反了：第${f}轮到第${t}轮。` }
            picked.push({ from: f, to: t })
          }
          /* 从后往前：先压靠后的段，前面那些回合的边界不会被动到 */
          picked.sort((a, b) => b.from - a.from)
          const merged = []
          for (const r of picked) {
            const last = merged[merged.length - 1]
            /* 重叠、或者正好挨着（r.to 比 last.from 小 1），就并成一段 */
            if (last && r.to >= last.from - 1) {
              last.from = Math.min(last.from, r.from)
              last.to = Math.max(last.to, r.to)
            } else {
              merged.push({ ...r })
            }
          }
          runs = merged
        } else {
          runs = [{ from: clampTurn(args && args.fromTurn), to: clampTurn(args && args.toTurn) }]
        }
        deps.log(
          cfg,
          `context_fold 开始 段=${runs.length} ${runs.map((r) => `${r.from ?? '开头'}~${r.to ?? `最近${keepTurns}轮之前`}`).join(',')} 记住=${remember.length}字`,
        )
        if (selfSummary && runs.length > 1) {
          return { text: '自写摘要一次只能配一段。要多段就别填 summary，让它自己写；或者分几次调。' }
        }
        if (remember) {
          try {
            await deps.remember(cfg, remember)
            deps.log(cfg, `context_fold 先记 ${remember.length} 字`)
          } catch (error) {
            deps.log(cfg, `context_fold 记忆没写进去: ${String((error && error.message) || error).slice(0, 90)}`)
            return { text: '要点没写进记忆，这次先不压——压掉就找不回来了。' }
          }
        }

        const segTurns = cfg.foldSegmentTurns || 10
        const segs = surfaceMap(session, segTurns)
        const turns = segs.map((s) => s.turnTo).filter((t) => typeof t === 'number')
        const shape = `段=${segs.length} 节点=${session.surface?.nodes?.length ?? '?'} 轮=${turns.length ? `${Math.min(...turns)}-${Math.max(...turns)}` : '无'}`
        if (!turns.length) {
          deps.log(cfg, `context_fold 没有轮次信息 ${shape}`)
          return { text: '还没到能压的时候。' }
        }
        const maxTurn = Math.max(...turns)
        /* 压到这一轮为止（含）。没指定 toTurn 就留最近 keepTurns 轮 */
        const toLine = (runs[0] && runs[0].to) ?? Math.max(1, maxTurn - keepTurns)
        if (toLine < 1) {
          deps.log(cfg, `context_fold 区间不合理 ${shape} 到=${toLine}`)
          return { text: `最近 ${keepTurns} 轮已经占满了，前面没剩可压的。` }
        }

        /* 限速按时间算：压中间一段时轮次号不会往前走，按轮次比会算错 */
        const nowMs = Date.now()
        const cooldown = (cfg.foldCooldownMinutes ?? 5) * 60000
        const lastAt = deps.lastFoldOf(agent.id)
        if (nowMs - lastAt < cooldown) {
          const left = Math.ceil((cooldown - (nowMs - lastAt)) / 60000)
          deps.log(cfg, `context_fold 冷却中 还剩${left}分钟`)
          return { text: `刚压过一次，再等 ${left} 分钟吧。` }
        }

        let compaction = null
        let from = ''
        if (selfSummary) {
          deps.log(cfg, `context_fold 自写摘要 ${selfSummary.length} 字，不跑模型`)
        } else {
          const got = deps.compaction(agent)
          compaction = got.svc
          from = got.from
          if (!compaction) {
            deps.log(cfg, 'context_fold 取不到 compaction 服务，这次没压')
            return { text: '压缩服务这会儿不可用（agent.ctx 和宿主都取不到），这次没压。' }
          }
          deps.log(cfg, `context_fold 走 ${from} 的 compaction`)
        }

        const CHECKPOINT_PREAMBLE =
          'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

        /*
         * 自写摘要：不调模型，直接把这个区间换成一条 checkpoint 用户消息。
         *
         * 事件顺序必须和 compaction-basic 完全一样，一步都不能省：
         *   compaction/start → compaction/summary → user/message(替换) → compaction/end
         * 少了 start，会话读取器会在状态机里报
         *   "compaction checkpoint has no matching compaction/start"
         * 整条会话就打不开了——这是踩过的坑。
         *
         * start 里的 turn 必须是当前未结束的回合，所以先找 openTurn。
         */
        const openTurnOf = (session) => {
          let evs = []
          try {
            evs = session.ownEvents() || []
          } catch {
            return null
          }
          for (let i = evs.length - 1; i >= 0; i--) {
            const e = evs[i]
            if (e.type === 'turn/end') return null
            if (e.type === 'turn/start') return typeof e.data?.turn === 'number' ? e.data.turn : null
          }
          return null
        }

        const replaceWithSummary = (session, startSeq, endSeq, text) => {
          const evs = []
          try {
            const snap = session.snapshotEvents(startSeq, Number(endSeq) + 1)
            for (const e of snap || []) evs.push(e)
          } catch (error) {
            return { ok: false, why: `读不到这段事件：${String((error && error.message) || error).slice(0, 80)}` }
          }
          const calls = new Set()
          const results = new Set()
          for (const e of evs) {
            if (e.type === 'assistant/message') {
              for (const p of e.data?.message?.content || []) {
                if (p && p.type === 'tool-call' && p.id) calls.add(String(p.id))
              }
            } else if (e.type === 'tool/result') {
              const id = e.data?.message?.toolCallId ?? e.data?.toolCallId
              if (id) results.add(String(id))
            }
          }
          for (const id of calls) if (!results.has(id)) return { ok: false, why: '这段里有个工具调用，但它的结果不在这段里' }
          for (const id of results) if (!calls.has(id)) return { ok: false, why: '这段里有个工具结果，但它的调用不在这段里' }

          let shadowedChars = 0
          for (const e of evs) {
            for (const p of e.data?.message?.content || []) {
              if (typeof p?.text === 'string') shadowedChars += p.text.length
              if (typeof p?.arguments === 'string') shadowedChars += p.arguments.length
            }
          }
          /* 换成比原文还长的话没意义，官方实现也会拒绝 */
          if (text.length >= shadowedChars) {
            return { ok: false, why: `这段话 ${text.length} 字，比要替换的 ${shadowedChars} 字还长，换了反而更占` }
          }

          const turn = openTurnOf(session)
          if (turn === null) return { ok: false, why: '当前没有进行中的回合，这时候不能替换' }
          const ctxInfo = (() => {
            try {
              return session.requestContext() || {}
            } catch {
              return {}
            }
          })()
          const compactionId = crypto.randomUUID()
          const lifecycle = { compactionId, turn }
          let started = false
          try {
            const startEvent = session.append('compaction/start', lifecycle)
            started = true
            const summaryEvent = session.append('compaction/summary', {
              compactionId,
              summary: [{ type: 'text', text }],
              shadowedRange: { start: startSeq, end: endSeq },
              shadowedSeqs: evs.map((e) => e.seq),
              shadowedTokenCount: Math.round(shadowedChars / 1.6),
              ...(ctxInfo.provider ? { provider: ctxInfo.provider } : {}),
              ...(ctxInfo.model ? { model: ctxInfo.model } : {}),
            })
            session.append(
              'user/message',
              {
                content: [
                  { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
                  { type: 'text', text },
                ],
                source: { kind: 'compact-checkpoint', compactionId },
                role: 'user',
                id: crypto.randomUUID(),
              },
              {
                surfaceOp: { op: 'replace', startSeq, endSeq },
                sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...evs.map((e) => e.seq)],
              },
            )
            session.append('compaction/end', lifecycle)
            return { ok: true }
          } catch (error) {
            const why = String((error && error.message) || error).slice(0, 130)
            /* 已经写了 start 就必须补 end，否则留下一个开着的压缩，会话照样读不回来 */
            if (started) {
              try {
                session.append('compaction/end', lifecycle)
              } catch {}
            }
            return { ok: false, why }
          }
        }

        /*
         * 边界全从「回合开头」里挑：
         *  · end 必须在 surface 上且是一个回合的开头，否则会分别报
         *    "not found in surface" 和 "not a balanced boundary"；
         *  · start 不能是 surface 第一个节点——它持有 system prompt，
         *    会报 "node 0 holds the system prompt and may be rewritten only by …"。
         *
         * 只试一次，不搞候选循环。因为 compactRegion 失败时**不回滚**：
         * 它先写 compaction/start + compaction/summary 再在 end 上报错，
         * 留下的孤儿事件会让整个会话读不出来，得手工截断日志才能救。
         * 失败一次就收手，别再往主会话里写垃圾。
         */
        const foldOne = async (run) => {
          /* 每段都重取一次 session：上一段压完 surface 就变了，旧边界不能再用 */
          const session = deps.sessionOf(agent)
          if (!session) return { ok: false, text: '看不到自己的上下文。' }
          const segs = surfaceMap(session, cfg.foldSegmentTurns || 10)
          const turns = segs.map((s) => s.turnTo).filter((t) => typeof t === 'number')
          if (!turns.length) return { ok: false, text: '还没到能压的时候。' }
          const maxTurn = Math.max(...turns)
          const toLine = run.to ?? Math.max(1, maxTurn - keepTurns)
          const fromLine = run.from ?? null
          const label = `第${fromLine ?? 1}-${toLine}轮`
          if (toLine < 1) {
            return { ok: false, text: `最近 ${keepTurns} 轮已经占满了，前面没剩可压的。` }
          }

          const bounds = turnBoundaries(session)
          const firstNode = (session.surface?.nodes || [])[0]
          const usable = bounds.filter((b) => b.seq > firstNode)
          /* start：第一个 >= fromTurn 的回合；end：第一个 > toLine 的回合（它自己不压） */
          const startEntry = usable.find((b) => fromLine === null || b.turn >= fromLine)
          const endEntry = usable.find((b) => b.turn > toLine)
          if (!startEntry || !endEntry) {
            deps.log(cfg, `context_fold 找不到边界 ${label}`)
            return { ok: false, text: `${label}找不到完整回合边界。` }
          }
          if (fromLine !== null && startEntry.turn > toLine) {
            deps.log(cfg, `context_fold 区间已压过 ${label}`)
            return { ok: false, text: `${label}已经压过了（现在最早能看到第${startEntry.turn}轮）。` }
          }
          if (!(endEntry.seq > startEntry.seq)) {
            deps.log(cfg, `context_fold 区间为空 ${label}`)
            return { ok: false, text: `${label}两头挨着，没东西可压。` }
          }

          if (selfSummary) {
            const swapped = replaceWithSummary(session, startEntry.seq, endEntry.seq, selfSummary)
            if (!swapped.ok) {
              deps.log(cfg, `context_fold 自写摘要被拒 ${label}: ${swapped.why}`)
              return { ok: false, fatal: true, text: `${label}没换成：${swapped.why}` }
            }
            deps.log(
              cfg,
              `context_fold 自写摘要 seq ${startEntry.seq}-${endEntry.seq} 轮 ${startEntry.turn}-${toLine} ok=true`,
            )
            return { ok: true, text: `${label}换成了一句话摘要（没跑模型）` }
          }

          let folded = null
          try {
            folded = await compaction.compactRegion(startEntry.seq, endEntry.seq, agent, exec.signal)
          } catch (error) {
            const message = String((error && error.message) || error)
            deps.log(cfg, `context_fold seq ${startEntry.seq}-${endEntry.seq} 被拒: ${message.slice(0, 130)}`)
            return { ok: false, fatal: true, text: `${label}被拒：${message.slice(0, 150)}` }
          }
          /* compactRegion 的返回值里有真实 token 账，别丢 */
          const saved = Number(folded && folded.shadowedTokenCount)
          deps.log(
            cfg,
            `context_fold seq ${startEntry.seq}-${endEntry.seq} 轮 ${startEntry.turn}-${toLine} ok=true 压掉=${Number.isFinite(saved) ? saved : '?'}token`,
          )
          return {
            ok: true,
            text: Number.isFinite(saved) && saved > 0 ? `${label}收成摘要了（压掉约 ${saved} token）` : `${label}收成摘要了`,
          }
        }

        /*
         * 一段一段压，顺序是从后往前。任意一段被拒就整轮收手——
         * compactRegion 失败不回滚，会留下孤儿事件，再往坏掉的会话上继续写只会更糟。
         */
        const done = []
        const failed = []
        for (const run of runs) {
          const result = await foldOne(run)
          if (result.ok) {
            done.push(result.text)
            continue
          }
          failed.push(result.text)
          if (result.fatal) break
        }
        if (done.length) deps.markFold(agent.id, nowMs)

        const rememberNote = remember ? '你交代的那几句已经在记忆里了。' : ''
        if (done.length === 1 && failed.length === 0) {
          return { text: `压完了：${done[0]}，前面和后面都原样留着。${rememberNote}` }
        }
        if (!done.length && !failed.length) return { text: '这次没有可压的区间。' }
        const parts = []
        if (done.length) parts.push(`压好了 ${done.length} 段：${done.join('；')}。`)
        if (failed.length) parts.push(`没动的 ${failed.length} 段：${failed.join('；')}`)
        return { text: `${parts.join('\n')}${rememberNote ? `\n${rememberNote}` : ''}` }

      },
    },
  ]
}

export function apply(ctx, config = {}) {
  let cache = { key: '', docs: [] }
  // 同一批记忆 5 分钟内不重复注入，省 token
  const recentHits = new Map()
  // 每个 agent 上次压缩的时间戳（毫秒），用来冷却
  const foldMarks = new Map()
  // 每个 agent 上次看到的 preset，用来判断组合有没有丢
  const seenPreset = new Map()
  /*
   * apply 被调几次、什么时候被调，是判断「插件到底在不在」的唯一硬证据。
   * 之前一整天没有注入，却分不清是没加载还是收不到事件，全靠这条日志。
   */
  const bootId = Math.random().toString(16).slice(2, 8)
  try {
    logLine(loadConfig(), `life-context 已加载 boot=${bootId} 服务=${Boolean(ctx.get && ctx.get('agentPresets'))}`)
  } catch {}

  /*
   * 流水：每过一段就留一行"这轮说了什么"，不做价值判断。
   * 以前按"同一句话 60 分钟内不重复"去重，等于要求每句都被判定为值得记，结果是 0 条。
   */
  let lastFlowAt = 0
  function writeFlow(cfg, text) {
    if (!cfg.autoWrite || !cfg.memory || !text) return false
    const now = Date.now()
    const gap = (cfg.flowIntervalMinutes || 15) * 60 * 1000
    if (now - lastFlowAt < gap) return false
    lastFlowAt = now
    const entity = cfg.autoWriteEntity || '生活·流水'
    /* 流水时间戳用本机时区。toISOString 是 UTC，记下来会一直差 8 小时 */
    const observation = `${localNow(now, false)} ${text}`
    callMemoryTool(cfg.memory, [
      { name: 'create_entities', arguments: { entities: [{ name: entity, entityType: 'life-log', observations: [] }] } },
      { name: 'add_observations', arguments: { observations: [{ entityName: entity, contents: [observation] }] } },
    ])
      .then((replies) => {
        const bad = replies.find((r) => r && (r.error || (r.result && r.result.isError)))
        logLine(cfg, bad ? `flow fail ${text.slice(0, 30)}` : `flow ok ${text.slice(0, 30)}`)
      })
      .catch((error) => logLine(cfg, `flow error ${String((error && error.message) || error).slice(0, 80)}`))
    return true
  }

  function docsOf(cfg) {
    try {
      const stat = fs.statSync(cfg.graph)
      const key = `${stat.mtimeMs}:${cfg.meta}`
      if (cache.key === key) return cache.docs
      cache = { key, docs: loadDocs(cfg) }
      return cache.docs
    } catch {
      return []
    }
  }

  /*
   * 服务必须每次现取，不能在 apply 时缓存一次。
   * 插件是热加载的：重载那一刻如果 agentPresets 还没就绪，ctx.get 返回 undefined，
   * 缓存下来就等于这个进程终身失明——之前整天的注入消失就是这么来的。
   */
  let warnedNoPresets = false
  function presetsService() {
    try {
      const service = ctx.get ? ctx.get('agentPresets') : undefined
      if (!service && !warnedNoPresets) {
        warnedNoPresets = true
        logLine(loadConfig(), 'agentPresets 服务取不到，生活模式注入会全程跳过')
      }
      return service
    } catch {
      return undefined
    }
  }

  function presetOf(agent) {
    try {
      const presets = presetsService()
      if (presets && agent && agent.ctx && typeof presets.composedPreset === 'function') {
        return presets.composedPreset(agent.ctx)
      }
    } catch {}
    return undefined
  }

  /*
   * 某个 preset 名在不在名单里。名单里写 '*' 就是所有会话，哪怕 preset 认不出来。
   * 名单为空时退回 ['life']。
   */
  function presetAllowedIn(agent, list) {
    const names = Array.isArray(list) && list.length ? list : ['life']
    if (names.includes('*')) return true
    const current = presetOf(agent)
    return Boolean(current) && names.includes(current)
  }

  /* 陪聊那套（输出铁律 + 风格/记忆注入）挂给哪些预设 */
  function presetAllowed(agent, cfg) {
    return presetAllowedIn(agent, cfg && cfg.presets)
  }

  function service(name) {
    try {
      return ctx.get ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  function sessionOf(agent) {
    try {
      const sessions = service('sessions')
      return sessions && agent ? sessions.get(agent.id) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * compaction 在 preset 里被 `isolate: compaction: true` 圈在 group 内，
   * 宿主 ctx 和 agent.ctx 都看不见它（隔离是"对祖先隐藏"）。
   * 但 agentPresets 有个 serviceFor(agent, name)，本来就是拿来跨 preset scope 取服务的。
   * 挨层试，并记下是哪层命中的；全都不行就别硬压。
   */
  function compactionOf(agent) {
    const layers = [
      [
        'agentPresets.serviceFor',
        () => {
          const presets = presetsService()
          return presets && typeof presets.serviceFor === 'function' ? presets.serviceFor(agent, 'compaction') : undefined
        },
      ],
      ['agent.ctx.compaction', () => (agent && agent.ctx ? agent.ctx.compaction : undefined)],
      [
        'agent.ctx.get',
        () => (agent && agent.ctx && typeof agent.ctx.get === 'function' ? agent.ctx.get('compaction') : undefined),
      ],
      ['host ctx.get', () => service('compaction')],
    ]
    for (const [from, get] of layers) {
      try {
        const svc = get()
        if (svc && typeof svc.compactRegion === 'function') return { svc, from }
      } catch {}
    }
    return { svc: undefined, from: 'none' }
  }

  /** 先记后忘：压之前把要点写进图谱，压完还找得回来 */
  async function rememberNow(cfg, text) {
    if (!cfg.memory) throw new Error('没配 memory 服务')
    const entity = cfg.autoWriteEntity || '生活·流水'
    const observation = `${localNow(Date.now(), false)} ${text}`
    const replies = await callMemoryTool(cfg.memory, [
      {
        name: 'create_entities',
        arguments: { entities: [{ name: entity, entityType: 'life-log', observations: [] }] },
      },
      { name: 'add_observations', arguments: { observations: [{ entityName: entity, contents: [observation] }] } },
    ])
    const bad = replies.find((r) => r && (r.error || (r.result && r.result.isError)))
    if (bad) throw new Error('记忆没写进去，这次先不压')
  }

  /** 工具挂在 agent 自己的 ctx 上，所以别的会话看不见它们 */
  function registerContextTools(agent) {
    const tools = agent.ctx.tools || (agent.ctx.get && agent.ctx.get('tools'))
    if (!tools || typeof tools.register !== 'function') {
      logLine(loadConfig(), 'tools 服务不可见，上下文工具没挂上')
      return []
    }
    /*
     * 已经在这个 scope 里注册过就别重复注册（会抛 already registered）。
     * 正常情况下调用方会先 dispose，走不到这里；走得到说明 dispose 没生效。
     */
    const already = (name) => {
      try {
        if (typeof tools.get !== 'function') return false
        return Boolean(tools.get(name, agent.ctx) || tools.get(name))
      } catch {
        return false
      }
    }
    const defs = createContextTools({
      config: loadConfig,
      log: logLine,
      sessionOf,
      remember: rememberNow,
      compaction: compactionOf,
      lastFoldOf: (id) => foldMarks.get(id) || 0,
      markFold: (id, turn) => foldMarks.set(id, turn),
    })
    /*
     * allowFold=false 就只留 context_map：看得见上下文，但不下压。
     * 想保守一点就关掉，工具表里连 context_fold 都不出现。
     */
    const usable = loadConfig().allowFold === false ? defs.filter((d) => d.name !== 'context_fold') : defs
    const disposers = []
    let count = 0
    for (const definition of usable) {
      try {
        if (already(definition.name)) {
          count += 1
          continue
        }
        const off = tools.register(definition)
        if (typeof off === 'function') disposers.push(off)
        count += 1
      } catch (error) {
        logLine(loadConfig(), `工具 ${definition.name} 注册失败: ${String((error && error.message) || error).slice(0, 80)}`)
      }
    }
    logLine(loadConfig(), `上下文工具就位 ${count}/${usable.length}（${usable.map((d) => d.name).join(' / ') || '无'}）`)
    return disposers
  }

  const dispose = ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    /* preset 变化时记一笔：注入消失时能一眼看出是「组合丢了」还是「订阅没挂上」 */
    try {
      const current = presetOf(agent)
      const key = String(agent?.id || '?')
      if (seenPreset.get(key) !== current) {
        seenPreset.set(key, current)
        logLine(loadConfig(), `preset=${current || 'none'} agent=${key.slice(-8)}`)
      }
    } catch {}

    /*
     * 先注册输出铁律，再 next()：同一轮的系统提示组装在 request 阶段，
     * 放在 next() 之后注册，这一轮就赶不上了。
     * section 挂在 agent 自己的 ctx 上，所以只作用于这个 agent，不影响干活的会话。
     */
    try {
      const who = String(agent?.id || '?')
      const liveCfg = loadConfig()
      /*
       * 两个开关，别混：
       *  · presets     —— 谁算「陪聊」：输出铁律 + 风格/记忆注入
       *  · toolPresets —— 谁拿 context_map / context_fold，不填就跟 presets 一样
       * 分开是因为：把压缩工具铺到所有会话是合理的，把陪聊口吻铺到所有会话不合理。
       */
      if (agent?.ctx && presetAllowed(agent, liveCfg)) {
        /* 两件事各自 try：section 挂了不能连带工具，反过来也一样 */
        const sec = REGISTRY.section.get(who)
        if (!sec || sec.build !== BUILD) {
          if (sec) {
            try {
              sec.dispose()
            } catch {}
            REGISTRY.section.delete(who)
          }
          let entry = { dispose: () => {}, build: BUILD }
          try {
            const sp = agent.ctx.systemPrompt || (agent.ctx.get && agent.ctx.get('systemPrompt'))
            if (sp && typeof sp.section === 'function') {
              const off = sp.section({ name: 'life-output-rule', order: OUTPUT_RULE_ORDER, text: OUTPUT_RULE })
              if (typeof off === 'function') entry = { dispose: off, build: BUILD }
              logLine(loadConfig(), `system-prompt section 已注册 life-output-rule${sec ? '（新版本）' : ''}`)
            } else {
              logLine(loadConfig(), 'system-prompt service 不可见，铁律只能走消息注入')
            }
          } catch (error) {
            logLine(loadConfig(), `输出铁律 section 注册失败: ${String((error && error.message) || error).slice(0, 90)}`)
          }
          REGISTRY.section.set(who, entry)
        }
      }

      if (agent?.ctx && presetAllowedIn(agent, liveCfg.toolPresets || liveCfg.presets)) {
        const toolsEntry = REGISTRY.tools.get(who)
        if (!toolsEntry || toolsEntry.build !== BUILD) {
          if (toolsEntry) {
            for (const off of toolsEntry.dispose) {
              try {
                off()
              } catch {}
            }
            REGISTRY.tools.delete(who)
          }
          let disposers = []
          try {
            disposers = registerContextTools(agent) || []
          } catch (error) {
            logLine(loadConfig(), `上下文工具注册失败: ${String((error && error.message) || error).slice(0, 90)}`)
          }
          REGISTRY.tools.set(who, { dispose: disposers, build: BUILD })
        }
      }
    } catch (error) {
      logLine(loadConfig(), `注册流程出错: ${String((error && error.message) || error).slice(0, 100)}`)
    }

    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject') return decision
      if (step !== 1) return decision
      if (signal && signal.aborted) return decision
      if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
      const cfg = loadConfig()
      if (!presetAllowed(agent, cfg)) return decision
      const query = userTextOf(messages)
      let style = ''
      if (cfg.injectStyle) {
        try {
          style = fs.readFileSync(resolvePath(cfg.workspace, cfg.styleFile), 'utf8').trim()
        } catch {}
      }
      const hits = cfg.injectMemory ? pick(docsOf(cfg), query, cfg) : []
      const nowMs = Date.now()
      const ttl = (cfg.dedupeMinutes || 5) * 60 * 1000
      const fresh = hits.filter((h) => nowMs - (recentHits.get(obsKey(h.entity, h.text)) || 0) > ttl)
      for (const h of fresh) recentHits.set(obsKey(h.entity, h.text), nowMs)
      const flowed = writeFlow(cfg, flowLine(query))
      if (!style && !fresh.length) return decision

      const text = renderBlock(style, fresh, cfg)
      const lastClaimed = decision.messages.findLastIndex((m) => (messages || []).includes(m))
      const at = lastClaimed === -1 || lastClaimed >= decision.messages.length ? decision.messages.length : lastClaimed + 1
      const injected = {
        id: `life-context-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'life-context', form: 'notice', summary: `生活上下文 ${text.length} 字` },
      }
      logLine(cfg, `inject style=${Boolean(style)} hits=${fresh.length} flow=${flowed ? 1 : 0} chars=${text.length}`)
      return { ...decision, messages: decision.messages.toSpliced(at, 0, injected) }
    } catch (error) {
      console.error('[life-context] 注入失败（已跳过）:', error)
      return decision
    }
  })

  return () => {
    try {
      dispose()
    } catch {}
  }
}
