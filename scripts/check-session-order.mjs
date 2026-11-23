#!/usr/bin/env node
/**
 * 校验一条会话日志里 compaction 事件序列是否合法。
 *
 * 读取器是个顺序状态机，两件事都要成立，否则整条会话打不开：
 *   1. compaction/start → compaction/summary → 替换消息 → compaction/end，顺序与 id 对得上
 *   2. compaction/summary 里的 shadowedSeqs **必须精确等于当时 surface 上的那一段**
 *
 * 第 2 条最容易错：按 seq 连续段去取，会把 step/start、tool/call 这些不进 surface 的事件
 * 也算进去（136 条 vs 真正 39 条），加载时就报格式错。
 *
 * 写入方出错**当场不会报**，只有下次加载才知道。所以写完自定义事件先跑这个。
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

const errs = []
const surface = []
let open = null
let summarized = false
let checkpoints = 0
let spansChecked = 0

for (const e of ev) {
  const id = e.data?.compactionId ?? e.data?.source?.compactionId

  /* —— 先校验，再应用 surfaceOp：summary 说的是「替换前」的那一段 —— */
  if (e.type === 'compaction/summary') {
    if (!open) errs.push(`seq ${e.seq}: summary 没有对应的 start`)
    else if (open !== id) errs.push(`seq ${e.seq}: summary 的 compactionId 对不上`)
    if (summarized) errs.push(`seq ${e.seq}: summary 重复`)
    summarized = true

    const range = e.data?.shadowedRange || {}
    const seqs = e.data?.shadowedSeqs || []
    const i = surface.indexOf(range.start)
    const j = surface.indexOf(range.end)
    if (i < 0 || j < i) {
      errs.push(`seq ${e.seq}: 替换区间 ${range.start}-${range.end} 不是当前 surface 上的一段`)
    } else {
      const slice = surface.slice(i, j + 1)
      spansChecked++
      if (slice.length !== seqs.length || slice.some((s, k) => s !== seqs[k])) {
        errs.push(
          `seq ${e.seq}: shadowedSeqs 与 surface 不符（写了 ${seqs.length} 条，实际 ${slice.length} 条）`,
        )
      }
    }
    continue
  }

  if (e.type === 'compaction/start') {
    if (open) errs.push(`seq ${e.seq}: 上一个压缩还没关就又开了一个`)
    open = id
    summarized = false
    continue
  }

  if (e.type === 'compaction/end') {
    if (!open) errs.push(`seq ${e.seq}: end 没有对应的 start`)
    else if (open !== id) errs.push(`seq ${e.seq}: end 的 compactionId 对不上`)
    if (!summarized) errs.push(`seq ${e.seq}: end 之前没有 summary`)
    open = null
    summarized = false
    continue
  }

  if (e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint') {
    checkpoints++
    if (!open) errs.push(`seq ${e.seq}: 检查点消息没有正在进行的压缩`)
    else if (open !== id) errs.push(`seq ${e.seq}: 检查点的 compactionId 对不上`)
    if (!summarized) errs.push(`seq ${e.seq}: 检查点之前没有 summary`)
  }

  /* —— 应用 surface 变化 —— */
  if (e.surfaceOp === 'append') {
    surface.push(e.seq)
  } else if (e.surfaceOp && e.surfaceOp.op === 'replace') {
    const i = surface.indexOf(e.surfaceOp.startSeq)
    const j = surface.indexOf(e.surfaceOp.endSeq)
    if (i < 0 || j < i) {
      errs.push(`seq ${e.seq}: 替换区间 ${e.surfaceOp.startSeq}-${e.surfaceOp.endSeq} 不在 surface 上`)
    } else {
      surface.splice(i, j - i + 1, e.seq)
    }
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

console.log(`事件 ${ev.length} 条，检查点 ${checkpoints} 条，校验替换区间 ${spansChecked} 处，seq 缺口 ${gaps}`)
console.log(`最终 surface ${surface.length} 个节点`)
if (errs.length) {
  console.log('\n有问题：')
  for (const e of errs.slice(0, 10)) console.log('  ' + e)
  process.exit(1)
}
console.log('事件顺序、配对、假区间、surface 切片全部正常')
