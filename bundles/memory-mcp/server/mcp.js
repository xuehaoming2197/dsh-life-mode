/**
 * 和本地 memory MCP 服务打交道的最小实现（零依赖）。
 * 从 persona-plugin/memory.js 原样搬来，只改了 header；两处保持独立，避免插件互相 import。
 *
 * 读：直接解析 memory.jsonl（只读；服务端每次操作是「加锁 → 重读 → 整体写回」，
 *     这个单文件就是真相；容忍写回过程中的半行）。
 * 写：spawn 一个临时 stdio 客户端，initialize → tools/call → 退出。
 *     服务端自己加锁，和宿主那个常驻实例并存是安全的。
 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'

/** 解析图谱文件，返回 { entities, relations }。坏行直接跳过，不抛。 */
export function readGraph(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { entities: [], relations: [] }
  }
  const entities = []
  const relations = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] !== '{') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue // 写回中的半行
    }
    if (!row || typeof row !== 'object') continue
    if (row.type === 'entity' && typeof row.name === 'string') {
      entities.push({
        name: row.name,
        entityType: row.entityType,
        observations: Array.isArray(row.observations) ? row.observations.filter((item) => typeof item === 'string') : [],
      })
    } else if (row.type === 'relation') {
      relations.push(row)
    }
  }
  return { entities, relations }
}

export function findEntity(graph, name) {
  return graph.entities.find((entity) => entity.name === name)
}

/**
 * 在一个临时连接里依次调用若干 MCP 工具。
 * @returns {Promise<Array<{result?: any, error?: {message: string}}>>}
 */
export function callMemory(endpoint, calls, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000
  const list = Array.isArray(calls) ? calls : []

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(endpoint.node, [endpoint.server], {
        cwd: endpoint.cwd || undefined,
        env: { ...process.env, MEMORY_FILE_PATH: endpoint.file },
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
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // 已经退了
      }
      if (error) reject(error)
      else resolve(list.map((_call, index) => answers.get(index + 2)))
    }

    const timer = setTimeout(() => finish(new Error(`memory 服务超时（${timeoutMs}ms）`)), timeoutMs)

    const send = (payload) => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch {
        // stdin 已关，交给 exit 处理
      }
    }

    child.on('error', (error) => finish(new Error(`起不了 memory 服务：${error.message}`)))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => {
      if (!done) finish(new Error(`memory 服务提前退出（code ${code}）：${stderr.slice(-300)}`))
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
            finish(new Error(`memory 服务握手失败：${message.error.message || 'unknown'}`))
            return
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          list.forEach((call, offset) => {
            send({ jsonrpc: '2.0', id: offset + 2, method: 'tools/call', params: { name: call.name, arguments: call.arguments || {} } })
          })
          continue
        }

        answers.set(message.id, message)
        if (answers.size === list.length) finish()
      }
    })

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-bigfish-memory', version: '1.0.0' },
      },
    })
  })
}

/** 调用并检查错误；返回原始 reply 数组。 */
export async function runMemory(endpoint, calls, options = {}) {
  const replies = await callMemory(endpoint, calls, options)
  for (const reply of replies) {
    if (!reply) throw new Error('memory 服务没有回应')
    if (reply.error) throw new Error(reply.error.message || 'MCP 调用失败')
    if (reply.result && reply.result.isError) {
      const text = (reply.result.content || [])
        .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
      throw new Error(text || 'MCP 工具返回错误')
    }
  }
  return replies
}
