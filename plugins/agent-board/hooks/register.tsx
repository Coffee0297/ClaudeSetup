import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, Lead, LogLine, Seen } from '../types'

// Agent Board: a side pane with the lead and every subagent: the model each runs
// on, what it is doing now, its tokens and cost, a spend-over-time chart, a cost
// share and a session log. Open it with /board.
// High-def drawing: vector SVG on desktop / VS Code / mobile, true-colour braille
// rasters (2x4 dots per cell) in the terminal.

const PANE = 'agent-board'
const POLL_MS = 2000
const LOG_MAX = 40
const KEEP_AGENTS = 24
const HISTORY = 150 // points; at 2 s that is the last 5 minutes
const DONE = new Set(['completed', 'failed', 'killed', 'stopped'])

const seen = atom({ plugin: 'agent-board', key: 'seen' } as const, {}, { shape: 'seen-2' })
const activity = atom({ plugin: 'agent-board', key: 'activity' } as const, {}, { shape: 'act-1' })
const log = atom({ plugin: 'agent-board', key: 'log' } as const, [], { shape: 'log-1' })
const lead = atom({ plugin: 'agent-board', key: 'lead' } as const, { turns: 0, input: 0, output: 0, samples: [] }, { shape: 'lead-1' })

// Spend over time, per series ("lead" or an agent type). Module memory: it
// restarts at a reload, which is fine for a live view.
type Point = { t: number; v: Record<string, number> }
let history: Point[] = []
let leadModelCache = ''
let leadEffort: string | undefined
let ctxTokCache = 0
let reportTok = 0
let leadStepAt: number | undefined
const adv: { calls: number; last?: number; read: number } = { calls: 0, read: 0 }

// ---- colours ----------------------------------------------------------------

const RGB: Record<string, number> = {
  fable: 0xf2c14e,
  opus: 0xb39dff,
  sonnet: 0xe8915b,
  haiku: 0x6fa8ff,
  other: 0xabb2bf,
}
const OTHER = 0xabb2bf

function family(model: string): string {
  const m = model.toLowerCase()
  return m.includes('fable') ? 'fable' : m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : 'other'
}

function shade(rgb: number, k: number): number {
  if (k === 0) return rgb
  const f = k % 2 === 1 ? 0.28 * Math.ceil(k / 2) : -0.22 * (k / 2) // lighter, darker, lighter...
  const ch = (c: number) => Math.max(0, Math.min(255, Math.round(f > 0 ? c + (255 - c) * f : c * (1 + f))))
  return (ch((rgb >> 16) & 255) << 16) | (ch((rgb >> 8) & 255) << 8) | ch(rgb & 255)
}

function hex(rgb: number): string {
  return '#' + rgb.toString(16).padStart(6, '0')
}

// One stable colour per series: the model family's colour, shaded per series of that family.
function palette(series: { name: string; model: string }[]): Record<string, number> {
  const used: Record<string, number> = {}
  const out: Record<string, number> = {}
  for (const s of series) {
    const fam = family(s.model)
    const k = used[fam] ?? 0
    used[fam] = k + 1
    out[s.name] = shade(RGB[fam] ?? OTHER, k)
  }
  return out
}

// ---- formatting ---------------------------------------------------------------

function shortModel(m: string | undefined): string {
  if (!m) return '?'
  return m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, ' $1.$2').replace(/\[.*\]$/, '')
}

function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}

function usd(n: number): string {
  return n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function clock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':')
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(0, n - 1)) + '…' : one
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function detailOf(input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const file = pick('file_path') || pick('notebook_path') || pick('path')
  if (file) return file.split(/[\\/]/).pop() ?? file
  return pick('description') || pick('command') || pick('pattern') || pick('url') || pick('query') || pick('prompt') || ''
}

// ---- terminal raster (braille, true colour) -------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + (i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=') + (i + 2 < bytes.length ? B64.charAt(n & 63) : '=')
  }
  return out
}

const DEFAULT = 0x01000000
const GRID = 0x3a3f4b
// Braille dot bits by [row][col] within a 2x4 cell.
const DOT: number[][] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

// Stacked area chart: series drawn bottom-up in order; each cell takes the
// colour of the series covering most of its dots.
function brailleStack(series: { color: number; values: number[] }[], cols: number, rows: number, max: number): string {
  const W = cols * 2, H = rows * 4
  const owner: number[] = new Array(W * H).fill(-1)
  const n = Math.max(0, ...series.map(s => s.values.length))
  if (n > 0 && max > 0) {
    for (let x = 0; x < W; x++) {
      const pos = n === 1 || W === 1 ? 0 : (x / (W - 1)) * (n - 1)
      const i0 = Math.floor(pos), i1 = Math.min(n - 1, i0 + 1), f = pos - i0
      let base = 0
      series.forEach((s, si) => {
        const v = (s.values[i0] ?? 0) * (1 - f) + (s.values[i1] ?? 0) * f
        const top = base + v
        const y0 = Math.round((base / max) * H), y1 = Math.round((top / max) * H)
        for (let y = y0; y < Math.min(H, y1); y++) owner[(H - 1 - y) * W + x] = si
        if (v > 0 && y1 === y0 && y0 < H) owner[(H - 1 - y0) * W + x] = si // keep thin series visible
        base = top
      })
    }
  }
  const words = new Uint32Array(cols * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let bits = 0
      const count = new Map<number, number>()
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = owner[(r * 4 + dy) * W + c * 2 + dx] ?? -1
          if (o >= 0) {
            bits |= DOT[dy]?.[dx] ?? 0
            count.set(o, (count.get(o) ?? 0) + 1)
          }
        }
      }
      let best = -1, bestN = 0
      for (const [o, k] of count) {
        if (k > bestN) {
          best = o
          bestN = k
        }
      }
      const i = (r * cols + c) * 3
      const baseline = r === rows - 1
      words[i] = bits ? 0x2800 + bits : baseline ? 0x2800 + 0x40 + 0x80 : 0x20
      words[i + 1] = best >= 0 ? (series[best]?.color ?? OTHER) : GRID
      words[i + 2] = DEFAULT
    }
  }
  return base64(new Uint8Array(words.buffer))
}

// One-row proportional bar in true colour.
function shareBar(parts: { color: number; frac: number }[], cols: number): string {
  const words = new Uint32Array(cols * 3)
  const cells: number[] = new Array(cols).fill(-1)
  let acc = 0
  parts.forEach((p, pi) => {
    const from = Math.round(acc * cols)
    acc += p.frac
    const to = Math.round(acc * cols)
    for (let c = from; c < Math.min(cols, to); c++) cells[c] = pi
  })
  cells.forEach((pi, c) => {
    words[c * 3] = pi >= 0 ? 0x2588 : 0x2591
    words[c * 3 + 1] = pi >= 0 ? (parts[pi]?.color ?? OTHER) : GRID
    words[c * 3 + 2] = DEFAULT
  })
  return base64(new Uint8Array(words.buffer))
}

// ---- SVG (desktop, VS Code, mobile) ----------------------------------------------

type View = {
  total: number
  ctxPct?: number
  leadModel: string
  advisor: string
  leadAct?: Activity
  leadUsd: number
  l: Lead
  list: Seen[]
  acts: Record<string, Activity>
  colors: Record<string, number>
  seriesNames: string[]
  shares: { name: string; usd: number }[]
  now: number
  blocked: number
  leadEffort?: string
  ctxTok?: number
  adv?: { calls: number; last?: number; read: number }
  reportTok?: number
  stepFor?: number
}

const gid = (n: string) => 'g-' + n.replace(/\W/g, '_')

// Spend RATE per series in $/min between polls, lightly smoothed. Cumulative
// spend barely moves over a few minutes, so a rate shows the bursts.
function rates(names: string[]): Point[] {
  const out: Point[] = []
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1], b = history[i]
    if (!a || !b) continue
    const dt = Math.max(1, b.t - a.t) / 60000
    const v: Record<string, number> = {}
    for (const n of names) v[n] = Math.max(0, ((b.v[n] ?? 0) - (a.v[n] ?? 0)) / dt)
    out.push({ t: b.t, v })
  }
  return out.map((p, i) => {
    const win = out.slice(Math.max(0, i - 2), i + 1)
    const v: Record<string, number> = {}
    for (const n of names) v[n] = win.reduce((s, q) => s + (q.v[n] ?? 0), 0) / win.length
    return { t: p.t, v }
  })
}

function rateLabel(n: number): string {
  return n >= 1 ? `$${n.toFixed(1)}/m` : `$${n.toFixed(2)}/m`
}

function svgArea(names: string[], colors: Record<string, number>, x: number, y: number, w: number, h: number): string {
  const pts = rates(names)
  if (pts.length < 2) {
    return `<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" class="dim">collecting data…</text>`
  }
  const max = Math.max(0.0001, ...pts.map(p => names.reduce((s, n) => s + (p.v[n] ?? 0), 0)))
  if (max < 0.005) {
    return `<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" class="grid"/><text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" class="dim">idle · no spend in the last ${Math.max(1, Math.round(((pts[pts.length - 1]?.t ?? 0) - (pts[0]?.t ?? 0)) / 60000))} min</text>`
  }
  const X = (i: number) => x + (i / (pts.length - 1)) * w
  const Y = (v: number) => y + h - (v / max) * h
  let out = ''
  for (let g = 0; g <= 3; g++) {
    const gy = y + (g / 3) * h
    out += `<line x1="${x}" y1="${gy.toFixed(1)}" x2="${x + w}" y2="${gy.toFixed(1)}" class="grid"/>`
    out += `<text x="${x + w + 4}" y="${(gy + 3).toFixed(1)}" class="axis">${rateLabel(max * (1 - g / 3))}</text>`
  }
  const base = pts.map(() => 0)
  const last = pts[pts.length - 1]
  for (const n of names) {
    const top = pts.map((p, i) => (base[i] ?? 0) + (p.v[n] ?? 0))
    if (top.every((v, i) => v === base[i])) continue
    const up = top.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)
    const down = base.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).reverse()
    const c = hex(colors[n] ?? OTHER)
    out += `<path d="M${up.join(' L')} L${down.join(' L')} Z" fill="url(#${gid(n)})"><title>${xml(n)}: ${rateLabel(last?.v[n] ?? 0)} now</title></path>`
    out += `<polyline points="${up.join(' ')}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>`
    top.forEach((v, i) => (base[i] = v))
  }
  const mins = Math.max(1, Math.round(((last?.t ?? 0) - (pts[0]?.t ?? 0)) / 60000))
  out += `<text x="${x}" y="${y + h + 12}" class="axis">-${mins}m</text><text x="${x + w}" y="${y + h + 12}" text-anchor="end" class="axis">now</text>`
  return out
}

function svgDonut(shares: { name: string; usd: number }[], colors: Record<string, number>, cx: number, cy: number, r: number): string {
  const total = shares.reduce((s, x) => s + x.usd, 0)
  if (total <= 0) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2c313c" stroke-width="11"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" class="dim">$0</text>`
  let a = -Math.PI / 2
  let out = ''
  const p = (ang: number) => `${(cx + r * Math.cos(ang)).toFixed(2)},${(cy + r * Math.sin(ang)).toFixed(2)}`
  for (const s of shares) {
    const frac = s.usd / total
    const a2 = a + frac * Math.PI * 2
    const large = a2 - a > Math.PI ? 1 : 0
    const d = frac >= 0.9999
      ? `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`
      : `M${p(a)} A${r},${r} 0 ${large},1 ${p(a2)}`
    out += `<path d="${d}" fill="none" stroke="${hex(colors[s.name] ?? OTHER)}" stroke-width="11"><title>${xml(s.name)}: ${usd(s.usd)} (${Math.round(frac * 100)}%)</title></path>`
    a = a2
  }
  out += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="big">${usd(total)}</text>`
  return out
}

function svgSpark(values: number[], color: string, x: number, y: number, w: number, h: number): string {
  const v = values.slice(-24)
  if (v.length < 2) return ''
  const max = Math.max(1, ...v)
  const pts = v.map((n, i) => `${(x + (i / (v.length - 1)) * w).toFixed(1)},${(y + h - (n / max) * h).toFixed(1)}`)
  return `<path d="M${x},${y + h} L${pts.join(' L')} L${x + w},${y + h} Z" fill="${color}" fill-opacity="0.18"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.4"/>`
}

const STYLE = '<style>.dim{fill:#8b93a4;font-size:10px}.axis{fill:#6b7385;font-size:8.5px}.big{fill:#e6e9ef;font-size:13px;font-weight:600}.h{fill:#c7cbd6;font-size:9px;font-weight:700;letter-spacing:1.2px}.t{fill:#e6e9ef;font-size:11px}.grid{stroke:#2c313c;stroke-width:0.6}</style>'
const VW = 420
const PAD = 14

// One card: wide and short, so the surface scales it to the pane's width and
// the pane scrolls, instead of shrinking one tall image to fit.
function card(h: number, body: string, defs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${h}" width="1200" height="${Math.round((1200 * h) / VW)}" font-family="ui-sans-serif, Segoe UI, sans-serif">${STYLE}<defs>${defs}<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1f27"/><stop offset="1" stop-color="#14171d"/></linearGradient></defs><rect width="${VW}" height="${h}" rx="9" fill="url(#bg)"/>${body}</svg>`
}

function svgHeader(v: View): string {
  const leadC = hex(v.colors.lead ?? RGB[family(v.leadModel)] ?? OTHER)
  const pct = Math.max(0, Math.min(100, v.ctxPct ?? 0))
  const gauge = pct > 80 ? '#e06c75' : pct > 50 ? '#e5c07b' : '#56b6c2'
  let b = `<text x="${PAD}" y="22" class="h">AGENT BOARD</text><text x="${VW - PAD}" y="23" text-anchor="end" class="big">${usd(v.total)}<tspan class="dim"> est</tspan></text>`
  b += `<rect x="${PAD}" y="32" width="${VW - 2 * PAD}" height="5" rx="2.5" fill="#2c313c"/><rect x="${PAD}" y="32" width="${(((VW - 2 * PAD) * pct) / 100).toFixed(1)}" height="5" rx="2.5" fill="${gauge}"/>`
  b += `<text x="${PAD}" y="49" class="dim">context ${v.ctxPct ?? '?'}%</text>`
  b += `<circle cx="${PAD + 4}" cy="66" r="4" fill="${leadC}"/><text x="${PAD + 14}" y="70" class="t" font-weight="600">lead <tspan fill="${leadC}" font-weight="400">${xml(shortModel(v.leadModel))}</tspan>${v.advisor ? `<tspan class="dim" font-weight="400"> · advisor ${xml(shortModel(v.advisor))} (settings)</tspan>` : ''}</text>`
  b += `<text x="${PAD + 14}" y="85" class="dim">${xml(v.leadAct ? clip(`${v.leadAct.tool} ${v.leadAct.detail}`, 34) : 'idle')} · ${tok(v.l.input)} in · ${tok(v.l.output)} out · ${usd(v.leadUsd)}</text>`
  b += svgSpark(v.l.samples, leadC, VW - PAD - 80, 56, 80, 16)
  return card(96, b)
}

// ---- flow: who started whom --------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number }

function flowOrder(list: Seen[]): Seen[] {
  return [...list].sort((a, b) => Number(DONE.has(a.status)) - Number(DONE.has(b.status)) || b.start - a.start)
}

function flowLevels(list: Seen[]): { top: Seen[]; nested: Seen[] } {
  const ids = new Set(list.map(a => a.id))
  const top = flowOrder(list.filter(a => !DONE.has(a.status) && (!a.parent || !ids.has(a.parent)))).slice(0, 8)
  const shown = new Set(top.map(a => a.id))
  const nested = flowOrder(list.filter(a => !DONE.has(a.status) && a.parent && shown.has(a.parent))).slice(0, 4)
  return { top, nested }
}

function flowBox(a: Seen, r: Rect, v: View, maxTok: number): string {
  const isRun = !DONE.has(a.status)
  const c = hex(v.colors[a.type] ?? RGB[family(a.model)] ?? OTHER)
  const act = v.acts[a.id]
  const chars = Math.max(10, Math.floor((r.w - 16) / 5.4))
  const statusC = isRun ? '#98c379' : a.status === 'completed' ? '#8b93a4' : '#e06c75'
  let s = `<g><title>${xml(a.type)} · ${xml(shortModel(a.model))} · ${xml(a.status)}\n${xml(a.desc)}</title>`
  s += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="7" fill="#1f242d" stroke="${isRun ? c : '#2c313c'}" stroke-opacity="${isRun ? 0.85 : 1}"/>`
  s += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="3" rx="1.5" fill="${c}" opacity="${isRun ? 1 : 0.45}"/>`
  s += `<text x="${r.x + 8}" y="${r.y + 16}" class="t" font-weight="600">${xml(clip(a.type, Math.floor(chars * 0.6)))}</text>`
  s += `<text x="${r.x + r.w - 8}" y="${r.y + 16}" text-anchor="end" font-size="9.5" fill="${c}">${xml(shortModel(a.model))}</text>`
  s += `<circle cx="${r.x + 11}" cy="${r.y + 26}" r="2.6" fill="${statusC}">${isRun ? '<animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite"/>' : ''}</circle>`
  s += `<text x="${r.x + 18}" y="${r.y + 29}" font-size="8.5" fill="${statusC}">${xml(a.status)} · ${dur((a.end ?? v.now) - a.start)} · ${usd(a.usd)}</text>`
  s += `<text x="${r.x + 8}" y="${r.y + 42}" class="dim" font-size="9">${xml(clip(isRun && act ? `${act.tool} ${act.detail}` : a.desc, chars))}</text>`
  const bw = r.w - 16 - 30
  const f = maxTok > 0 ? Math.min(1, a.tokens / maxTok) : 0
  s += `<rect x="${r.x + 8}" y="${r.y + r.h - 10}" width="${bw}" height="4" rx="2" fill="#2c313c"/><rect x="${r.x + 8}" y="${r.y + r.h - 10}" width="${(bw * f).toFixed(1)}" height="4" rx="2" fill="${c}" opacity="${isRun ? 1 : 0.5}"/>`
  s += `<text x="${r.x + r.w - 8}" y="${r.y + r.h - 6}" text-anchor="end" class="axis">${tok(a.tokens)}</text>`
  return s + '</g>'
}

function flowEdge(from: Rect, to: Rect, color: string, isRun: boolean): string {
  const x1 = from.x + from.w / 2, y1 = from.y + from.h
  const x2 = to.x + to.w / 2, y2 = to.y
  const my = (y1 + y2) / 2
  const d = `M${x1.toFixed(1)},${y1} C${x1.toFixed(1)},${my} ${x2.toFixed(1)},${my} ${x2.toFixed(1)},${y2}`
  if (!isRun) return `<path d="${d}" fill="none" stroke="#3a3f4b" stroke-width="1.2"/>`
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-dasharray="4 4" opacity="0.9"><animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.7s" repeatCount="indefinite"/></path><circle cx="${x2.toFixed(1)}" cy="${y2}" r="2.2" fill="${color}"/>`
}

function svgFlow(v: View): string {
  const ids = new Set(v.list.map(a => a.id))
  const live = v.list.filter(a => !DONE.has(a.status))
  const top = live.filter(a => !a.parent || !ids.has(a.parent)).sort((a, b) => a.start - b.start).slice(0, 8)
  const shownTop = new Set(top.map(a => a.id))
  const nested = live.filter(a => a.parent && shownTop.has(a.parent)).sort((a, b) => a.start - b.start).slice(0, 4)
  const done = v.list.filter(a => DONE.has(a.status)).sort((a, b) => (b.end ?? b.start) - (a.end ?? a.start)).slice(0, 6)

  const leadC = hex(v.colors.lead ?? RGB[family(v.leadModel)] ?? OTHER)
  const colorOf = (a: Seen) => hex(v.colors[a.type] ?? RGB[family(a.model)] ?? OTHER)
  const maxTok = Math.max(1, ...v.list.map(a => a.tokens))
  const inner = VW - 2 * PAD
  const gap = 10
  const boxH = 58
  const perRow = top.length <= 4 ? Math.max(1, top.length) : 3
  const leadR: Rect = { x: VW / 2 - 95, y: 30, w: 190, h: 50 }
  const lx = leadR.x + leadR.w / 2
  const rects = new Map<string, Rect>()
  let y = leadR.y + leadR.h + 30
  const busYs: number[] = []

  // top-level running agents, rows of up to 4 (3 when wrapping)
  for (let i = 0; i < top.length; i += perRow) {
    const row = top.slice(i, i + perRow)
    const w = (inner - gap * (perRow - 1)) / perRow
    const rowW = row.length * w + (row.length - 1) * gap
    const x0 = PAD + (inner - rowW) / 2
    row.forEach((a, k) => rects.set(a.id, { x: x0 + k * (w + gap), y, w, h: boxH }))
    busYs.push(y - 14)
    y += boxH + 30
  }

  // nested running agents, grouped under their parent
  const groups = new Map<string, Seen[]>()
  for (const a of nested) groups.set(a.parent ?? '', [...(groups.get(a.parent ?? '') ?? []), a])
  if (nested.length > 0) {
    const w = (inner - 2 * gap) / 3
    let cursor = PAD
    for (const [pid, kids] of groups) {
      const p = rects.get(pid)
      const gw = kids.length * w + (kids.length - 1) * gap
      let x0 = p ? p.x + p.w / 2 - gw / 2 : cursor
      x0 = Math.max(cursor, Math.min(PAD + inner - gw, x0))
      kids.forEach((a, k) => rects.set(a.id, { x: x0 + k * (w + gap), y, w, h: boxH }))
      cursor = x0 + gw + gap
    }
    y += boxH + 22
  }

  const running = live.length
  let b = `<text x="${PAD}" y="19" class="h">FLOW <tspan class="dim" font-weight="400" letter-spacing="0">${running} running · ${v.list.length} this session</tspan></text>`
  b += `<text x="${VW - PAD}" y="19" text-anchor="end" class="dim">guard ${v.blocked > 0 ? `<tspan fill="#e5c07b">${v.blocked} blocked</tspan>` : 'ok'}</text>`

  // bus: lead -> stem -> one horizontal bus per row (left rail for later rows) -> drops
  if (top.length > 0) {
    const firstBus = busYs[0] ?? y
    b += `<path d="M${lx},${leadR.y + leadR.h} L${lx},${firstBus}" stroke="${leadC}" stroke-width="1.4" opacity="0.8" fill="none"/>`
    const rail = PAD - 7
    if (busYs.length > 1) {
      b += `<path d="M${lx},${firstBus} L${rail},${firstBus} L${rail},${busYs[busYs.length - 1]}" stroke="#3a3f4b" stroke-width="1.2" fill="none"/>`
    }
    busYs.forEach((by, ri) => {
      const row = top.slice(ri * perRow, ri * perRow + perRow)
      const xs = row.map(a => {
        const r = rects.get(a.id)
        return r ? r.x + r.w / 2 : lx
      })
      const from = ri === 0 ? Math.min(lx, ...xs) : rail
      const to = Math.max(ri === 0 ? lx : rail, ...xs)
      b += `<path d="M${from.toFixed(1)},${by} L${to.toFixed(1)},${by}" stroke="#3a3f4b" stroke-width="1.2" fill="none"/>`
      row.forEach((a, k) => {
        const r = rects.get(a.id)
        if (!r) return
        const cx = (xs[k] ?? lx).toFixed(1)
        const c = colorOf(a)
        b += `<path d="M${cx},${by} L${cx},${r.y}" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="4 4"><animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.7s" repeatCount="indefinite"/></path><circle cx="${cx}" cy="${by}" r="2.2" fill="${c}"/>`
      })
    })
  }
  // parent -> nested
  for (const a of nested) {
    const r = rects.get(a.id), p = a.parent ? rects.get(a.parent) : undefined
    if (r && p) b += flowEdge(p, r, colorOf(a), true)
  }

  // lead box
  b += `<g><title>lead · ${xml(shortModel(v.leadModel))}</title><rect x="${leadR.x}" y="${leadR.y}" width="${leadR.w}" height="${leadR.h}" rx="8" fill="#232835" stroke="${leadC}" stroke-width="1.4"/>`
  b += `<text x="${lx}" y="${leadR.y + 18}" text-anchor="middle" class="t" font-weight="600">lead · <tspan fill="${leadC}">${xml(shortModel(v.leadModel))}</tspan></text>`
  b += `<text x="${lx}" y="${leadR.y + 31}" text-anchor="middle" class="dim" font-size="9">${v.advisor ? `advisor ${xml(shortModel(v.advisor))} · ` : ''}${usd(v.leadUsd)}</text>`
  b += `<text x="${lx}" y="${leadR.y + 43}" text-anchor="middle" class="dim" font-size="9">${xml(v.leadAct ? clip(`${v.leadAct.tool} ${v.leadAct.detail}`, 34) : 'idle')}</text></g>`
  for (const a of [...top, ...nested]) {
    const r = rects.get(a.id)
    if (r) b += flowBox(a, r, v, maxTok)
  }
  if (top.length === 0) {
    b += `<text x="${lx}" y="${leadR.y + leadR.h + 24}" text-anchor="middle" class="dim">no agents running: the lead is working alone</text>`
    y = leadR.y + leadR.h + 40
  }
  const hidden = live.length - top.length - nested.length
  if (hidden > 0) b += `<text x="${VW - PAD}" y="${y - 12}" text-anchor="end" class="axis">+${hidden} more running</text>`

  // finished agents as chips
  if (done.length > 0) {
    b += `<text x="${PAD}" y="${y + 4}" class="h">DONE</text>`
    const cw = (inner - gap) / 2
    done.forEach((a, i) => {
      const cx = PAD + (i % 2) * (cw + gap)
      const cy = y + 12 + Math.floor(i / 2) * 24
      const ok = a.status === 'completed'
      b += `<g><title>${xml(a.type)} · ${xml(a.desc)}</title><rect x="${cx}" y="${cy}" width="${cw}" height="19" rx="9.5" fill="#1f242d" stroke="#2c313c"/><rect x="${cx}" y="${cy}" width="5" height="19" rx="2.5" fill="${colorOf(a)}" opacity="0.7"/>`
      b += `<text x="${cx + 12}" y="${cy + 13}" font-size="9" fill="${ok ? '#8b93a4' : '#e06c75'}">${ok ? '✓' : '✗'} ${xml(clip(a.type, 12))} · ${xml(shortModel(a.model))} · ${dur((a.end ?? v.now) - a.start)} · ${usd(a.usd)}</text></g>`
    })
    y += 18 + Math.ceil(done.length / 2) * 24
  }
  return card(Math.max(110, y), b)
}

// Terminal: the same tree in box-drawing lines.
function flowLines(v: View, width: number): { text: string; color?: string; dim?: boolean }[] {
  const { top, nested } = flowLevels(v.list)
  const out: { text: string; color?: string; dim?: boolean }[] = []
  out.push({ text: `◆ lead ${shortModel(v.leadModel)}${v.advisor ? ` · advisor ${shortModel(v.advisor)}` : ''}${v.blocked ? ` · guard ${v.blocked} blocked` : ''}`, color: hex(v.colors.lead ?? OTHER) })
  const line = (a: Seen, prefix: string, last: boolean) => {
    const isRun = !DONE.has(a.status)
    const act = v.acts[a.id]
    const mark = isRun ? '●' : a.status === 'completed' ? '✓' : '✗'
    const what = isRun && act ? `${act.tool} ${act.detail}` : a.desc
    const head = `${prefix}${last ? '└─' : '├─'}${mark} ${a.type} ${shortModel(a.model)} ${dur((a.end ?? v.now) - a.start)} ${usd(a.usd)} · `
    out.push({ text: head + clip(what, Math.max(8, width - head.length)), color: hex(v.colors[a.type] ?? OTHER), dim: !isRun })
  }
  top.forEach((a, i) => {
    const last = i === top.length - 1
    line(a, '', last)
    const kids = nested.filter(k => k.parent === a.id)
    kids.forEach((k, j) => line(k, last ? '   ' : '│  ', j === kids.length - 1))
  })
  if (top.length === 0) out.push({ text: '└─ no subagents running', dim: true })
  return out
}

// ---- v5: advisor + main session, dispatch blocks, summaries-only ----------------------

const MONO = 'JetBrains Mono, Cascadia Mono, Consolas, ui-monospace, monospace'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

function effortBars(effort: string | undefined, x: number, y: number, color: string): string {
  if (!effort) return ''
  const lvl = EFFORTS.indexOf(effort) + 1
  let s = `<text x="${x}" y="${y}" class="m dim">effort</text>`
  for (let i = 0; i < 5; i++) s += `<rect x="${x + 40 + i * 7}" y="${y - 8}" width="5" height="9" rx="1" fill="${i < lvl ? color : '#2c313c'}"/>`
  return s + `<text x="${x + 80}" y="${y}" class="m" fill="${color}">${xml(effort)}</text>`
}

function monoCard(h: number, body: string, defs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${h}" width="1200" height="${Math.round((1200 * h) / VW)}" font-family="${MONO}"><style>.m{font-size:9px;fill:#d7dae0}.dim{fill:#7f8796}.b{font-weight:700}.s{font-size:8px}.hd{font-size:9.5px;font-weight:700;letter-spacing:.5px}</style><defs>${defs}</defs><rect width="${VW}" height="${h}" rx="6" fill="#12151c"/>${body}</svg>`
}

function dashedBox(x: number, y: number, w: number, h: number, color: string, glow = false): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${glow ? color : '#161a22'}" fill-opacity="${glow ? 0.06 : 1}" stroke="${color}" stroke-width="1.1" stroke-dasharray="${glow ? '0' : '3 2'}"/>`
}

function svgTop(v: View): string {
  const advC = hex(RGB[family(v.advisor || 'opus')] ?? OTHER)
  const leadC = hex(RGB[family(v.leadModel)] ?? OTHER)
  const adv = v.adv ?? { calls: 0, read: 0 }
  const advActive = adv.last !== undefined && v.now - adv.last < 15000
  const ax = PAD, aw = 150, mx = PAD + aw + 22, mw = VW - PAD - mx, y = 10, h = 112
  let b = dashedBox(ax, y, aw, h, advC)
  b += `<text x="${ax + 8}" y="${y + 16}" class="m b" fill="${advC}">${xml(v.advisor ? shortModel(v.advisor).toUpperCase() : 'NO ADVISOR')}</text>`
  b += `<text x="${ax + 8}" y="${y + 28}" class="m dim">advisor · ${advActive ? `<tspan fill="${advC}">just consulted</tspan>` : v.advisor ? 'on call' : 'off'}</text>`
  b += `<text x="${ax + 8}" y="${y + 46}" class="m dim">calls</text><text x="${ax + aw - 8}" y="${y + 46}" text-anchor="end" class="m b">${adv.calls}</text>`
  b += `<text x="${ax + 8}" y="${y + 58}" class="m dim">≈ tokens read</text><text x="${ax + aw - 8}" y="${y + 58}" text-anchor="end" class="m b">${tok(adv.read)}</text>`
  b += `<text x="${ax + 8}" y="${y + 70}" class="m dim">last</text><text x="${ax + aw - 8}" y="${y + 70}" text-anchor="end" class="m">${adv.last ? clock(adv.last) : '—'}</text>`
  b += `<text x="${ax + 8}" y="${y + 86}" class="s dim">◇ before a plan</text><text x="${ax + 8}" y="${y + 96}" class="s dim">◇ same error x2</text><text x="${ax + 8}" y="${y + 106}" class="s dim">◇ before done</text>`
  if (advActive) b += `<rect x="${ax}" y="${y}" width="${aw}" height="${h}" rx="4" fill="none" stroke="${advC}" stroke-width="2"><animate attributeName="stroke-opacity" values="1;.2;1" dur="1.2s" repeatCount="indefinite"/></rect>`
  // consult link
  const ly = y + 40
  b += `<path d="M${ax + aw + 2},${ly} L${mx - 2},${ly}" stroke="${advC}" stroke-width="1.2" stroke-dasharray="2 3" opacity="${advActive ? 1 : 0.45}">${advActive ? '<animate attributeName="stroke-dashoffset" from="10" to="0" dur=".6s" repeatCount="indefinite"/>' : ''}</path><circle cx="${mx - 3}" cy="${ly}" r="2.4" fill="${advC}" opacity="${advActive ? 1 : 0.5}"/>`
  // main session
  b += dashedBox(mx, y, mw, h, leadC, true)
  b += `<text x="${mx + mw / 2}" y="${y + 17}" text-anchor="middle" class="hd" fill="${leadC}">${xml(shortModel(v.leadModel).toUpperCase())} · main session</text>`
  b += `<text x="${mx + mw / 2}" y="${y + 30}" text-anchor="middle" class="m dim">${xml(v.leadAct ? clip(`${v.leadAct.tool} ${v.leadAct.detail}`, 34) : 'idle')}</text>`
  b += effortBars(v.leadEffort, mx + 12, y + 50, leadC)
  if ((v.stepFor ?? 0) > 3000) b += `<text x="${mx + mw - 12}" y="${y + 50}" text-anchor="end" class="m" fill="${leadC}">requesting · ${dur(v.stepFor ?? 0)}<animate attributeName="opacity" values="1;.35;1" dur="1.4s" repeatCount="indefinite"/></text>`
  const pct = Math.max(0, Math.min(100, v.ctxPct ?? 0))
  const ctxTok = v.ctxTok ?? 0
  b += `<text x="${mx + 12}" y="${y + 70}" class="m dim">main context</text><text x="${mx + mw - 12}" y="${y + 70}" text-anchor="end" class="m b" fill="${leadC}">${tok(ctxTok)} tok · ${pct}%</text>`
  b += `<rect x="${mx + 12}" y="${y + 75}" width="${mw - 24}" height="6" rx="1" fill="#2c313c"/><rect x="${mx + 12}" y="${y + 75}" width="${(((mw - 24) * pct) / 100).toFixed(1)}" height="6" rx="1" fill="${leadC}"/>`
  b += `<text x="${mx + 12}" y="${y + 96}" class="m dim">cost</text><text x="${mx + mw - 12}" y="${y + 96}" text-anchor="end" class="m">${usd(v.leadUsd)} lead · ${usd(v.total)} total</text>`
  b += `<text x="${mx + 12}" y="${y + 107}" class="s dim">${v.l.turns} turns · ${tok(v.l.output)} out</text>`
  return monoCard(h + 20, b)
}

type TypeGroup = { type: string; model: string; items: Seen[] }

function groupsOf(list: Seen[]): TypeGroup[] {
  const out: TypeGroup[] = []
  const types = [...new Set(list.filter(a => !DONE.has(a.status)).map(a => a.type))]
  for (const type of types) {
    const ofType = list.filter(a => a.type === type)
    const live = ofType.filter(a => !DONE.has(a.status))
    const waveStart = Math.min(...live.map(a => a.start))
    const items = ofType
      .filter(a => !DONE.has(a.status) || a.start >= waveStart || (a.end ?? 0) >= waveStart)
      .sort((x, y) => x.start - y.start)
    const model = live[live.length - 1]?.model || items[items.length - 1]?.model || ''
    out.push({ type, model, items })
  }
  return out.sort((a, b) => Math.min(...a.items.map(x => x.start)) - Math.min(...b.items.map(x => x.start)))
}

function svgDispatch(v: View): string {
  const groups = groupsOf(v.list).slice(0, 7)
  const running = v.list.filter(a => !DONE.has(a.status)).length
  const blockH = 50, gap = 8, top = 28, rail = PAD + 4
  const h = top + Math.max(1, groups.length) * (blockH + gap) + 6
  let b = `<text x="${VW / 2}" y="16" text-anchor="middle" class="m"><tspan class="dim">▼</tspan> Task tool · <tspan fill="#98c379" class="b">${running} running</tspan> · ${groups.length} ${groups.length === 1 ? 'type' : 'types'} · each in its own context <tspan class="dim">▼</tspan></text>`
  if (groups.length === 0) return ''
  b += `<path d="M${rail},${top - 4} L${rail},${top + (groups.length - 1) * (blockH + gap) + blockH / 2}" stroke="#3a3f4b" stroke-width="1.2"/>`
  groups.forEach((g, i) => {
    const y = top + i * (blockH + gap)
    const c = hex(RGB[family(g.model)] ?? OTHER)
    const live = g.items.filter(a => !DONE.has(a.status))
    const done = g.items.filter(a => a.status === 'completed').length
    const failed = g.items.filter(a => DONE.has(a.status) && a.status !== 'completed').length
    const isLive = live.length > 0
    const x = rail + 12, w = VW - PAD - x
    // connector from the rail
    b += `<path d="M${rail},${y + blockH / 2} L${x},${y + blockH / 2}" stroke="${c}" stroke-width="1.3" stroke-dasharray="${isLive ? '3 3' : '0'}" opacity="${isLive ? 1 : 0.45}">${isLive ? '<animate attributeName="stroke-dashoffset" from="6" to="0" dur=".6s" repeatCount="indefinite"/>' : ''}</path>`
    b += `<rect x="${x}" y="${y}" width="${w}" height="${blockH}" rx="4" fill="#161a22" stroke="${c}" stroke-opacity="${isLive ? 1 : 0.45}" stroke-width="1.2"/>`
    b += `<text x="${x + 8}" y="${y + 17}" class="hd" fill="#e6e9ef">${xml(clip(g.type, 14))}</text>`
    b += `<text x="${x + 8}" y="${y + 30}" class="s" fill="${c}">${xml(shortModel(g.model))}</text>`
    // one square per instance
    const sq = 13, sx = x + 104, maxSq = Math.floor((w * 0.42) / (sq + 3))
    g.items.slice(-maxSq).forEach((a, k) => {
      const run = !DONE.has(a.status), ok = a.status === 'completed'
      const fill = run ? c : ok ? c : '#e06c75'
      const qx = sx + k * (sq + 3), qy = y + 9
      b += `<g><title>${xml(a.type)} · ${xml(a.status)} · ${xml(clip(a.desc, 60))}</title><rect x="${qx}" y="${qy}" width="${sq}" height="${sq}" rx="2" fill="${fill}" fill-opacity="${run ? 0.35 : 0.85}" stroke="${fill}">${run ? '<animate attributeName="fill-opacity" values=".15;.6;.15" dur="1.3s" repeatCount="indefinite"/>' : ''}</rect><text x="${qx + sq / 2}" y="${qy + 9.5}" text-anchor="middle" font-size="8" fill="#12151c">${ok ? '✓' : run ? '' : '✗'}</text></g>`
    })
    if (g.items.length > maxSq) b += `<text x="${sx + maxSq * (sq + 3)}" y="${y + 19}" class="s dim">+${g.items.length - maxSq}</text>`
    // progress = finished / all
    const frac = (done + failed) / g.items.length
    const px = x + w * 0.62, pw = w * 0.38 - 40
    b += `<rect x="${px}" y="${y + 11}" width="${pw}" height="8" rx="1" fill="#2c313c"/><rect x="${px}" y="${y + 11}" width="${(pw * frac).toFixed(1)}" height="8" rx="1" fill="${c}"/>`
    b += `<text x="${x + w - 8}" y="${y + 19}" text-anchor="end" class="m b">${Math.round(frac * 100)}%</text>`
    // what it is doing / summary
    const act = live.length ? v.acts[live[live.length - 1]!.id] : undefined
    const toks = g.items.reduce((s, a) => s + a.tokens, 0)
    const cost = g.items.reduce((s, a) => s + a.usd, 0)
    const line = isLive
      ? `${act ? `${act.tool} ${act.detail}` : clip(live[live.length - 1]!.desc, 40)}`
      : `✓ ${done} done${failed ? ` · ✗ ${failed} failed` : ''}`
    b += `<text x="${sx}" y="${y + 40}" class="m" fill="${isLive ? '#d7dae0' : '#7f8796'}">${xml(clip(line, 34))}</text>`
    b += `<text x="${x + w - 8}" y="${y + 40}" text-anchor="end" class="s dim">${tok(toks)} tok · ${usd(cost)}</text>`
  })
  return monoCard(h, b)
}

function svgBack(v: View): string {
  const read = v.list.reduce((s, a) => s + a.tokens, 0)
  const got = v.reportTok ?? 0
  const leadC = hex(RGB[family(v.leadModel)] ?? OTHER)
  const max = Math.max(read, got, 1)
  const ratio = got > 0 ? Math.round(read / got) : 0
  const x = PAD, w = VW - 2 * PAD, bx = x + 180, bw = w - 190
  let b = `<rect x="${x}" y="8" width="${w}" height="84" rx="4" fill="#98c379" fill-opacity="0.05" stroke="#98c379" stroke-opacity="0.8"/>`
  b += `<text x="${x + 10}" y="24" class="hd" fill="#98c379">back to ${xml(shortModel(v.leadModel))} · summaries only</text>`
  b += `<text x="${x + w - 10}" y="24" text-anchor="end" class="m dim">[ ${v.blocked ? `<tspan fill="#e5c07b">guard ${v.blocked} blocked</tspan>` : 'guard ok'} ]</text>`
  b += `<text x="${x + 10}" y="44" class="m dim">subagents read</text><text x="${x + 170}" y="44" text-anchor="end" class="m b" fill="#6fa8ff">${tok(read)} tok</text>`
  b += `<rect x="${bx}" y="37" width="${((bw * read) / max).toFixed(1)}" height="8" rx="1" fill="#6fa8ff"/>`
  b += `<text x="${x + 10}" y="60" class="m dim">lead received</text><text x="${x + 170}" y="60" text-anchor="end" class="m b" fill="#98c379">${tok(got)} tok</text>`
  b += `<rect x="${bx}" y="53" width="${Math.max(2, (bw * got) / max).toFixed(1)}" height="8" rx="1" fill="#98c379"/>`
  b += `<text x="${x + 10}" y="81" class="m">${ratio > 1 ? `= <tspan class="b" fill="${leadC}">${ratio}×</tspan> less in the lead's context than the agents read` : got > 0 ? '= agents returned about as much as they read' : '= no agent reports yet'}</text>`
  return monoCard(100, b)
}

function svgSpend(v: View): string {
  let defs = ''
  for (const n of v.seriesNames) {
    const c = hex(v.colors[n] ?? OTHER)
    defs += `<linearGradient id="${gid(n)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="0.85"/><stop offset="1" stop-color="${c}" stop-opacity="0.15"/></linearGradient>`
  }
  const legend = v.seriesNames
    .slice(0, 4)
    .map((n, i) => `<rect x="${PAD + 150 + i * 62}" y="11" width="8" height="8" rx="2" fill="${hex(v.colors[n] ?? OTHER)}"/><text x="${PAD + 162 + i * 62}" y="19" class="dim">${xml(clip(n, 9))}</text>`)
    .join('')
  const b = `<text x="${PAD}" y="19" class="h">SPEND RATE</text>${legend}` + svgArea(v.seriesNames, v.colors, PAD, 30, VW - 2 * PAD - 40, 90)
  return card(140, b, defs)
}

// Min-max scaling for a sparkline whose values stay in a narrow band (the lead's
// context): the lowest value sits just above the baseline, the highest at the top.
function minMax(values: number[]): { values: number[]; max: number } {
  if (values.length === 0) return { values, max: 1 }
  const lo = Math.min(...values), hi = Math.max(...values)
  if (hi - lo < 1) return { values: values.map(() => 0.5), max: 1 }
  const floor = (hi - lo) * 0.12
  return { values: values.map(v => v - lo + floor), max: hi - lo + floor }
}

// Finished agents, newest first.
function finished(list: Seen[], n = 8): Seen[] {
  return list.filter(a => DONE.has(a.status)).sort((a, b) => (b.end ?? b.start) - (a.end ?? a.start)).slice(0, n)
}

function svgDone(v: View): string {
  const rows = finished(v.list)
  if (rows.length === 0) return ''
  const h = 30 + rows.length * 14
  let b = `<text x="${PAD}" y="18" class="hd" fill="#c7cbd6">DONE <tspan class="dim" font-weight="400">${v.list.filter(a => DONE.has(a.status)).length} finished</tspan></text>`
  rows.forEach((a, i) => {
    const y = 34 + i * 14
    const ok = a.status === 'completed'
    const c = hex(RGB[family(a.model)] ?? OTHER)
    b += `<text x="${PAD}" y="${y}" class="m dim">${clock(a.end ?? a.start)}</text>`
    b += `<text x="${PAD + 58}" y="${y}" class="m b" fill="${ok ? '#98c379' : '#e06c75'}">${ok ? '✓ ok' : '✗ fail'}</text>`
    b += `<text x="${PAD + 104}" y="${y}" class="m" fill="${c}">${xml(clip(a.type, 16))}</text>`
    b += `<text x="${PAD + 210}" y="${y}" class="m dim">${xml(shortModel(a.model))}</text>`
    b += `<text x="${VW - PAD}" y="${y}" text-anchor="end" class="m">${dur((a.end ?? v.now) - a.start)}<tspan class="dim"> · ${usd(a.usd)}</tspan></text>`
  })
  return monoCard(h, b)
}

// ---- plan limits: 5h, weekly, per-model weekly, with an ETA ---------------------------

type Meter = { key: string; label: string; percent: number; resetsAt?: number }
let meters: Meter[] = []
const meterHist: Record<string, { t: number; p: number }[]> = {}
let usageSource: 'account' | 'headers' | '' = ''
let usageTicks = 0
const HOUR = 3600000

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

function meterLabel(kind: string, model?: string): string {
  if (/^(session|five_hour)$/.test(kind)) return '5h'
  if (/^(weekly_all|seven_day)$/.test(kind)) return 'Week'
  if (kind === 'weekly_scoped') return model ? `Week ${model}` : 'Week (model)'
  const m = /^seven_day_([a-z]+)$/.exec(kind)
  if (m && m[1]) return 'Week ' + m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return kind
}

function meterShown(label: string): boolean {
  return label === '5h' || label === 'Week' || /^Week (Fable|Opus|Sonnet|Haiku)/i.test(label)
}

// The account usage response, in either the row form (kind/percent/scope) or the
// keyed form (five_hour/seven_day_* with utilization).
function parseUsage(j: unknown): Meter[] {
  const out: Meter[] = []
  const seenKeys = new Set<string>()
  const add = (kind: string, model: string | undefined, pct: unknown, reset: unknown) => {
    if (typeof pct !== 'number') return
    const label = meterLabel(kind, model)
    const key = label.toLowerCase()
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    out.push({ key, label, percent: Math.round(pct * 10) / 10, resetsAt: toMs(reset) })
  }
  const walk = (x: unknown, depth: number) => {
    if (!x || depth > 6) return
    if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1)
      return
    }
    if (typeof x !== 'object') return
    const o = x as Record<string, any>
    if (typeof o.kind === 'string' && typeof o.percent === 'number') add(o.kind, o.scope?.model?.display_name, o.percent, o.resets_at ?? o.resetsAt)
    for (const [k, v] of Object.entries(o)) {
      if (/^(five_hour|seven_day[a-z_]*)$/.test(k) && v && typeof v === 'object' && typeof (v as any).utilization === 'number') add(k, undefined, (v as any).utilization, (v as any).resets_at)
      else if (v && typeof v === 'object') walk(v, depth + 1)
    }
  }
  walk(j, 0)
  return out
}

async function fetchLimits($: any) {
  try {
    const now = await $.clock.now()
    const list: Meter[] = []
    try {
      const u = await $.session.usage()
      for (const r of u?.rateLimits ?? []) {
        if (r.kind === 'spend_limit') continue
        const label = meterLabel(r.kind)
        list.push({ key: label.toLowerCase(), label, percent: r.percentUsed, resetsAt: toMs(r.resetsAt) })
      }
      if (list.length) usageSource = 'headers'
    } catch {}
    try {
      const a = await $.session.authorize()
      if (a && a.handle) {
        const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage?skip_spend=1', {
          auth: a.handle,
          headers: { 'anthropic-beta': 'oauth-2025-04-20' },
        })
        if (res && res.ok) {
          for (const m of parseUsage(JSON.parse(res.text))) {
            const i = list.findIndex(x => x.key === m.key)
            if (i >= 0) list[i] = { ...m, resetsAt: m.resetsAt ?? list[i]!.resetsAt }
            else list.push(m)
          }
          usageSource = 'account'
        }
      }
    } catch {}
    const order = (l: string) => (l === '5h' ? 0 : l === 'Week' ? 1 : 2)
    meters = list.filter(m => meterShown(m.label)).sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label))
    for (const m of meters) {
      const h = (meterHist[m.key] ??= [])
      const last = h[h.length - 1]
      if (last && m.percent < last.p - 1) h.length = 0 // the window reset
      h.push({ t: now, p: m.percent })
      while (h.length > 0 && now - (h[0]?.t ?? now) > 6 * HOUR) h.shift()
      if (h.length > 400) h.splice(0, h.length - 400)
    }
    $.ui.invalidate('ui.render')
  } catch {}
}

function fmtIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

function fmtWhen(t: number, now: number): string {
  const d = new Date(t)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (t - now < 20 * HOUR && new Date(now).getDate() === d.getDate()) return hm
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`
}

type Eta = { text: string; level: 'ok' | 'warn' | 'bad' }

function meterEta(m: Meter, now: number): Eta {
  if (m.percent >= 100) return { text: 'at the limit', level: 'bad' }
  const h = (meterHist[m.key] ?? []).filter(s => now - s.t <= HOUR)
  let rate = 0
  let basis = ''
  const a = h[0], b = h[h.length - 1]
  if (a && b && b.t - a.t >= 5 * 60000 && b.p > a.p) {
    rate = (b.p - a.p) / (b.t - a.t)
    basis = 'current pace'
  }
  if (!rate && m.resetsAt) {
    const win = m.label === '5h' ? 5 * HOUR : 7 * 24 * HOUR
    const start = m.resetsAt - win
    if (now > start && m.percent > 0) {
      rate = m.percent / (now - start)
      basis = 'average pace'
    }
  }
  if (!rate) return { text: 'no usage yet', level: 'ok' }
  const eta = now + (100 - m.percent) / rate
  if (m.resetsAt && eta >= m.resetsAt) return { text: `ok · resets before full (${basis})`, level: 'ok' }
  return { text: `full ≈ ${fmtWhen(eta, now)}, in ${fmtIn(eta - now)} (${basis})`, level: eta - now < HOUR ? 'bad' : 'warn' }
}

function pctColor(p: number): string {
  return p >= 90 ? '#e06c75' : p >= 70 ? '#e5c07b' : '#98c379'
}
function etaColor(l: Eta['level']): string {
  return l === 'bad' ? '#e06c75' : l === 'warn' ? '#e5c07b' : '#7f8796'
}

function svgLimits(now: number): string {
  if (meters.length === 0) return ''
  const h = 26 + meters.length * 30
  let b = `<text x="${PAD}" y="18" class="hd" fill="#c7cbd6">PLAN LIMITS <tspan class="dim" font-weight="400">${usageSource === 'account' ? 'account usage' : '5h/week from responses'}</tspan></text>`
  meters.forEach((m, i) => {
    const y = 34 + i * 30
    const e = meterEta(m, now)
    const bx = PAD + 92, bw = VW - PAD - bx - 44
    b += `<text x="${PAD}" y="${y}" class="m b" fill="#e6e9ef">${xml(m.label)}</text>`
    b += `<rect x="${bx}" y="${y - 8}" width="${bw}" height="9" rx="2" fill="#2c313c"/><rect x="${bx}" y="${y - 8}" width="${((bw * Math.min(100, m.percent)) / 100).toFixed(1)}" height="9" rx="2" fill="${pctColor(m.percent)}"/>`
    b += `<text x="${VW - PAD}" y="${y}" text-anchor="end" class="m b" fill="${pctColor(m.percent)}">${m.percent}%</text>`
    b += `<text x="${PAD}" y="${y + 13}" class="s dim">${m.resetsAt ? `resets ${xml(fmtWhen(m.resetsAt, now))}` : ''}</text>`
    b += `<text x="${VW - PAD}" y="${y + 13}" text-anchor="end" class="s" fill="${etaColor(e.level)}">${xml(e.text)}</text>`
  })
  return monoCard(h, b)
}

function svgShare(v: View): string {
  const rows = Math.max(1, Math.min(6, v.shares.length))
  const h = Math.max(104, 30 + rows * 15 + 10)
  let b = `<text x="${PAD}" y="19" class="h">COST SHARE</text>` + svgDonut(v.shares, v.colors, PAD + 48, h / 2 + 8, 34)
  const tot = v.shares.reduce((a, c) => a + c.usd, 0) || 1
  v.shares.slice(0, 6).forEach((sh, i) => {
    const ly = 40 + i * 15
    b += `<rect x="${PAD + 110}" y="${ly - 8}" width="9" height="9" rx="2" fill="${hex(v.colors[sh.name] ?? OTHER)}"/><text x="${PAD + 124}" y="${ly}" class="t">${xml(clip(sh.name, 18))}</text><text x="${VW - PAD}" y="${ly}" text-anchor="end" class="dim">${usd(sh.usd)} · ${Math.round((sh.usd / tot) * 100)}%</text>`
  })
  if (v.shares.length === 0) b += `<text x="${PAD + 110}" y="40" class="dim">no cost yet</text>`
  return card(h, b)
}

function svgAgents(v: View): string {
  const cards = v.list.slice(0, 8)
  const running = v.list.filter(a => !DONE.has(a.status)).length
  const h = 30 + Math.max(1, cards.length) * 52
  let b = `<text x="${PAD}" y="19" class="h">AGENTS <tspan class="dim" font-weight="400" letter-spacing="0">${running} running · ${v.list.length} this session</tspan></text>`
  if (cards.length === 0) b += `<text x="${PAD}" y="44" class="dim">none yet</text>`
  cards.forEach((a, i) => {
    const cy = 28 + i * 52
    const isRun = !DONE.has(a.status)
    const c = hex(v.colors[a.type] ?? RGB[family(a.model)] ?? OTHER)
    const act = v.acts[a.id]
    const pill = isRun ? '#2b3a2f' : a.status === 'completed' ? '#2c313c' : '#3b2a2d'
    const pillT = isRun ? '#98c379' : a.status === 'completed' ? '#8b93a4' : '#e06c75'
    b += `<rect x="${PAD}" y="${cy}" width="${VW - 2 * PAD}" height="46" rx="7" fill="#1f242d" stroke="${isRun ? c : '#2c313c'}" stroke-opacity="${isRun ? 0.7 : 1}"/>`
    b += `<rect x="${PAD}" y="${cy}" width="4" height="46" rx="2" fill="${c}"/>`
    b += `<text x="${PAD + 12}" y="${cy + 17}" class="t" font-weight="600">${xml(clip(a.type, 16))} <tspan fill="${c}" font-weight="400">${xml(shortModel(a.model))}</tspan>${a.effort ? `<tspan class="dim" font-weight="400"> ${xml(a.effort)}</tspan>` : ''}</text>`
    b += `<rect x="${VW - PAD - 150}" y="${cy + 7}" width="62" height="14" rx="7" fill="${pill}"/><text x="${VW - PAD - 119}" y="${cy + 17}" text-anchor="middle" font-size="8.5" fill="${pillT}">${xml(a.status)}</text>`
    b += `<text x="${VW - PAD - 8}" y="${cy + 17}" text-anchor="end" class="dim">${dur((a.end ?? v.now) - a.start)} · ${usd(a.usd)}</text>`
    b += `<text x="${PAD + 12}" y="${cy + 36}" class="dim">${xml(clip(isRun && act ? `${act.tool} ${act.detail}` : a.desc, 42))}</text>`
    b += svgSpark(a.samples, c, VW - PAD - 120, cy + 26, 76, 14)
    b += `<text x="${VW - PAD - 8}" y="${cy + 38}" text-anchor="end" class="dim">${tok(a.tokens)}</text>`
  })
  return card(h, b)
}

// ---- state writers ------------------------------------------------------------------

async function addLog($: any, who: string, text: string) {
  const at = await $.clock.now()
  await update($, log, (l: LogLine[]) => [...l, { at, who, text }].slice(-LOG_MAX))
}

async function poll($: any) {
  if (++usageTicks % 30 === 0) void fetchLimits($)
  try {
    const [list, now, usage] = await Promise.all([$.agent.list(), $.clock.now(), $.session.usage().catch(() => undefined)])
    await update($, seen, (prev: Record<string, Seen>) => {
      const next: Record<string, Seen> = { ...prev }
      for (const a of list) {
        const old = prev[a.id]
        const status = String(a.status)
        next[a.id] = {
          id: a.id,
          type: a.type,
          desc: a.description || a.label || '',
          model: a.model ?? a.lastRequest?.model ?? old?.model ?? '',
          effort: String(a.effort ?? a.lastRequest?.effort ?? old?.effort ?? ''),
          parent: a.parentId ?? old?.parent,
          status,
          start: a.startTime,
          end: DONE.has(status) ? (old?.end ?? now) : undefined,
          tokens: a.tokenCount ?? 0,
          samples: (a.tokenSamples ?? []).slice(-24),
          usd: a.cost?.usd ?? old?.usd ?? 0,
        }
      }
      const kept: Record<string, Seen> = {}
      for (const one of Object.values(next).sort((x, y) => y.start - x.start).slice(0, KEEP_AGENTS)) kept[one.id] = one
      return kept
    })
    const agents = Object.values((await read($, seen)) as Record<string, Seen>)
    const v: Record<string, number> = {}
    let agentUsd = 0
    for (const a of agents) {
      v[a.type] = (v[a.type] ?? 0) + a.usd
      agentUsd += a.usd
    }
    v.lead = Math.max(0, (usage?.cost?.usd ?? 0) - agentUsd)
    history = [...history, { t: now, v }].slice(-HISTORY)
  } catch {
    // keep the last snapshot
  }
  $.ui.invalidate('ui.render')
}

// ---- hooks -----------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'board', description: 'Open the Agent Board pane (models, activity, tokens per agent)' })
    void $.ui.open({ id: PANE, title: 'Agent Board' })
    $.clock.every(POLL_MS, () => {
      void poll($)
    })
    await Promise.race([fetchLimits($), $.clock.sleep(1500)]).catch(() => {})
    return result
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent Board' })
    return { text: 'Agent Board opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const who = e.agentId ?? 'main'
    try {
      const at = await $.clock.now()
      const act: Activity = { tool: e.tool, detail: detailOf(e as unknown as Record<string, unknown>), at }
      void update($, activity, (a: Record<string, Activity>) => ({ ...a, [who]: act }))
    } catch {
      // recording must never stop the call
    }
    const result = await next(e)
    if (result && typeof result === 'object' && 'deny' in result && result.deny) {
      void addLog($, who, `blocked ${e.tool}: ${clip(String(result.deny), 60)}`)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny) {
      void addLog($, 'main', `${e.subagentType} refused`)
    } else {
      void addLog($, result.agentId ?? 'main', `${e.subagentType} on ${shortModel(result.model)}: ${clip(e.description, 40)}`)
    }
    void poll($)
    return result
  })

  on('agent.report', async ($, e, next) => {
    void addLog($, e.agentId, `${e.subagentType} ${e.status}`)
    reportTok += Math.ceil((e.text ?? '').length / 4)
    const at = await $.clock.now()
    void update($, seen, (s: Record<string, Seen>) => {
      const one = s[e.agentId]
      if (!one) return s
      const changed: Seen = { ...one, status: e.status, end: one.end ?? at }
      return { ...s, [e.agentId]: changed }
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      leadStepAt = await $.clock.now()
      $.ui.invalidate('ui.render')
    }
    let r
    try {
      r = yield* next(e)
    } finally {
      if (!e.agentId) leadStepAt = undefined
    }
    if (!e.agentId) {
      if (e.effort !== undefined) leadEffort = String(e.effort)
      if (e.model) leadModelCache = e.model
      const calls = (r?.serverToolUses ?? []).filter(u => u.name === 'advisor')
      if (calls.length > 0) {
        adv.calls += calls.length
        adv.last = calls[calls.length - 1]?.startedAt ?? (await $.clock.now())
        const u = r?.usage
        adv.read += u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
        void addLog($, 'advisor', `consulted (${adv.calls} so far)`)
        $.ui.invalidate('ui.render')
      }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.usage) {
      const u = e.usage
      if (u.model) leadModelCache = u.model
      const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      void update($, lead, (l: Lead) => ({
        turns: l.turns + 1,
        input: l.input + ctx,
        output: l.output + (u.output_tokens ?? 0),
        samples: [...l.samples, ctx].slice(-24),
      }))
      void addLog($, 'main', `lead turn done (${dur(e.durationMs)}, ${tok(u.output_tokens ?? 0)} out)`)
      void fetchLimits($)
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Raster exists on the terminal, Svg on desktop/VS Code/mobile; each branch uses its own.
    const { Box, Text, Raster, Svg } = $.ui.resolve(e) as any
    const cols = Math.max(34, Math.min(120, e.props?.bodyColumns ?? 48))
    const rows = Math.max(12, e.props?.scroll?.bodyRows ?? 30)

    const [model, usage, agents, acts, lines, l, advisor, now] = await Promise.all([
      $.session.model().catch(() => ''),
      $.session.usage().catch(() => undefined),
      read($, seen),
      read($, activity),
      read($, log),
      read($, lead),
      $.settings.read({ key: 'advisorModel' }).catch(() => undefined),
      $.clock.now(),
    ])

    const advRaw: unknown = advisor
    const advName =
      typeof advRaw === 'string' ? advRaw
      : advRaw && typeof advRaw === 'object' && typeof (advRaw as Record<string, unknown>).advisorModel === 'string'
        ? ((advRaw as Record<string, unknown>).advisorModel as string)
        : ''

    const list = Object.values(agents as Record<string, Seen>).sort((a, b) => b.start - a.start)
    const actMap = acts as Record<string, Activity>
    const L = l as Lead
    const total = usage?.cost?.usd ?? 0
    const agentUsd = list.reduce((s, a) => s + a.usd, 0)
    const leadUsd = Math.max(0, total - agentUsd)
    const leadModel = String(model || leadModelCache || '')

    // Series: lead first, then agent types by first appearance (oldest first, so colours stay put).
    const typeModel = new Map<string, string>()
    for (const a of [...list].reverse()) if (!typeModel.has(a.type)) typeModel.set(a.type, a.model)
    const seriesDefs = [{ name: 'lead', model: leadModel }, ...[...typeModel].map(([name, m]) => ({ name, model: m }))]
    const colors = palette(seriesDefs)
    const seriesNames = seriesDefs.map(s => s.name)
    const byType = new Map<string, number>()
    for (const a of list) byType.set(a.type, (byType.get(a.type) ?? 0) + a.usd)
    const shares = [{ name: 'lead', usd: leadUsd }, ...[...byType].map(([name, u]) => ({ name, usd: u }))]
      .filter(s => s.usd > 0)
      .sort((a, b) => b.usd - a.usd)

    const whoOf = (w: string) => (w === 'main' ? 'lead' : w === 'advisor' ? 'advisor' : (agents as Record<string, Seen>)[w]?.type ?? 'agent')
    const whoColor = (w: string) =>
      hex(w === 'main' ? (RGB[family(leadModel)] ?? OTHER) : w === 'advisor' ? (RGB[family(advName || 'opus')] ?? OTHER) : (RGB[family((agents as Record<string, Seen>)[w]?.model ?? '')] ?? OTHER))
    const logRows = (lines as LogLine[]).slice(-8).map(x => (
      <Text wrap="truncate-end">
        <Text dimColor>{clock(x.at)} </Text>
        <Text color={whoColor(x.who)}>{whoOf(x.who).padEnd(9)}</Text>
        <Text dimColor> {x.text}</Text>
      </Text>
    ))

    const blocked = (lines as LogLine[]).filter(x => x.text.startsWith('blocked ')).length

    // ---- remote surfaces: vector cards + a selectable log ----
    if (e.surface !== 'terminal') {
      const view: View = {
        total, ctxPct: usage?.context?.percent, leadModel, advisor: advName, leadAct: actMap.main, leadUsd, l: L,
        list, acts: actMap, colors, seriesNames, shares, now, blocked,
        leadEffort, ctxTok: usage?.context?.tokens ?? ctxTokCache, adv, reportTok, stepFor: leadStepAt !== undefined ? now - leadStepAt : undefined,
      }
      const dispatch = svgDispatch(view)
      const running = list.filter(a => !DONE.has(a.status)).length
      const alt = `${list.length} agents, ${usd(total)} estimated`
      return (
        <Box flexDirection="column" gap={1}>
          <Svg source={svgTop(view)} alt={`Main session ${shortModel(leadModel)}, advisor ${advName || 'off'}`} />
          {svgLimits(now) ? <Svg source={svgLimits(now)} alt="Plan limits" /> : null}
          {dispatch ? <Svg source={dispatch} alt={`${running} subagents running`} /> : null}
          {svgDone(view) ? <Svg source={svgDone(view)} alt="Finished subagents" /> : null}
          {reportTok > 0 ? <Svg source={svgBack(view)} alt="Tokens the agents read versus what came back to the lead" /> : null}
          <Svg source={svgSpend(view)} alt="Spend rate per series" />
          <Svg source={svgShare(view)} alt="Cost share per series" />
          <Box flexDirection="column">
            <Text bold>LOG</Text>
            {logRows.length === 0 ? <Text dimColor>nothing yet</Text> : logRows}
          </Box>
          <Text dimColor wrap="truncate-end">
            subagents [{running}/{list.length}] · advisor [{adv.last !== undefined && now - adv.last < 15000 ? 'just consulted' : advName ? `${adv.calls} calls` : 'off'}] · guard [{blocked ? `${blocked} blocked` : 'ok'}]{leadEffort ? ` · effort [${leadEffort}]` : ''}
          </Text>
        </Box>
      )
    }

    // ---- terminal: true-colour braille charts ----
    const W = cols - 2
    const fg = (name: string) => hex(colors[name] ?? OTHER)
    const chartRows = rows >= 34 ? 8 : 6
    const rate = rates(seriesNames)
    const maxStack = Math.max(0, ...rate.map(p => seriesNames.reduce((s, n) => s + (p.v[n] ?? 0), 0)))
    const stack = seriesNames.map(n => ({ color: colors[n] ?? OTHER, values: rate.map(p => p.v[n] ?? 0) }))
    const shareTotal = shares.reduce((s, x) => s + x.usd, 0) || 1
    const leadAct = actMap.main
    const leadFg = fg('lead')
    const sparkW = Math.max(8, Math.min(20, Math.floor(W / 4)))

    const liveList = list.filter(a => !DONE.has(a.status))
    const doneList = finished(list)
    const doneRows = doneList.map(a => {
      const ok = a.status === 'completed'
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{clock(a.end ?? a.start)} </Text>
          <Text color={ok ? '#98c379' : '#e06c75'} bold>{ok ? '✓ ok  ' : '✗ fail'}</Text>
          <Text color={fg(a.type)}> {clip(a.type, 14).padEnd(14)}</Text>
          <Text dimColor> {shortModel(a.model).padEnd(10)} {dur((a.end ?? now) - a.start).padStart(6)} · {usd(a.usd)}</Text>
        </Text>
      )
    })
    const agentRows = liveList.slice(0, Math.max(2, Math.floor((rows - chartRows - 22) / 2))).map(a => {
      const isRunning = !DONE.has(a.status)
      const act = actMap[a.id]
      const c = fg(a.type)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={c} bold={isRunning} dimColor={!isRunning}>
              {isRunning ? '●' : a.status === 'completed' ? '✓' : '✗'} {clip(a.type, 14)}
            </Text>
            <Text color={c} dimColor={!isRunning}>{shortModel(a.model)}</Text>
            {a.effort ? <Text dimColor>{a.effort}</Text> : null}
            <Text dimColor>
              {a.status} {dur((a.end ?? now) - a.start)} · {usd(a.usd)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text> </Text>
            <Raster key={`spark-${a.id}`} columns={sparkW} rows={1} cells={brailleStack([{ color: colors[a.type] ?? OTHER, values: a.samples }], sparkW, 1, Math.max(1, ...a.samples))} />
            <Text dimColor>{tok(a.tokens)}</Text>
            <Text dimColor wrap="truncate-end">
              {isRunning && act ? `${act.tool} ${clip(act.detail, Math.max(10, W - sparkW - 12))}` : clip(a.desc, Math.max(10, W - sparkW - 10))}
            </Text>
          </Box>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>AGENT BOARD</Text>
          <Text dimColor>
            {usd(total)} est{usage?.context?.percent !== undefined ? ` · ctx ${usage.context.percent}%` : ''}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold color={leadFg}>● lead</Text>
            <Text color={leadFg}>{shortModel(leadModel)}</Text>
            {advName ? <Text dimColor>· advisor {shortModel(advName)} (settings)</Text> : null}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text> </Text>
            <Raster key="spark-lead" columns={sparkW} rows={1} cells={(() => { const mm = minMax(L.samples); return brailleStack([{ color: colors.lead ?? OTHER, values: mm.values }], sparkW, 1, mm.max) })()} />
            <Text dimColor wrap="truncate-end">
              {tok(L.input)} in · {tok(L.output)} out · {usd(leadUsd)} · {leadStepAt !== undefined && now - leadStepAt > 3000 ? `requesting ${dur(now - leadStepAt)}` : leadAct ? `${leadAct.tool} ${clip(leadAct.detail, Math.max(10, W - sparkW - 30))}` : 'idle'}
            </Text>
          </Box>
          {advName ? (
            <Text wrap="truncate-end">
              <Text color={hex(RGB[family(advName)] ?? OTHER)}>◆ advisor {shortModel(advName)}</Text>
              <Text dimColor>
                {' '}· {adv.calls} {adv.calls === 1 ? 'call' : 'calls'}
                {adv.last !== undefined ? ` · last ${clock(adv.last)}` : ''}
                {adv.read ? ` · ≈${tok(adv.read)} read` : ''}
              </Text>
              {adv.last !== undefined && now - adv.last < 15000 ? <Text color={hex(RGB[family(advName)] ?? OTHER)} bold> just consulted</Text> : null}
            </Text>
          ) : null}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            LIMITS <Text dimColor>{usageSource === 'account' ? '' : '(5h/week from responses)'}</Text>
          </Text>
          {meters.length === 0 ? <Text dimColor>  no limit data yet</Text> : meters.map(m => {
            const e = meterEta(m, now)
            const bw = Math.max(8, Math.min(24, W - 40))
            const fill = Math.round((bw * Math.min(100, m.percent)) / 100)
            return (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text bold>{m.label.padEnd(11)}</Text>
                  <Text color={pctColor(m.percent)}>{'█'.repeat(fill)}</Text>
                  <Text dimColor>{'░'.repeat(bw - fill)}</Text>
                  <Text color={pctColor(m.percent)} bold> {String(m.percent).padStart(5)}%</Text>
                  <Text dimColor>{m.resetsAt ? ` · resets ${fmtWhen(m.resetsAt, now)}` : ''}</Text>
                </Text>
                <Text color={etaColor(e.level)} wrap="truncate-end">{'           '}{e.text}</Text>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>FLOW</Text>
          {flowLines({ total, ctxPct: usage?.context?.percent, leadModel, advisor: advName, leadAct, leadUsd, l: L, list, acts: actMap, colors, seriesNames, shares, now, blocked }, W).map(r => (
            <Text color={r.color} dimColor={r.dim} wrap="truncate-end">{r.text}</Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>SPEND RATE</Text>
            <Text dimColor>{maxStack > 0 ? `peak ${rateLabel(maxStack)} · last ${Math.max(1, Math.round((history.length * POLL_MS) / 60000))}m` : 'collecting…'}</Text>
          </Box>
          <Raster key="stack" columns={W} rows={chartRows} cells={brailleStack(stack, W, chartRows, maxStack)} />
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {seriesNames.map(n => (
              <Text color={fg(n)}>■ {n}</Text>
            ))}
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>COST SHARE</Text>
          <Raster key="share" columns={W} rows={1} cells={shareBar(shares.map(s => ({ color: colors[s.name] ?? OTHER, frac: s.usd / shareTotal })), W)} />
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {shares.length === 0 ? (
              <Text dimColor>no cost yet</Text>
            ) : (
              shares.map(s => (
                <Text color={fg(s.name)}>
                  {s.name} {Math.round((s.usd / shareTotal) * 100)}%
                </Text>
              ))
            )}
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            AGENTS <Text dimColor>{list.filter(a => !DONE.has(a.status)).length} running · {list.length} this session</Text>
          </Text>
          {agentRows.length === 0 ? <Text dimColor>  none running</Text> : agentRows}
        </Box>

        <Box flexDirection="column" marginTop={doneRows.length ? 1 : 0}>
          {doneRows.length ? <Text bold>DONE <Text dimColor>{list.length - liveList.length} finished</Text></Text> : null}
          {doneRows}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>LOG</Text>
          {logRows.length === 0 ? <Text dimColor>  nothing yet</Text> : logRows.slice(-Math.max(3, rows - chartRows - 20 - agentRows.length * 2 - doneRows.length))}
        </Box>
      </Box>
    )
  })
}
