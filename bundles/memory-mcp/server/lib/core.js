/**
 * 记忆索引核心：key / 归一化 / meta.jsonl 读写 / 备份 / 日志。
 *
 * 约束：
 *   · 只读 memory.jsonl（解析容错，写回半行不炸）；
 *   · 所有图谱写入走 mcp.js 的临时 stdio 客户端，本文件不写 memory.jsonl；
 *   · meta.jsonl 是派生旁注，可以从图谱完整重建（annotations 存在时可继承）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { readGraph } from '../mcp.js'

export const SCHEMA_VERSION = 1
export const HEADER = {
  _meta: true,
  schemaVersion: SCHEMA_VERSION,
  generator: 'memory-plugin/rebuild',
  keyRule: 'sha256(entity + "\\0" + normalize(observation))[:16]',
}

const PUNCT = /[\s\u3000，。、；：！？,.;:!?（）()\[\]【】「」『』“”"'`~～!！?？…—\-·<>《》|]+/g

export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(PUNCT, '')
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function sha16(text) {
  return sha256(text).slice(0, 16)
}

/** key = sha256(entity + "\0" + 归一化 observation)[:16] */
export function obsKey(entity, text) {
  return sha16(`${entity}\u0000${normalizeText(text)}`)
}

export function contentHash(text) {
  return sha16(normalizeText(text))
}

export function fileHash(file) {
  return sha256(fs.readFileSync(file))
}

export function nowIso() {
  return new Date().toISOString()
}

export function paths(config = {}) {
  const graph = config.graph || process.env.MEMORY_GRAPH || 'D:\\mcp\\server-memory\\memory.jsonl'
  const dir = path.dirname(graph)
  return {
    graph,
    meta: config.meta || process.env.MEMORY_META || path.join(dir, 'meta.jsonl'),
    journal: config.journal || process.env.MEMORY_JOURNAL || path.join(dir, 'meta.journal.jsonl'),
    backups: config.backups || process.env.MEMORY_BACKUPS || path.join(dir, 'backups'),
  }
}

export function mcpEndpoint(config = {}) {
  return {
    node: config.node || process.env.MEMORY_NODE || process.execPath || 'node',
    server:
      config.server ||
      process.env.MEMORY_SERVER ||
      'D:\\mcp\\server-memory\\node_modules\\@modelcontextprotocol\\server-memory\\dist\\index.js',
    file: config.graph || process.env.MEMORY_GRAPH || 'D:\\mcp\\server-memory\\memory.jsonl',
    cwd: config.cwd || process.env.MEMORY_CWD || 'D:\\mcp\\server-memory',
  }
}

/* --------------------------------------------------------------- 图谱读取 */

export function readGraphFile(file) {
  return readGraph(file)
}

export function graphInfo(file) {
  const stat = fs.statSync(file)
  const graph = readGraph(file)
  return {
    file,
    mtimeMs: stat.mtimeMs,
    mtime: new Date(stat.mtimeMs).toISOString(),
    size: stat.size,
    hash: fileHash(file),
    entities: graph.entities.length,
    relations: graph.relations.length,
    observations: graph.entities.reduce((sum, entity) => sum + entity.observations.length, 0),
  }
}

/** 返回 [{entity, entityType, index, text, key, hash, contentHash}]，保持文件顺序。 */
export function flattenGraph(graph) {
  const rows = []
  for (const entity of graph.entities) {
    entity.observations.forEach((text, index) => {
      rows.push({
        entity: entity.name,
        entityType: entity.entityType,
        index,
        text,
        key: obsKey(entity.name, text),
        hash: sha16(text),
        contentHash: contentHash(text),
      })
    })
  }
  return rows
}

/* ------------------------------------------------------------------- meta */

export function loadMeta(file) {
  const records = []
  let header = null
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { header: null, records, byKey: new Map(), byEntity: new Map(), exists: false }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] !== '{') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row && row._meta) {
      header = row
      continue
    }
    if (!row || typeof row.key !== 'string' || typeof row.entity !== 'string') continue
    records.push(row)
  }
  const byKey = new Map()
  const byEntity = new Map()
  for (const record of records) {
    byKey.set(record.key, record)
    if (!byEntity.has(record.entity)) byEntity.set(record.entity, [])
    byEntity.get(record.entity).push(record)
  }
  return { header, records, byKey, byEntity, exists: true }
}

export function saveMetaAtomic(file, records, header = HEADER) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [JSON.stringify(header)]
  for (const record of records) lines.push(JSON.stringify(record))
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return fileHash(file)
}

/** 改一条记录（按 key），保持顺序；返回是否找到。 */
export function patchRecord(meta, key, patch) {
  const record = meta.byKey.get(key)
  if (!record) return false
  Object.assign(record, patch)
  return true
}

/* ------------------------------------------------------------------ 备份 */

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function backupGraph(config, reason = 'manual') {
  const { graph, backups } = paths(config)
  fs.mkdirSync(backups, { recursive: true })
  let target = path.join(backups, `memory-${stamp()}.jsonl`)
  let n = 1
  while (fs.existsSync(target)) {
    target = path.join(backups, `memory-${stamp()}-${n}.jsonl`)
    n += 1
  }
  fs.copyFileSync(graph, target)
  const hash = fileHash(target)
  const sidecar = {
    file: path.basename(target),
    createdAt: nowIso(),
    reason,
    size: fs.statSync(target).size,
    sha256: hash,
  }
  fs.writeFileSync(`${target}.json`, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8')
  return { file: target, hash, size: sidecar.size, reason }
}

export function backupMeta(config, reason = 'manual') {
  const { meta, backups } = paths(config)
  if (!fs.existsSync(meta)) return null
  fs.mkdirSync(backups, { recursive: true })
  const target = path.join(backups, `meta-${stamp()}.jsonl`)
  fs.copyFileSync(meta, target)
  return { file: target, hash: fileHash(target), reason }
}

export function listBackups(config) {
  const { backups } = paths(config)
  let names = []
  try {
    names = fs.readdirSync(backups).filter((name) => /^memory-.*\.jsonl$/.test(name))
  } catch {
    return []
  }
  return names.sort().map((name) => {
    const file = path.join(backups, name)
    let sidecar = null
    try {
      sidecar = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'))
    } catch {}
    return { file, name, size: fs.statSync(file).size, sidecar }
  })
}

/** 保留最近 keep 份（按文件名时间倒序）；pre-restore 永远保留。 */
export function pruneBackups(config, keep = 7) {
  const all = listBackups(config)
  const removable = all.filter((item) => !item.name.includes('pre-restore'))
  const drop = removable.slice(0, Math.max(0, removable.length - keep))
  for (const item of drop) {
    try {
      fs.unlinkSync(item.file)
      try {
        fs.unlinkSync(`${item.file}.json`)
      } catch {}
    } catch {}
  }
  return drop.map((item) => item.name)
}

/** 应急恢复：直接把备份覆盖回图谱。这是唯一绕过 MCP 的写路径。 */
export function restoreGraph(config, backupFile, reason = 'restore') {
  const { graph } = paths(config)
  if (!fs.existsSync(backupFile)) throw new Error(`备份不存在：${backupFile}`)
  const before = backupGraph(config, `before-restore: ${reason}`)
  fs.copyFileSync(backupFile, graph)
  return { restored: backupFile, safety: before, hash: fileHash(graph) }
}

/* ------------------------------------------------------------------ 日志 */

export function appendJournal(config, entry) {
  const { journal } = paths(config)
  fs.mkdirSync(path.dirname(journal), { recursive: true })
  const row = { ts: nowIso(), ...entry }
  fs.appendFileSync(journal, `${JSON.stringify(row)}\n`, 'utf8')
  return row
}

export function readJournal(config, limit = 5) {
  const { journal } = paths(config)
  let text = ''
  try {
    text = fs.readFileSync(journal, 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .slice(-limit)
}

/* ------------------------------------------------------------------ 日期 */

const DATE_RE = /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/
const ENTITY_DATE_RE = /(20\d{2})-(\d{2})-(\d{2})/

export function dateFromText(text) {
  const match = DATE_RE.exec(String(text || ''))
  if (!match) return null
  const [, y, m, d] = match
  const month = String(m).padStart(2, '0')
  const day = String(d).padStart(2, '0')
  return `${y}-${month}-${day}T00:00:00.000Z`
}

export function dateFromEntity(name) {
  const match = ENTITY_DATE_RE.exec(String(name || ''))
  if (!match) return null
  return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return 0
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return 0
  return Math.max(0, (now - time) / 86400000)
}

export function short(text, max = 160) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
