#!/usr/bin/env node
/**
 * 记忆索引 MCP 服务（零依赖，手写 JSON-RPC stdio）。
 *
 * 只读 memory.jsonl，读写 meta.jsonl；图谱正文的写入仍然转交 server-memory 的
 * 临时 stdio 客户端（merge 时），不直接改 memory.jsonl。
 *
 * 工具：memory_recall / memory_pin / memory_unpin / memory_forget / memory_merge / memory_stats
 *
 * 环境变量：
 *   MEMORY_GRAPH / MEMORY_META / MEMORY_BACKUPS
 *   MEMORY_SERVER（server-memory 的 dist/index.js，merge 用）
 */

import readline from 'node:readline'

import { paths } from './lib/core.js'
import { createRecallIndex, recall } from './lib/recall.js'
import { forgetKey, memoryStats, mergeKeys, pinKey } from './lib/ops.js'

const config = paths()
const index = createRecallIndex(config)
index.load()

const TOOLS = [
  {
    name: 'memory_recall',
    description:
      '从记忆图谱按相关度捞记忆（观察级，不是整实体）。默认只搜 core/active，不搜归档；要翻归档加 includeArchive=true。返回每条带 key，可用 memory_pin / memory_forget 操作。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找什么，中文短句或关键词。' },
        k: { type: 'integer', description: '返回几条，默认 6，最多 20。' },
        includeArchive: { type: 'boolean', description: '是否连归档一起搜，默认 false。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_pin',
    description: '把一条记忆置顶：永不被淡忘，召回时优先。key 从 memory_recall 的结果里拿。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: '16 位 key。' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_unpin',
    description: '取消置顶。',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: '16 位 key。' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description:
      '把一条记忆归档：不是删除，原文还在图谱里，只是默认不参与召回，随时可恢复。只确定过期/重复时用；不确定先问。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '16 位 key。' },
        reason: { type: 'string', description: '为什么归档，会写进 meta。' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_merge',
    description:
      '把同一实体下几条记忆合并成一条更短的正文：新增合并条，原条归档，不删除。写图谱前先备份 memory.jsonl。',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: '要合并的 16 位 key，至少两个。' },
        text: { type: 'string', description: '合并后的正文。' },
      },
      required: ['keys', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_stats',
    description: '看记忆库现状：实体/观察数、core/active/archive 分层、置顶、重复候选、归档原因。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function clip(text, max = 280) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function recallText(args) {
  const query = String((args && args.query) || '').trim()
  if (!query) throw new Error('query 不能为空')
  const k = Math.max(1, Math.min(20, Number(args.k) || 6))
  const result = recall(index, query, { k, includeArchive: Boolean(args.includeArchive), touch: true })
  if (!result.hits.length) return '没找到相关的记忆。可以换关键词，或用 includeArchive=true 翻归档。'
  return result.hits
    .map(
      (hit, i) =>
        `${i + 1}. [${hit.score}] ${hit.entity}#${hit.index}${hit.tier === 'archive' ? '（归档）' : ''}${hit.pinned ? '（置顶）' : ''}\n   key=${hit.key}\n   ${clip(hit.text)}`,
    )
    .join('\n\n')
}

async function invoke(name, args = {}) {
  switch (name) {
    case 'memory_recall':
      return recallText(args)
    case 'memory_pin': {
      const record = pinKey(config, String(args.key), true)
      return `已置顶：${record.entity}（${record.key}）`
    }
    case 'memory_unpin': {
      const record = pinKey(config, String(args.key), false)
      return `已取消置顶：${record.entity}（${record.key}）`
    }
    case 'memory_forget': {
      const record = forgetKey(config, String(args.key), String(args.reason || '手动归档'))
      return `已归档（可恢复）：${record.entity}（${record.key}）\n原因：${record.archiveReason}`
    }
    case 'memory_merge': {
      const keys = Array.isArray(args.keys) ? args.keys.map(String) : []
      if (keys.length < 2) throw new Error('至少给两个 key')
      const result = await mergeKeys(config, keys, String(args.text || ''))
      return `已合并 ${result.archived} 条 → ${result.newKey}（${result.entity}）\n备份：${result.backup.file}`
    }
    case 'memory_stats': {
      const stats = memoryStats(config)
      return [
        `实体 ${stats.entities} / 关系 ${stats.relations} / 观察 ${stats.observations}`,
        `索引 ${stats.indexed}（缺 ${stats.missingMeta}）`,
        `分层 core ${stats.byTier.core} / active ${stats.byTier.active} / archive ${stats.byTier.archive}`,
        `置顶 ${stats.pinned}`,
        `逐字重复候选 ${stats.duplicateCandidates.length} 组`,
        `归档原因：${stats.archiveReasons.join('；') || '无'}`,
      ].join('\n')
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (!message || message.jsonrpc !== '2.0') return
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id')

  try {
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'memory-index', version: '1.0.0' },
        },
      })
      return
    }

    if (message.method === 'ping') {
      if (hasId) send({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }

    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
      return
    }

    if (message.method === 'tools/call') {
      const name = message.params && message.params.name
      const args = (message.params && message.params.arguments) || {}
      try {
        const text = await invoke(name, args)
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `失败：${error && error.message ? error.message : error}` }], isError: true },
        })
      }
      return
    }

    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return

    if (hasId) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
    }
  } catch (error) {
    if (hasId) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error && error.message ? error.message : error) } })
  }
})

process.stdin.on('end', () => process.exit(0))
