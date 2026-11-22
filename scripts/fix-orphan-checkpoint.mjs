#!/usr/bin/env node
/**
 * 修「孤儿 checkpoint」：有一条 compaction 检查点消息，但没有配对的 compaction/start。
 *
 * 症状：会话打不开，报
 *   SessionFormatError: compaction checkpoint has no matching compaction/start
 *
 * 成因：写入方自己 append 了 source.kind = 'compact-checkpoint' 的替换消息，
 * 却没按顺序写 compaction/start → compaction/summary → 替换 → compaction/end。
 * 读取器是顺序状态机，遇到没有开启压缩的检查点就抛。
 *
 * 修法：把那条消息的 source 降级成普通用户消息。surfaceOp 不动，所以压缩效果还在，
 * 只是它不再被当成「压缩检查点」，状态机就不检查它了。
 *
 * 用法：
 *   node fix-orphan-checkpoint.mjs <session.v4.jsonl.zstd>            # 只诊断
 *   node fix-orphan-checkpoint.mjs <session.v4.jsonl.zstd> --apply    # 真改（会先备份）
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const apply = process.argv.includes('--apply')
if (!file) {
  console.error('用法: node fix-orphan-checkpoint.mjs <session.v4.jsonl.zstd> [--apply]')
  process.exit(2)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
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
  if (bad) console.warn(`警告：${bad} 个帧解不开，已跳过`)
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function encode(events) {
  if (events[0]?.type !== 'session') throw new Error('第一行不是 session 头，文件名可能不对')
  const enc = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'))
  /* 首帧只能装会话头这一行，剩下一个事件一帧 */
  const parts = [enc(JSON.stringify(events[0]) + '\n')]
  for (let i = 1; i < events.length; i++) parts.push(enc(JSON.stringify(events[i]) + '\n'))
  return Buffer.concat(parts)
}

const events = decode(file)
console.log(`事件 ${events.length} 条，seq ${events[0]?.seq} → ${events[events.length - 1]?.seq}`)

const checkpoints = events.filter(
  (e) => e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint',
)
console.log(`checkpoint 消息 ${checkpoints.length} 条`)

const orphans = checkpoints.filter((e) => {
  const id = e.data.source.compactionId
  return !events.some((x) => x.type === 'compaction/start' && x.data?.compactionId === id)
})

if (!orphans.length) {
  console.log('没有孤儿，不用修。')
  process.exit(0)
}

for (const e of orphans) {
  console.log(`  孤儿 seq=${e.seq} compactionId=${String(e.data.source.compactionId).slice(0, 8)}`)
  console.log(`     替换 ${JSON.stringify(e.surfaceOp)}`)
  console.log(`     摘要: ${String(e.data.content?.[1]?.text || '').slice(0, 80).replace(/\n/g, ' ')}`)
}

if (!apply) {
  console.log('\n只是诊断。加 --apply 才会真改。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${file}.bak-${stamp}`
fs.copyFileSync(file, backup)
console.log(`\n已备份到 ${backup}`)

for (const e of orphans) e.data.source = { kind: 'user' }

const out = encode(events)
fs.writeFileSync(file, out)

/* 回读自检 */
const check = decode(file)
const left = check.filter((e) => {
  if (e.type !== 'user/message' || e.data?.source?.kind !== 'compact-checkpoint') return false
  const id = e.data.source.compactionId
  return !check.some((x) => x.type === 'compaction/start' && x.data?.compactionId === id)
})
let gaps = 0
let prev = null
for (const e of check) {
  if (typeof e.seq === 'number') {
    if (prev !== null && e.seq !== prev + 1) gaps++
    prev = e.seq
  }
}
console.log(`回读：事件 ${check.length}，剩余孤儿 ${left.length}，seq 缺口 ${gaps}`)
console.log(left.length === 0 && gaps === 0 ? '修好了，重开会话试试。' : '还有问题，先别删备份。')
