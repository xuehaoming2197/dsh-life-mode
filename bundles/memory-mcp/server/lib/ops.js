/**
 * 记忆条目操作：置顶 / 取消置顶 / 归档（不是删除）/ 合并 / 统计。
 *
 * 所有图谱写入（合并的新正文、补关系）都走 mcp.js；归档只改 meta.jsonl。
 */

import {
  appendJournal,
  backupGraph,
  flattenGraph,
  loadMeta,
  mcpEndpoint,
  nowIso,
  obsKey,
  readGraphFile,
  saveMetaAtomic,
} from './core.js'
import { runMemory } from '../mcp.js'
import { buildIndex } from './index-build.js'
import { indexStats } from './recall.js'

function clone(record) {
  return JSON.parse(JSON.stringify(record))
}

function find(config, key) {
  const meta = loadMeta(config.meta)
  const record = meta.byKey.get(key)
  if (!record) throw new Error(`meta 里没有这个 key：${key}`)
  return { meta, record }
}

function journalPatch(config, op, before, after, extra = {}) {
  return appendJournal(config, {
    op,
    keys: before.map((record) => record.key),
    before: before.map(clone),
    after: after.map(clone),
    graphHash: undefined,
    ...extra,
  })
}

export function pinKey(config, key, pinned = true) {
  const { meta, record } = find(config, key)
  const before = [clone(record)]
  record.pinned = Boolean(pinned)
  if (record.pinned && record.tier === 'archive') {
    record.tier = 'active'
    delete record.archivedAt
    delete record.archiveReason
  }
  if (!record.pinned && record.tier === 'core') record.tier = 'active'
  saveMetaAtomic(config.meta, meta.records, meta.header || undefined)
  const after = [clone(record)]
  journalPatch(config, pinned ? 'pin' : 'unpin', before, after)
  return after[0]
}

export function forgetKey(config, key, reason = '手动归档') {
  const { meta, record } = find(config, key)
  const before = [clone(record)]
  record.tier = 'archive'
  record.pinned = false
  record.archivedAt = nowIso()
  record.archiveReason = reason
  saveMetaAtomic(config.meta, meta.records, meta.header || undefined)
  const after = [clone(record)]
  journalPatch(config, 'archive', before, after)
  return after[0]
}

/** 批量归档，返回 {archived, missing}；只写 meta，不动图谱。 */
export function forgetKeys(config, keys, reason = '批量归档') {
  const meta = loadMeta(config.meta)
  const before = []
  const after = []
  const missing = []
  for (const key of keys) {
    const record = meta.byKey.get(key)
    if (!record) {
      missing.push(key)
      continue
    }
    before.push(clone(record))
    record.tier = 'archive'
    record.pinned = false
    record.archivedAt = nowIso()
    record.archiveReason = reason
    after.push(clone(record))
  }
  if (before.length) {
    saveMetaAtomic(config.meta, meta.records, meta.header || undefined)
    appendJournal(config, { op: 'archive', keys: before.map((row) => row.key), before, after, note: reason })
  }
  return { archived: before.length, missing }
}

/**
 * 合并：在同一实体下新增一条合并正文，原条目标 archive（不删除）。
 * 写入前备份 memory.jsonl，写入走临时 MCP 客户端。
 */
export async function mergeKeys(config, keys, text, options = {}) {
  const unique = [...new Set(keys)]
  if (unique.length < 2) throw new Error('合并至少要两个 key')
  const body = String(text || '').trim()
  if (!body) throw new Error('合并后的正文不能为空')

  const meta = loadMeta(config.meta)
  const records = unique.map((key) => {
    const record = meta.byKey.get(key)
    if (!record) throw new Error(`meta 里没有这个 key：${key}`)
    return record
  })
  const entity = records[0].entity
  if (records.some((record) => record.entity !== entity)) throw new Error('只能合并同一实体下的条目')

  const backup = backupGraph(config, `merge ${unique.length} keys in ${entity}`)
  const newKey = obsKey(entity, body)
  await runMemory(mcpEndpoint(config), [
    {
      name: 'add_observations',
      arguments: { observations: [{ entityName: entity, contents: [body] }] },
    },
  ])

  // 重建索引，让新条目拿到默认注解，再把原条目归档。
  buildIndex(config, { write: true })
  const rebuilt = loadMeta(config.meta)
  const fresh = rebuilt.byKey.get(newKey)
  if (fresh) {
    fresh.importance = Math.max(...records.map((record) => record.importance || 3))
    fresh.pinned = records.some((record) => record.pinned)
    fresh.tier = fresh.pinned ? 'core' : 'active'
    fresh.tags = Array.from(new Set(records.flatMap((record) => record.tags || [])))
    saveMetaAtomic(config.meta, rebuilt.records, rebuilt.header || undefined)
  }

  const now = nowIso()
  const archived = unique.map((key) => {
    const record = rebuilt.byKey.get(key)
    if (!record) throw new Error(`重建后找不到 key：${key}`)
    record.tier = 'archive'
    record.pinned = false
    record.archivedAt = now
    record.archiveReason = `合并进 ${newKey}`
    record.mergedInto = newKey
    return record
  })
  saveMetaAtomic(config.meta, rebuilt.records, rebuilt.header || undefined)
  appendJournal(config, {
    op: 'merge',
    keys: unique,
    before: records.map(clone),
    after: archived.map(clone),
    newKey,
    backup: backup.file,
    note: `合并为：${body.slice(0, 80)}`,
  })

  return { newKey, entity, archived: unique.length, backup }
}

/** 只读统计：分层、置顶、重复候选、最近日志。 */
export function memoryStats(config) {
  const meta = loadMeta(config.meta)
  const graph = readGraphFile(config.graph)
  const rows = flattenGraph(graph)
  const base = indexStats(config)

  const contentGroups = new Map()
  for (const row of rows) {
    const list = contentGroups.get(row.contentHash) || []
    list.push(row)
    contentGroups.set(row.contentHash, list)
  }
  const duplicateCandidates = [...contentGroups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([hash, list]) => ({ hash, count: list.length, items: list.map((row) => ({ key: row.key, entity: row.entity, text: row.text.slice(0, 80) })) }))

  const missingMeta = rows.filter((row) => !meta.byKey.has(row.key)).length
  const pinned = meta.records.filter((record) => record.pinned).map((record) => ({ key: record.key, entity: record.entity, text: (rows.find((row) => row.key === record.key) || {}).text || '' }))

  return {
    ...base,
    entities: graph.entities.length,
    relations: graph.relations.length,
    observations: rows.length,
    indexed: meta.records.length,
    missingMeta,
    pinned: pinned.length,
    pinnedItems: pinned,
    duplicateCandidates,
    archiveReasons: [...new Set(meta.records.filter((record) => record.tier === 'archive').map((record) => record.archiveReason || '未注明'))],
  }
}

/** 按实体 + 下标解析 key（清理脚本用；下标按当前图谱顺序，0-based）。 */
export function keysByEntityIndex(config) {
  const graph = readGraphFile(config.graph)
  const map = new Map()
  for (const entity of graph.entities) {
    entity.observations.forEach((text, index) => {
      map.set(`${entity.name}#${index}`, obsKey(entity.name, text))
    })
  }
  return map
}
