/**
 * 打分召回（零依赖，中文用字符 2-gram）。
 *
 *   score = 0.45 * relevance + 0.35 * (importance / 5) + 0.20 * recency
 *   relevance = 文本 2-gram（整条 Dice / 最佳分句）
 *             + 实体名命中加权（查询点名了某个实体，就优先它自己的条目）
 *   recency   = exp(-Δdays / 30)，pinned 恒为 1
 *
 * 同分：importance 降序 → lastUsedAt 降序 → key 升序。
 */

import fs from 'node:fs'

import {
  daysSince,
  flattenGraph,
  loadMeta,
  normalizeText,
  readGraphFile,
  saveMetaAtomic,
  short,
} from './core.js'

const CLAUSE_SPLIT = /[；;。\n]/

// 查询侧的小词典：只处理"提问壳"和几个高频同义词，不做语义理解。
const QUERY_REWRITES = [
  [/多少门课|几门课/g, '课程'],
  [/多少节课|几节课/g, '课程 节次'],
  [/放在哪|放在哪里|放哪/g, '路径'],
  [/色号|配色|颜色/g, '主色'],
  [/绕过/g, '绕开'],
  [/现在|目前|请问|帮我|告诉我|说一下|是多少|是什么|有哪些|有什么|为什么|为何|怎么|怎样|如何|多少|几点|哪个|哪些|什么|啥|吗|呢|吧|呀|啊/g, ' '],
]

const ENTITY_SPLIT = /[\s\u3000·（）()【】「」『』:：,，、/与和]+/

// 几个缩写/别名，避免把实体全名硬塞进查询才认得出。
// 也是 auto-recall 插件判断"这条查询点到谁了"的依据，所以别放通用词（大肥鱼/开发/大方向）。
export const EXTRA_ALIASES = {
  'C++自学项目': ['C++'],
  'bigfish 刷B站项目': ['bigfish', '刷B站', 'B站'],
  'DS会话: 英语词缀与定语从句': ['英语词缀', '定语从句'],
  'DS会话: C 语言基础答疑（float/double/int 等）': ['C 语言', 'C语言'],
  'DeepSeek 峰谷约定': ['峰谷约定', '峰谷', '峰时', '谷时'],
  '知识图谱体检 2026-10-28': ['知识图谱体检', '图谱体检'],
  'ScheduleApp 桌面日程项目': ['ScheduleApp', '日程', '课表'],
  '大肥鱼人设层（DSH persona）': ['人设层', 'persona'],
  'QQ 接入（dsh-qq-bridge）': ['qq小号', 'qq桥', 'qq接入'],
  'QQ小号李田所': ['李田所'],
  'DSH 工作区总览插件': ['工作区总览', '总览插件', 'workspaceoverview'],
  'DSH 充值操作手册（点屏版）': ['充值手册', '充值', '点屏'],
  'DeepSeek 对话档案': ['对话档案', '档案'],
  'Windows 开机自启（本机实测方案）': ['开机自启', '自启'],
  'Windows 桌面自动化（鼠标/键盘/屏幕）': ['桌面自动化', '鼠标键盘', '屏幕坐标'],
  'Windows桌面自动化（鼠标键盘）': ['桌面自动化', '鼠标键盘', '屏幕坐标'],
  '峰谷暂停与充值联动设计': ['峰谷暂停', '充值联动'],
  'dsh-self-notes': ['selfnotes', '自记'],
}

function gramCounts(normalized) {
  const counts = new Map()
  if (normalized.length < 2) {
    if (normalized) counts.set(normalized, 1)
    return counts
  }
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  return counts
}

function diceCounts(a, b, bSize) {
  if (!a.size || !b.size) return 0
  let sizeA = 0
  for (const count of a.values()) sizeA += count
  let intersection = 0
  for (const [gram, count] of a) {
    const other = b.get(gram)
    if (other) intersection += Math.min(count, other)
  }
  return (2 * intersection) / (sizeA + bSize)
}

function sizeOf(counts) {
  let size = 0
  for (const count of counts.values()) size += count
  return size
}

function overlapCount(a, b) {
  let intersection = 0
  for (const [gram, count] of a) {
    const other = b.get(gram)
    if (other) intersection += Math.min(count, other)
  }
  return intersection
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function prepareQuery(query) {
  let text = String(query || '')
  for (const [pattern, replacement] of QUERY_REWRITES) text = text.replace(pattern, replacement)
  return normalizeText(text)
}

/** 实体的全部可识别叫法（归一化后），长的排前面。 */
function aliasesFor(entity) {
  const set = new Set()
  const add = (value) => {
    const norm = normalizeText(value)
    if (norm.length >= 2) set.add(norm)
  }
  add(entity)
  for (const part of String(entity || '').split(ENTITY_SPLIT)) add(part)
  for (const extra of EXTRA_ALIASES[entity] || []) add(extra)
  return [...set].sort((a, b) => b.length - a.length)
}

/** 读取并缓存索引；图谱或 meta 的 mtime 变了就重建。 */
export function createRecallIndex(config) {
  let cache = null

  function mtime(file) {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return 0
    }
  }

  function load(force = false) {
    const key = `${mtime(config.graph)}|${mtime(config.meta)}`
    if (!force && cache && cache.key === key) return cache

    const graph = readGraphFile(config.graph)
    const meta = loadMeta(config.meta)
    const rows = flattenGraph(graph)
    let graphMtime = null
    try {
      graphMtime = new Date(fs.statSync(config.graph).mtimeMs).toISOString()
    } catch {}

    const aliasMap = new Map()
    const aliasIndex = []
    for (const entity of graph.entities) {
      const aliases = aliasesFor(entity.name)
      aliasMap.set(entity.name, aliases)
      for (const alias of aliases) aliasIndex.push({ entity: entity.name, alias })
    }
    aliasIndex.sort((a, b) => b.alias.length - a.alias.length)

    const docs = rows.map((row) => {
      const record = meta.byKey.get(row.key)
      const normalized = normalizeText(row.text)
      const grams = gramCounts(normalized)
      const clauses = String(row.text)
        .split(CLAUSE_SPLIT)
        .map((part) => normalizeText(part))
        .filter((part) => part.length >= 4)
      return {
        ...row,
        grams,
        gramSize: sizeOf(grams),
        clauses: clauses.map((clause) => {
          const counts = gramCounts(clause)
          return { counts, size: sizeOf(counts) }
        }),
        record: record || null,
        importance: record ? record.importance : 3,
        pinned: record ? Boolean(record.pinned) : false,
        tier: record ? record.tier : 'active',
        createdAt: (record && record.createdAt) || graphMtime,
        lastUsedAt: record ? record.lastUsedAt : null,
        uses: record ? record.uses : 0,
        tags: record ? record.tags : [],
      }
    })

    cache = { key, meta, docs, rows, aliasMap, aliasIndex, graphMtime, loadedAt: Date.now() }
    return cache
  }

  return { load, config }
}

/** 查询里点到了哪些实体：entity -> {chars, count}。 */
function detectNamed(cache, queryNorm) {
  const named = new Map()
  for (const { entity, alias } of cache.aliasIndex) {
    if (!queryNorm.includes(alias)) continue
    const current = named.get(entity) || { chars: 0, count: 0 }
    current.chars = Math.max(current.chars, alias.length)
    current.count += 1
    named.set(entity, current)
  }
  return named
}

function stripAliases(queryNorm, aliases) {
  let text = queryNorm
  let hit = false
  for (const alias of aliases) {
    if (alias.length >= 2 && text.includes(alias)) {
      hit = true
      text = text.split(alias).join(' ')
    }
  }
  return { hit, text: text.trim() }
}

export function recall(index, query, options = {}) {
  const started = process.hrtime.bigint()
  const cache = index.load()
  const k = Math.max(1, Math.min(50, Number(options.k) || 6))
  const includeArchive = Boolean(options.includeArchive)
  const touch = Boolean(options.touch)
  const now = options.now || Date.now()

  const baseText = prepareQuery(query)
  if (!baseText) return { query, hits: [], tookMs: 0, scanned: 0, total: cache.docs.length }

  const baseGrams = gramCounts(baseText)
  const baseSize = sizeOf(baseGrams)
  const variantCache = new Map()
  const gramsFor = (text) => {
    if (!variantCache.has(text)) {
      const grams = gramCounts(text)
      variantCache.set(text, { grams, size: sizeOf(grams) })
    }
    return variantCache.get(text)
  }

  const named = detectNamed(cache, baseText)
  const hasNamed = named.size > 0

  const hits = []
  for (const doc of cache.docs) {
    if (doc.tier === 'archive' && !includeArchive) continue

    const info = named.get(doc.entity)
    const aliases = cache.aliasMap.get(doc.entity) || []
    const variant = stripAliases(baseText, aliases)
    const effective = variant.text || baseText
    const q = effective === baseText ? { grams: baseGrams, size: baseSize } : gramsFor(effective)

    const whole = diceCounts(q.grams, doc.grams, doc.gramSize)
    const coverage = q.size ? overlapCount(q.grams, doc.grams) / q.size : 0
    let bestClause = 0
    for (const clause of doc.clauses) {
      const value = diceCounts(q.grams, clause.counts, clause.size)
      if (value > bestClause) bestClause = value
    }
    let relevance = Math.max(whole, coverage * 0.8, bestClause * 0.95)

    // 查询点名了实体：优先它自己的条目，压掉"只是提到这个名字"的其它实体。
    if (info) {
      const bonus = Math.min(0.5, 0.08 * info.chars + 0.08 * info.count)
      relevance = clamp01(relevance + bonus)
    } else if (hasNamed) {
      relevance *= 0.55
    }

    const importance = clamp01(Number(doc.importance) / 5)
    const recency = doc.pinned ? 1 : Math.exp(-daysSince(doc.createdAt, now) / 30)
    const score = 0.45 * relevance + 0.35 * importance + 0.2 * recency

    if (relevance <= 0.01 && !info) continue

    hits.push({
      key: doc.key,
      entity: doc.entity,
      entityType: doc.entityType,
      index: doc.index,
      text: doc.text,
      preview: short(doc.text, 220),
      score: Number(score.toFixed(4)),
      relevance: Number(relevance.toFixed(4)),
      importance: doc.importance,
      recency: Number(recency.toFixed(4)),
      pinned: doc.pinned,
      tier: doc.tier,
      createdAt: doc.createdAt,
      lastUsedAt: doc.lastUsedAt,
      uses: doc.uses,
      tags: doc.tags,
      nameHit: Boolean(info),
    })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.importance !== a.importance) return b.importance - a.importance
    const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
    const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
    if (bt !== at) return bt - at
    return a.key < b.key ? -1 : 1
  })

  const top = hits.slice(0, k)

  if (touch && top.length) {
    const meta = cache.meta
    const stamp = new Date(now).toISOString()
    let changed = 0
    for (const hit of top) {
      const record = meta.byKey.get(hit.key)
      if (!record) continue
      record.lastUsedAt = stamp
      record.uses = (Number(record.uses) || 0) + 1
      changed += 1
    }
    if (changed) {
      saveMetaAtomic(index.config.meta, meta.records, meta.header || undefined)
      // 不整份重建索引：只把 mtime 推进，并就地更新命中条目的使用计数。
      try {
        cache.key = `${fs.statSync(index.config.graph).mtimeMs}|${fs.statSync(index.config.meta).mtimeMs}`
      } catch {}
      for (const hit of top) {
        const doc = cache.docs.find((item) => item.key === hit.key)
        if (doc) {
          doc.lastUsedAt = stamp
          doc.uses = (Number(doc.uses) || 0) + 1
        }
      }
    }
  }

  const tookMs = Number(process.hrtime.bigint() - started) / 1e6
  return {
    query,
    hits: top,
    tookMs: Number(tookMs.toFixed(2)),
    scanned: cache.docs.length,
    total: cache.docs.length,
    archived: cache.docs.filter((doc) => doc.tier === 'archive').length,
  }
}

/** 给统计/调试用：不按查询，直接看分层分布。 */
export function indexStats(config) {
  const index = createRecallIndex(config)
  const cache = index.load()
  const byTier = { core: 0, active: 0, archive: 0 }
  const byEntityType = new Map()
  for (const doc of cache.docs) {
    byTier[doc.tier] = (byTier[doc.tier] || 0) + 1
    const type = doc.entityType || 'unknown'
    byEntityType.set(type, (byEntityType.get(type) || 0) + 1)
  }
  return {
    entities: new Set(cache.docs.map((doc) => doc.entity)).size,
    observations: cache.docs.length,
    byTier,
    byEntityType: Object.fromEntries([...byEntityType.entries()].sort()),
  }
}
