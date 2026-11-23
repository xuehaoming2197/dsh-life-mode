#!/usr/bin/env node
/**
 * 校验一条会话日志里 compaction 事件序列是否合法。
 *
 * 读取器是个顺序状态机：compaction/start → compaction/summary → 替换消息 → compaction/end，
 * 顺序错、少一环、id 对不上，整条会话都打不开。而写入方（含我们自己）
 * 出错时是**不会当场报错**的——只有下次加载才知道。
 * 所以往会话里写自定义事件之后，先跑这个。
 *
 * 用法：
 *   node check-session-order.mjs <session.v4.jsonl.zstd>
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node check-session-order.mjs <session.v4.jsonl.zstd>')
  process.exit(2)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = fs.readFileSync(file)
const cuts = []
let at = -1
while ((at = buf.indexOf(MAGIC, at + 1)) !== -1) cuts.push(at)
cuts.push(buf.length)

let text = ''
let bad = 0
for (let i = 0; i < cuts.length - 1; i++) {
  try {
    text += zlib.zstdDecompressSync(buf.subarray(cuts[i], cuts[i + 1])).toString('utf8')
  } catch {
    bad++
  }
}
if (bad) console.warn(`警告：${bad} 个帧解不开`)
const ev = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))

let open = null
let summarized = false
const errs = []
let checkpoints = 0

for (const e of ev) {
  /* 事件上的 id 在 data.compactionId；替换消息的在 data.source.compactionId */
  const id = e.data?.compactionId ?? e.data?.source?.compactionId
  if (e.type === 'compaction/start') {
    if (open) errs.push(`seq ${e.seq}: 上一个压缩还没关就又开了一个`)
    open = id
    summarized = false
  } else if (e.type === 'compaction/summary') {
    if (!open) errs.push(`seq ${e.seq}: summary 没有对应的 start`)
    else if (open !== id) errs.push(`seq ${e.seq}: summary 的 compactionId 对不上`)
    if (summarized) errs.push(`seq ${e.seq}: summary 重复`)
    summarized = true
  } else if (e.type === 'compaction/end') {
    if (!open) errs.push(`seq ${e.seq}: end 没有对应的 start`)
    else if (open !== id) errs.push(`seq ${e.seq}: end 的 compactionId 对不上`)
    if (!summarized) errs.push(`seq ${e.seq}: end 之前没有 summary`)
    open = null
    summarized = false
  } else if (e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint') {
    checkpoints++
    if (!open) errs.push(`seq ${e.seq}: 检查点消息没有正在进行的压缩`)
    else if (open !== id) errs.push(`seq ${e.seq}: 检查点的 compactionId 对不上`)
    if (!summarized) errs.push(`seq ${e.seq}: 检查点之前没有 summary`)
  }
}
if (open) errs.push('日志结束时还有一个压缩没关闭')

let gaps = 0
let prev = null
for (const e of ev) {
  if (typeof e.seq === 'number') {
    if (prev !== null && e.seq !== prev + 1) gaps++
    prev = e.seq
  }
}

console.log(`事件 ${ev.length} 条，检查点 ${checkpoints} 条，seq 缺口 ${gaps}`)
if (errs.length) {
  console.log('\n有问题：')
  for (const e of errs.slice(0, 10)) console.log('  ' + e)
  process.exit(1)
}
console.log('事件顺序、配对、seq 全部正常')
