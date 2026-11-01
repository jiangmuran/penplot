/**
 * Batch data helpers: full CSV rows (client-side parse of /files/{id}/content, UTF-8 or GBK) and
 * variable ↔ column auto-mapping with common Chinese synonyms.
 */
import { request } from '@/api/client'
import type { ProjectVariable } from '@/api/projects'

/** Synonym groups (lower-case). A variable maps to a column in the same group. */
const SYNONYMS: string[][] = [
  ['name', 'fullname', '姓名', '名字', '收件人', '称呼', '收信人', '名称'],
  ['addr', 'address', '地址', '收件地址', '住址', '通讯地址'],
  ['wish', 'greeting', 'blessing', '祝福', '祝福语', '祝语', '寄语'],
  ['phone', 'tel', 'mobile', '电话', '手机', '手机号', '联系电话'],
  ['zip', 'postcode', 'zipcode', '邮编', '邮政编码'],
  ['date', '日期', '时间'],
  ['sender', 'from', '寄件人', '落款', '署名'],
]

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_\-（）()]/g, '')

export function autoMap(variables: ProjectVariable[], columns: string[]): Record<string, string> {
  const m: Record<string, string> = {}
  const used = new Set<string>()
  const cols = columns.map((c) => ({ c, n: norm(c) }))
  for (const v of variables) {
    const keys = [v.name, v.label ?? ''].map(norm).filter(Boolean)
    // 1) exact name/label
    let hit = cols.find((x) => !used.has(x.c) && keys.includes(x.n))
    // 2) synonym group
    if (!hit) {
      const group = SYNONYMS.find((g) => keys.some((k) => g.includes(k)))
      if (group) hit = cols.find((x) => !used.has(x.c) && group.includes(x.n))
    }
    if (hit) {
      m[v.name] = hit.c
      used.add(hit.c)
    }
  }
  return m
}

function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  }
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else q = false
      } else field += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** All data rows (header removed) for a CSV file; null for XLSX or on failure (use sample rows then). */
export async function fetchCsvRows(fileId: string, fileName: string): Promise<string[][] | null> {
  if (!/\.(csv|txt|tsv)$/i.test(fileName)) return null
  try {
    const res = await request<Response>(`/files/${fileId}/content`, { raw: true, headers: { Accept: '*/*' }, timeoutMs: 60_000 })
    const rows = parseCsv(decode(await res.arrayBuffer()))
    return rows.slice(1)
  } catch {
    return null
  }
}
