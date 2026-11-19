/**
 * 建索引时的启发式：重要度、分层、标签、置顶。
 *
 * 这些只是"默认值"，写进 meta.jsonl 后就是可改的旁注；不参与图谱正文。
 * 没有 LLM 调用，全部按实体类型 + 少量人工点名的关键词算。
 */

import {
  HEADER,
  contentHash,
  dateFromEntity,
  dateFromText,
  graphInfo,
  loadMeta,
  obsKey,
  readGraphFile,
  saveMetaAtomic,
  sha16,
} from './core.js'

const TYPE_IMPORTANCE = {
  persona: 5,
  convention: 5,
  person: 5,
  project: 4,
  knowledge: 4,
  runbook: 4,
  infrastructure: 4,
  design: 3,
  tooling: 3,
  index: 3,
  collection: 3,
  nickname: 3,
  'persona-growth': 3,
  'persona journal': 3,
  'daily-log': 2,
  'deepseek-session': 2,
  audit: 2,
}

const PIN_RULES = [
  ['大肥鱼人设', () => true],
  ['大肥鱼成长', () => false],
  ['DeepSeek 峰谷约定', (text) => text.startsWith('规则：') || text.startsWith('若当前是峰时')],
  ['用户', (text) => text.startsWith('自学 C++') || text.startsWith('学校：') || text.startsWith('交流语言：')],
  ['大肥鱼', (text) => text.startsWith('DeepSeek 的中文网络昵称') || text.startsWith('用户用它称呼本 AI')],
  ['bigfish 刷B站项目', (text) => text.startsWith('路径：D:\\bigfish')],
  ['ScheduleApp 桌面日程项目', (text) => text.startsWith('【现状快照 v2')],
]

export function isHeaderEcho(entity, text) {
  return text === `来源：${entity}`
}

export function isPinned(entity, text) {
  const rule = PIN_RULES.find(([name]) => name === entity)
  return rule ? Boolean(rule[1](text)) : false
}

export function importanceFor(entity, text, entityType) {
  if (isHeaderEcho(entity, text)) return 1
  if (entity === '用户') {
    if (text.startsWith('自学 C++') || text.startsWith('学校：') || text.startsWith('交流语言：')) return 5
  }
  if (entity === '大肥鱼') return 4
  if (entity === 'bigfish 刷B站项目' && text.startsWith('路径：')) return 4
  if (entity === 'ScheduleApp 桌面日程项目' && text.startsWith('【现状快照 v2')) return 4
  return TYPE_IMPORTANCE[entityType] ?? 3
}

export function tagsFor(entity, text, entityType) {
  const tags = new Set([`type:${entityType || 'unknown'}`])
  const name = String(entity)

  if (isHeaderEcho(entity, text)) tags.add('header')
  if (/ScheduleApp/.test(name)) tags.add('project:scheduleapp')
  if (/bigfish|刷B站/.test(name)) tags.add('project:bigfish')
  if (/峰谷|峰时|谷时/.test(name) || /峰时|峰谷|谷时/.test(text)) tags.add('topic:peak')
  if (/人设|成长|persona|自我/.test(name)) tags.add('persona')
  if (/DS会话|战略|对话档案|deepseek-archive/.test(name)) tags.add('archive:deepseek')
  if (/Windows 桌面自动化|gui-demo|充值/.test(name)) tags.add('topic:desktop-automation')
  if (name === '用户') tags.add('person')
  if (/知识图谱体检/.test(name)) tags.add('audit')

  return [...tags]
}

/**
 * 从图谱生成 meta 记录。保留旧 meta 里的 annotations：
 * importance / pinned / tier / lastUsedAt / uses / tags / archivedAt / archiveReason。
 */
export function buildIndex(config, options = {}) {
  const info = graphInfo(config.graph)
  const graph = readGraphFile(config.graph)

  const previous = options.fresh
    ? { header: null, records: [], byKey: new Map(), byEntity: new Map(), exists: false }
    : loadMeta(config.meta)
  const records = []
  const seen = new Set()
  let stickyMoved = 0
  let preserved = 0

  for (const entity of graph.entities) {
    const entityType = entity.entityType || ''
    const observations = Array.isArray(entity.observations) ? entity.observations : []
    for (const text of observations) {
      const key = obsKey(entity.name, text)
      let prev = previous.byKey.get(key)
      let sticky = Boolean(prev && prev.sticky)
      if (observations.length === 1 && entityType === 'persona') sticky = true

      // 单条可变实体（人设）的 key 会随改写变化：按实体继承一次。
      if (!prev && observations.length === 1) {
        const candidates = (previous.byEntity.get(entity.name) || []).filter((row) => row.sticky)
        if (candidates.length === 1) {
          prev = candidates[0]
          sticky = true
          stickyMoved += 1
        }
      }

      if (prev) preserved += 1

      const pinned = prev && typeof prev.pinned === 'boolean' ? prev.pinned : isPinned(entity.name, text)
      const header = isHeaderEcho(entity.name, text)
      const tier = prev && prev.tier ? prev.tier : pinned ? 'core' : header ? 'archive' : 'active'
      const createdAt =
        (prev && prev.createdAt) || dateFromText(text) || dateFromEntity(entity.name) || info.mtime
      const tags = Array.from(new Set([...(prev && Array.isArray(prev.tags) ? prev.tags : []), ...tagsFor(entity.name, text, entityType)]))

      records.push({
        key,
        entity: entity.name,
        hash: sha16(text),
        contentHash: contentHash(text),
        importance: prev && Number.isFinite(prev.importance) ? prev.importance : importanceFor(entity.name, text, entityType),
        pinned,
        tier,
        createdAt,
        lastUsedAt: (prev && prev.lastUsedAt) || null,
        uses: (prev && Number.isFinite(prev.uses) ? prev.uses : 0) | 0,
        tags,
        ...(sticky ? { sticky: true } : {}),
        ...(prev && prev.archivedAt ? { archivedAt: prev.archivedAt } : {}),
        ...(prev && prev.archiveReason ? { archiveReason: prev.archiveReason } : {}),
        ...(prev && prev.mergedInto ? { mergedInto: prev.mergedInto } : {}),
      })
      seen.add(key)
    }
  }

  const tiers = { core: 0, active: 0, archive: 0 }
  const importance = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const record of records) {
    tiers[record.tier] = (tiers[record.tier] || 0) + 1
    importance[record.importance] = (importance[record.importance] || 0) + 1
  }

  const stats = {
    entities: graph.entities.length,
    observations: records.length,
    tiers,
    importance,
    preserved,
    stickyMoved,
    orphans: previous.records.filter((row) => !seen.has(row.key)).length,
    graph: info,
  }

  let metaHash = null
  if (options.write !== false) {
    metaHash = saveMetaAtomic(config.meta, records, HEADER)
  }

  return { records, stats, metaHash }
}
