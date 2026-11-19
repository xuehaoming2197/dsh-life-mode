#!/usr/bin/env node
/**
 * 修复被 compaction 写坏的会话日志。
 *
 * 背景：compactRegion 失败时**不回滚**——它先写 compaction/start + compaction/summary，
 * 再在 compaction/end 上报错。留下的孤儿事件会让整个会话读不出来，报
 *   "compaction cannot shadow the protected system head"
 * 或者 "compaction/start 没配对"。
 *
 * 做法：找到第一组 orphan compaction，截断到它之前最后一个 turn/end，
 * 重写成「header 独占一帧 + 每个事件一帧」的 zstd。原文件先备份。
 *
 *   node scripts/repair-session-log.mjs                       # 修生活会话
 *   node scripts/repair-session-log.mjs <会话文件路径>          # 修指定会话
 *   node scripts/repair-session-log.mjs <文件> --at 4931       # 截断到指定 seq
 *   node scripts/repair-session-log.mjs <文件> --dry            # 只看不写
 *
 * 注意 seq 必须连续：不能只删掉坏事件，只能整段截断。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const dry = args.includes('--dry')
const at = (() => {
  const i = args.indexOf('--at')
  return i >= 0 ? Number(args[i + 1]) : null
})()

if (!file) {
  console.log('用法：node scripts/repair-session-log.mjs <会话日志路径> [--dry] [--at <seq>]')
  console.log('')
  console.log('会话日志一般在：')
  console.log(`  ${path.join(os.homedir(), '.dsh', 'sessions')}\\<工作区目录名>\\<会话 id>\\session.v4.jsonl.zstd`)
  console.log('')
  console.log('先加 --dry 看一眼会丢多少事件，再去掉 --dry 真修。')
  process.exit(1)
}

if (!fs.existsSync(file)) {
  console.log(`找不到会话文件：${file}`)
  process.exit(1)
}

/* ---- 解压：多帧 zstd 首尾相接 ---- */
function decode(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const cuts = []
  let hit = -1
  while ((hit = buf.indexOf(MAGIC, hit + 1)) !== -1) cuts.push(hit)
  cuts.push(buf.length)
  let text = ''
  let frames = 0
  for (let i = 0; i < cuts.length - 1; i++) {
    try {
      text += zlib.zstdDecompressSync(buf.subarray(cuts[i], cuts[i + 1])).toString('utf8')
      frames += 1
    } catch {}
  }
  return { text, frames }
}

const raw = fs.readFileSync(file)
const { text, frames } = decode(raw)
const lines = text.split('\n').filter(Boolean)
const header = lines[0]
const events = lines.slice(1).flatMap((line) => {
  try {
    return [JSON.parse(line)]
  } catch {
    return []
  }
})

console.log(`帧 ${frames} ｜ 事件 ${events.length} ｜ 文件 ${raw.length} B`)

/* ---- 找截断点 ---- */
let cut = at
if (cut === null) {
  const bad = events.find((e) => String(e.type || '').startsWith('compaction/'))
  if (!bad) {
    console.log('没有 compaction 事件，看不出哪里坏了。用 --at 手动指定截断 seq。')
    process.exit(0)
  }
  console.log(`第一个 compaction 事件：${bad.type} seq=${bad.seq}`)
  for (const e of events) {
    if (e.seq >= bad.seq) break
    if (e.type === 'turn/end') cut = e.seq
  }
  if (cut === null) {
    console.log('这个 compaction 之前没有完整的 turn/end，没法安全截断。用 --at 手动指定。')
    process.exit(1)
  }
}

const keep = events.filter((e) => e.seq <= cut)
const dropped = events.length - keep.length
console.log(`截断点 seq=${cut} ｜ 保留 ${keep.length} 条，丢掉 ${dropped} 条`)

if (dry) {
  console.log('（--dry：没写）')
  process.exit(0)
}

/* ---- 备份 ---- */
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${file}.corrupt-${stamp}`
fs.copyFileSync(file, backup)
console.log(`备份：${backup}`)

/* ---- 写回：header 独占第一帧，其余一个事件一帧 ---- */
const chunks = [zlib.zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))]
for (const e of keep) chunks.push(zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`, 'utf8')))
const out = Buffer.concat(chunks)
fs.writeFileSync(file, out)
console.log(`写回 ${chunks.length} 帧 / ${out.length} B`)
console.log('')
console.log('接着让 DSH 重新 resume 这个会话。读得起来就说明修好了。')
