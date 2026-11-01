/**
 * Map the original software's settings files (penplot/settings.py classes) into a ProfileDoc partial.
 *   settings.json → doc.settings   Grbl.json → doc.grbl (+type Grbl)   EBB.json → doc.ebb (+Ebb)
 *   Marlin.json → doc.marlin (+Marlin)   K_AT.json/Kat.json → doc.kat (+K_AT)
 *   Advanced.json → doc.advanced   Axes.json → doc.axes
 *   A whole MachineConfig / profile export ({type, settings, grbl, …}) passes through.
 * Unknown keys are kept (the server keeps them too) and reported.
 */

export type SectionKey = 'settings' | 'grbl' | 'marlin' | 'ebb' | 'kat' | 'advanced' | 'axes' | 'connection' | 'work_area' | 'print_defaults'
export type MachineType = 'Grbl' | 'Marlin' | 'Ebb' | 'K_AT'

export const KNOWN_FIELDS: Record<SectionKey, string[]> = {
  settings: ['dpi', 'useSysDpi', 'feedRate', 'jogSpeed', 'toolOnDelay', 'toolOffDelay', 'nearDst', 'offsetX', 'offsetY', 'rotate', 'singleStep', 'autoSetZero', 'autoConnect', 'autoSleep', 'updateStatus', 'maxImageSize', 'sheetAutoAlignScale', 'alertFileComplete'],
  grbl: ['type', 'penUpPos', 'penDownPos', 'ecoServo', 'zOn', 'zOff', 'zSpeed', 'laserS'],
  marlin: ['type', 'penUpPos', 'penDownPos', 'penUpMM', 'penDownMM', 'zSpeed', 'fanSpeed'],
  ebb: ['mmToSteps', 'penUpPos', 'penDownPos', 'penUpSpeed', 'penDownSpeed'],
  kat: ['penUpE', 'penDownE', 'penSpeed', 'feedOutY', 'parkX'],
  advanced: ['startGcode', 'endGcode', 'macro1', 'macro2', 'macro3', 'zJogStep'],
  axes: ['revxy', 'xAxeRev', 'yAxeRev', 'pos'],
  connection: ['port', 'baud', 'auto_connect', 'reset_on_connect'],
  work_area: ['w_mm', 'h_mm'],
  print_defaults: [],
}

export const SECTION_LABEL: Record<SectionKey, string> = {
  settings: '通用设置', grbl: 'GRBL 笔参数', marlin: 'Marlin 笔参数', ebb: 'EBB 笔参数', kat: 'K_AT 笔参数',
  advanced: '高级（起止 G 代码 / 宏）', axes: '坐标轴', connection: '连接', work_area: '机器行程', print_defaults: '打印默认值',
}

const SECTION_TYPE: Partial<Record<SectionKey, MachineType>> = { grbl: 'Grbl', marlin: 'Marlin', ebb: 'Ebb', kat: 'K_AT' }
const ALL_SECTIONS = Object.keys(KNOWN_FIELDS) as SectionKey[]

type Dict = Record<string, unknown>

export interface DetectedFile {
  file: string
  /** 'machine' = whole MachineConfig / profile export. */
  kind: SectionKey | 'machine' | 'unknown'
  sections: SectionKey[]
  type?: MachineType
  unknownKeys: string[]
  error?: string
  doc: Dict
}

export interface ImportPlan {
  files: DetectedFile[]
  doc: Dict
  sections: SectionKey[]
  type: MachineType | null
  unknownKeys: string[]
  suggestedName: string
}

function isObj(v: unknown): v is Dict {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function byFilename(name: string): SectionKey | null {
  const base = name.toLowerCase().replace(/\.json$/, '').replace(/.*[\\/]/, '')
  if (base === 'settings' || base === 'setting') return 'settings'
  if (base === 'grbl') return 'grbl'
  if (base === 'ebb') return 'ebb'
  if (base === 'marlin') return 'marlin'
  if (base === 'k_at' || base === 'kat' || base === 'k-at') return 'kat'
  if (base === 'advanced') return 'advanced'
  if (base === 'axes') return 'axes'
  return null
}

function byKeys(o: Dict): SectionKey | null {
  const has = (...k: string[]) => k.some((x) => x in o)
  if (has('feedRate', 'jogSpeed', 'toolOnDelay', 'nearDst', 'autoSetZero')) return 'settings'
  if (has('mmToSteps', 'penUpSpeed')) return 'ebb'
  if (has('penUpE', 'penDownE', 'feedOutY')) return 'kat'
  if (has('penUpMM', 'penDownMM', 'fanSpeed')) return 'marlin'
  if (has('zOn', 'zOff', 'laserS', 'ecoServo')) return 'grbl'
  if (has('startGcode', 'endGcode', 'macro1')) return 'advanced'
  if (has('revxy', 'xAxeRev', 'yAxeRev')) return 'axes'
  return null
}

function unknownOf(section: SectionKey, o: Dict, prefix = ''): string[] {
  const known = KNOWN_FIELDS[section]
  if (!known.length) return []
  return Object.keys(o).filter((k) => !known.includes(k)).map((k) => prefix + k)
}

export function detectFile(file: string, text: string): DetectedFile {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { file, kind: 'unknown', sections: [], unknownKeys: [], error: '不是有效的 JSON', doc: {} }
  }
  if (!isObj(data)) return { file, kind: 'unknown', sections: [], unknownKeys: [], error: 'JSON 顶层不是对象', doc: {} }

  // whole MachineConfig / profile export (also accept {doc:{…}} wrappers)
  const root = isObj(data.doc) ? (data.doc as Dict) : data
  const nested = ALL_SECTIONS.filter((s) => isObj(root[s]))
  if (nested.length) {
    const doc: Dict = {}
    const unknownKeys: string[] = []
    for (const s of nested) {
      doc[s] = root[s]
      unknownKeys.push(...unknownOf(s, root[s] as Dict, `${s}.`))
    }
    for (const [k, v] of Object.entries(root)) {
      if (k === 'type' || nested.includes(k as SectionKey)) continue
      if (['id', 'name', 'is_active', 'updated_at'].includes(k)) continue
      doc[k] = v
      unknownKeys.push(k)
    }
    const t = typeof root.type === 'string' && ['Grbl', 'Marlin', 'Ebb', 'K_AT'].includes(root.type) ? (root.type as MachineType) : undefined
    if (t) doc.type = t
    return { file, kind: 'machine', sections: nested, type: t, unknownKeys, doc }
  }

  const section = byFilename(file) ?? byKeys(data)
  if (!section) return { file, kind: 'unknown', sections: [], unknownKeys: Object.keys(data), error: '无法识别的设置文件', doc: {} }
  const type = SECTION_TYPE[section]
  return { file, kind: section, sections: [section], type, unknownKeys: unknownOf(section, data), doc: { [section]: data } }
}

function merge(a: Dict, b: Dict): Dict {
  const out: Dict = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Dict, v) : v
  return out
}

export function buildPlan(files: DetectedFile[]): ImportPlan {
  let doc: Dict = {}
  const sections = new Set<SectionKey>()
  let type: MachineType | null = null
  const unknownKeys: string[] = []
  // whole configs first, single-section files override them
  const ordered = [...files].sort((a, b) => Number(b.kind === 'machine') - Number(a.kind === 'machine'))
  for (const f of ordered) {
    if (f.error) continue
    doc = merge(doc, f.doc)
    f.sections.forEach((s) => sections.add(s))
    if (f.type && (!type || f.kind !== 'machine')) type = f.type
    unknownKeys.push(...f.unknownKeys.map((k) => (f.kind === 'machine' ? k : `${f.kind}.${k}`)))
  }
  if (type) doc.type = type
  const machineFile = files.find((f) => f.kind === 'machine')
  const suggestedName = machineFile ? machineFile.file.replace(/\.json$/i, '') : type ? `导入的 ${type === 'Ebb' ? 'EBB' : type} 配置` : '导入的配置'
  return { files, doc, sections: ALL_SECTIONS.filter((s) => sections.has(s)), type, unknownKeys, suggestedName }
}

export async function readPlan(files: File[]): Promise<ImportPlan> {
  const detected = await Promise.all(
    files.map(
      (f) =>
        new Promise<DetectedFile>((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(detectFile(f.name, String(r.result ?? '')))
          r.onerror = () => resolve({ file: f.name, kind: 'unknown', sections: [], unknownKeys: [], error: '读取文件失败', doc: {} })
          r.readAsText(f)
        }),
    ),
  )
  return buildPlan(detected)
}
