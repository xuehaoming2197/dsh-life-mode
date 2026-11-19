#!/usr/bin/env node
/**
 * 生活模式状态一览：
 *   node scripts/status.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* 数据目录：和插件用同一套规则，LIFE_MODE_HOME 可覆盖 */
const HOME = process.env.LIFE_MODE_HOME || path.join(os.homedir(), '.dsh', 'life-mode')
const GRAPH = path.join(HOME, 'memory', 'memory.jsonl')
const META = path.join(HOME, 'memory', 'meta.jsonl')
const LOG = path.join(HOME, 'life-context.log')
const STYLE = path.join(HOME, 'persona', 'life-style.md')
const CONFIG = path.join(HOME, 'bundles', 'life-context', 'config.json')

const lines = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const meta = new Map()
for (const line of lines(META)) {
  try {
    const row = JSON.parse(line)
    if (row && row.key) meta.set(row.key, row)
  } catch {}
}

let observations = 0
let entities = 0
const perEntity = new Map()
for (const line of lines(GRAPH)) {
  try {
    const row = JSON.parse(line)
    if (!row || row.type !== 'entity' || !Array.isArray(row.observations)) continue
    entities++
    observations += row.observations.length
    perEntity.set(row.name, row.observations.length)
  } catch {}
}

const tiers = { core: 0, active: 0, archive: 0 }
for (const record of meta.values()) tiers[record.tier] = (tiers[record.tier] || 0) + 1

let styleChars = 0
try {
  styleChars = fs.readFileSync(STYLE, 'utf8').trim().length
} catch {}

let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
} catch {}

const logTail = lines(LOG).slice(-5)
const flowCount = perEntity.get(cfg.autoWriteEntity || '生活·流水') || 0

console.log('# 生活模式状态')
console.log('')
console.log(`记忆：${entities} 个实体 / ${observations} 条观察`)
console.log(`分层：core ${tiers.core} / active ${tiers.active} / archive ${tiers.archive}`)
console.log(`流水实体「${cfg.autoWriteEntity || '生活·流水'}」：${flowCount} 条`)
console.log(`性格文件：${styleChars} 字`)
console.log('')
console.log('参数：')
console.log(`  k=${cfg.k}  maxChars=${cfg.maxChars}  半衰期=${cfg.halfLifeDays}天  autoWrite=${cfg.autoWrite}`)
console.log(`  画像实体=${JSON.stringify(cfg.profileEntities || [])}  去重=${cfg.autoWriteDedupeMinutes}分钟`)
console.log('')
console.log('最近注入：')
for (const line of logTail) console.log(`  ${line}`)
