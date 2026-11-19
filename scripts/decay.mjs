#!/usr/bin/env node
/**
 * 遗忘真的执行。
 *
 *   node scripts/decay.js            # 只体检，列出该淡的
 *   node scripts/decay.js --apply    # 备份 + 真归档（软删，原文还在图谱里）
 *
 * 两件事：
 *  1. 强度 < 0.12 且 30 天没用过 → 归档（memory-plugin 的 forgetKeys，只改 meta.tier）
 *  2. 生活·流水里"不是今天"的日子 → 压成 1 条日摘要，原文归档
 *
 * 硬规则：归档是软删。动手前一定先备份 memory.jsonl 和 meta.jsonl。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { paths, flattenGraph, readGraphFile, loadMeta, backupGraph, backupMeta } from '../bundles/memory-mcp/server/lib/core.js'
import { buildIndex } from '../bundles/memory-mcp/server/lib/index-build.js'
import { forgetKeys } from '../bundles/memory-mcp/server/lib/ops.js'

/* 数据目录：和插件用同一套规则，LIFE_MODE_HOME 可覆盖 */
const HOME = process.env.LIFE_MODE_HOME || path.join(os.homedir(), '.dsh', 'life-mode')
const MEMORY_DIR = path.join(HOME, 'memory')
process.env.MEMORY_GRAPH = process.env.MEMORY_GRAPH || path.join(MEMORY_DIR, 'memory.jsonl')
process.env.MEMORY_META = process.env.MEMORY_META || path.join(MEMORY_DIR, 'meta.jsonl')
process.env.MEMORY_BACKUPS = process.env.MEMORY_BACKUPS || path.join(MEMORY_DIR, 'backups')

const CONFIG_FILE = path.join(HOME, 'bundles', 'life-context', 'config.json')

const HALF_LIFE_DAYS = 4
const MIN_STRENGTH = 0.12
// 半衰期 4 天起步，importance 2 的记忆约 25 天淡到底。等满 30 天太慢，记忆会一直躺着。
const MIN_AGE_DAYS = 14
// 一次最多归档这么多：忘得动但看得见，别一天把图谱掏空
const MAX_PER_RUN = 40
const APPLY = process.argv.includes('--apply')

const pad = (n) => String(n).padStart(2, '0')
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

let lifeCfg = {}
try {
  lifeCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
} catch {}
const FLOW_ENTITY = lifeCfg.autoWriteEntity || '生活·流水'
const DIGEST_ENTITY = '生活·日摘要'

const config = paths()
const now = Date.now()

/*
 * --apply 时先备份、再补索引，然后才统计。
 *
 * 补索引是必须的：新写进图谱的流水从来没进过 meta.jsonl，
 * forgetKeys 在 meta 里找不到 key 就只能算 missing，流水永远压不掉。
 * buildIndex 会继承旧的 tier / importance / pinned，是安全的增量重建。
 * 顺序不能反——备份必须在动 meta 之前。
 */
const backupDir = config.backups || path.join(path.dirname(config.graph), 'backups')
let backedUpTo = ''
if (APPLY) {
  try {
    fs.mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupGraph(config, `decay-apply-${stamp}`)
    backupMeta(config, `decay-apply-${stamp}`)
    fs.copyFileSync(config.graph, path.join(backupDir, `memory-${stamp}.jsonl`))
    fs.copyFileSync(config.meta, path.join(backupDir, `meta-${stamp}.jsonl`))
    backedUpTo = backupDir
  } catch (error) {
    console.log(`备份失败，拒绝继续：${String((error && error.message) || error).slice(0, 160)}`)
    process.exit(1)
  }
  const built = buildIndex(config, { write: true })
  console.log(`补索引：${Array.isArray(built && built.records) ? built.records.length : '?'} 条`)
}

const meta = loadMeta(config.meta)
const rows = flattenGraph(readGraphFile(config.graph))

/* ------------------------------------------------ 1) 淡掉的记忆 */
const dim = []
const approaching = []
for (const row of rows) {
  const m = meta.byKey.get(row.key) || {}
  if (m.tier === 'archive') continue
  if (m.pinned || m.tier === 'core' || (m.importance || 0) >= 4) continue
  if (row.text.length > 300) continue
  const stamp = Date.parse(m.lastUsedAt || m.createdAt || '')
  if (!Number.isFinite(stamp)) continue
  const days = (now - stamp) / 86400000
  const halfLife = HALF_LIFE_DAYS * (1 + (m.importance || 0))
  const strength = Math.exp(-days / halfLife)
  const due = -Math.log(MIN_STRENGTH) * halfLife
  if (days >= MIN_AGE_DAYS && strength < MIN_STRENGTH) {
    dim.push({ key: row.key, entity: row.entity, text: row.text, days: Math.round(days), strength: Number(strength.toFixed(3)) })
  } else if (days < due) {
    approaching.push({ entity: row.entity, text: row.text, left: Math.ceil(due - days), importance: m.importance || 0 })
  }
}
dim.sort((a, b) => a.strength - b.strength)
approaching.sort((a, b) => a.left - b.left)

/* ------------------------------------------------ 2) 流水压成日摘要 */
const today = localDay()
const byDay = new Map()
for (const row of rows) {
  if (row.entity !== FLOW_ENTITY) continue
  const match = row.text.match(/^(\d{4}-\d{2}-\d{2})/)
  const day = match ? match[1] : '未标日期'
  if (day >= today) continue // 今天的还新鲜，先不动
  if (!byDay.has(day)) byDay.set(day, [])
  byDay.get(day).push(row)
}

const flowPlans = []
for (const [day, list] of [...byDay.entries()].sort()) {
  if (list.length < 3) continue // 一天只有一两句，留着比压成一句更值
  const bits = list
    .map((row) => row.text.replace(/^\d{4}-\d{2}-\d{2}\s*\d{0,2}:?\d{0,2}\s*/, '').trim())
    .filter(Boolean)
    .map((text) => (text.length > 24 ? `${text.slice(0, 24)}…` : text))
  const summary = `${day} 那天：${bits.slice(0, 6).join('；')}${bits.length > 6 ? `；等 ${bits.length} 件` : ''}`
  flowPlans.push({ day, keys: list.map((row) => row.key), count: list.length, summary })
}

/* ------------------------------------------------ 报告 */
const out = []
out.push(`淡掉的记忆：${dim.length} 条（强度 < ${MIN_STRENGTH}，超过 ${MIN_AGE_DAYS} 天）`)
for (const item of dim.slice(0, 15)) {
  out.push(`  ${item.key}  ${item.strength}  ${item.days}天  [${item.entity}] ${item.text.slice(0, 44)}`)
}
if (dim.length > 15) out.push(`  …还有 ${dim.length - 15} 条`)
if (!dim.length && approaching.length) {
  out.push('  （还没有到期的。最快的一批：')
  for (const item of approaching.slice(0, 3)) {
    out.push(`    ${item.left}天后  imp=${item.importance}  [${item.entity}] ${item.text.slice(0, 36)}`)
  }
  out.push('  ）')
}

out.push('')
out.push(`可压的流水日子：${flowPlans.length} 天（每天 ≥ 3 条，且不是今天）`)
for (const plan of flowPlans) out.push(`  ${plan.day}  ${plan.count} 条 → ${plan.summary.slice(0, 60)}`)

if (!APPLY) {
  out.push('')
  out.push('（只体检没动手。要真归档加 --apply。）')
  console.log(out.join('\n'))
  process.exit(0)
}

/* ------------------------------------------------ 没活就收工（备份和补索引已经做完） */
if (!dim.length && !flowPlans.length) {
  out.push('')
  out.push('今天没什么可忘的。索引补过了，别的没动。')
  if (backedUpTo) out.push(`备份在 ${backedUpTo}`)
  console.log(out.join('\n'))
  process.exit(0)
}

/* 流水：先写摘要，再归档原文 */
let digestWritten = 0
for (const plan of flowPlans) {
  try {
    await callMemory([
      {
        name: 'create_entities',
        arguments: { entities: [{ name: DIGEST_ENTITY, entityType: 'life-log', observations: [plan.summary] }] },
      },
    ])
    digestWritten += 1
  } catch (error) {
    out.push(`  写摘要失败（${plan.day}）：${String((error && error.message) || error).slice(0, 80)}`)
  }
}
if (flowPlans.length) {
  if (digestWritten > 0) {
    const flowKeys = flowPlans.flatMap((plan) => plan.keys)
    const result = forgetKeys(config, flowKeys, '流水压成日摘要')
    out.push(`流水归档：${result.archived} 条（${flowPlans.length} 天压成 ${digestWritten} 条摘要）`)
    if (result.missing.length) out.push(`  其中 ${result.missing.length} 条还没进索引，跳过`)
  } else {
    out.push('流水一条都没压：摘要没写进去，原文留着。')
  }
}

/* 淡掉的记忆：直接归档 */
if (dim.length) {
  const batch = dim.slice(0, MAX_PER_RUN)
  const result = forgetKeys(config, batch.map((item) => item.key), '遗忘曲线：半月未用且强度低于0.12')
  out.push(`淡掉归档：${result.archived} 条${dim.length > batch.length ? `（本轮上限 ${MAX_PER_RUN}，还剩 ${dim.length - batch.length} 条明天继续）` : ''}`)
  if (result.missing.length) out.push(`  其中 ${result.missing.length} 条不在索引里，跳过`)
}

out.push('')
out.push('完成。归档是软删，原文都还在 memory.jsonl 里；要恢复改回 meta 的 tier 即可。')
console.log(out.join('\n'))

/* ------------------------------------------------ MCP 写入小工具 */
function callMemory(calls, timeoutMs = 15000) {
  const mem = lifeCfg.memory
  if (!mem || !mem.node || !mem.server) return Promise.reject(new Error('config.json 里没有 memory 配置'))
  return new Promise((resolve, reject) => {
    const child = spawn(mem.node, [mem.server], {
      env: { ...process.env, MEMORY_FILE_PATH: mem.file || config.graph },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffer = ''
    let stderr = ''
    let done = false
    const answers = []
    const timer = setTimeout(() => finish(new Error('memory 服务超时')), timeoutMs)
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {}
      if (error) reject(error)
      else resolve(answers)
    }
    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch {}
    }
    child.on('error', finish)
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      if (!done) finish(new Error(`memory 服务退出（${code}）${stderr.slice(-160)}`))
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
        if (message.error || (message.result && message.result.isError)) {
          finish(new Error('memory 调用出错'))
          return
        }
        answers.push(message)
        if (answers.length === calls.length) finish()
      }
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'life-decay', version: '0.2.0' } },
    })
  })
}
