/**
 * GRBL 1.1 reference tables in Chinese: error:1–38, ALARM:1–9, $-settings metadata.
 *
 *   grblErrorText(20)        → '不支持的 G 代码命令'
 *   grblAlarmText(3)         → '运动中复位，坐标已丢失'
 *   GRBL_ERRORS[20].hint     → longer explanation / what to do
 *   GRBL_SETTINGS_META[110]  → { name: 'X 轴最大速率', unit: 'mm/min', type: 'float', desc: … }
 *   explainGrblLine('error:9') → { kind: 'error', code: 9, title, hint } | null
 */

export interface GrblCode {
  code: number
  /** Short Chinese name. */
  title: string
  /** 含义: what the code means. */
  hint: string
  /** 处理方法: what to do about it. */
  fix: string
}

const ERROR_FIX: Record<number, string> = {
  1: '检查 G 代码文件是否损坏或含有非 G 代码文本；重新生成 G 代码。',
  2: '修正数值格式（只允许一个小数点、不要有千分位逗号）后重新发送。',
  3: '核对命令拼写；$ 命令列表可在控制台发送 $ 查看。',
  4: '把该值改为正数。',
  5: '本机无限位开关，不要使用 $H；需要定位时手动点动后设原点。',
  6: '把 $0 改为 ≥ 3。',
  7: '在「GRBL 参数」中检查全部设置，必要时从备份导入后写入。',
  8: '等待机器空闲（Idle）或暂停任务后再发送 $ 命令。',
  9: '先在控制页点击「解锁」或发送 $X；如果坐标已丢失，抬笔后重新设原点。',
  10: '保持 $20=0（本机无限位开关，不能启用软限位）。',
  11: '缩短该行（G 代码每行 ≤ 80 字符），重新生成 G 代码。',
  12: '降低 $100–$102 或 $110–$112，使步进频率 ≤ 30 kHz。',
  13: '关闭安全门，或检查门开关接线。',
  14: '缩短启动行内容后重新写入。',
  15: '减小点动距离，或先移动到行程内再点动；检查 $130–$132。',
  16: '使用 $J=G91 X… F… 格式的点动命令。',
  17: '关闭激光模式（$32=0）。',
  20: '删除或替换不支持的 G/M 代码（如 G5、M6），重新生成 G 代码；任务可从出错行之后续打。',
  21: '把同组命令拆到不同行（例如 G0 和 G1 不要写在同一行）。',
  22: '在第一条 G1 前加 F 进给速度，或在打印设置中设置进给速度。',
  23: '把参数改为整数。',
  24: '把需要坐标的命令拆到不同行。',
  25: '删除重复的字母（例如一行中两个 X）。',
  26: '补全坐标轴参数。',
  27: '删除 N 行号或改为有效范围。',
  28: '补全命令所需的 P/L 参数。',
  29: '改用 G54–G59 坐标系。',
  30: '把 G53 与 G0/G1 写在同一行。',
  31: '删除该行多余的坐标参数。',
  32: '为圆弧补全平面内坐标，或改用直线段。',
  33: '检查圆弧终点与参数；建议生成 G 代码时把圆弧转为直线段。',
  34: '检查 R 或 IJK 参数；建议把圆弧转为直线段。',
  35: '为圆弧补全 I/J/K 偏移。',
  36: '删除行中多余的词。',
  37: '只对已配置的轴使用 G43.1。',
  38: '使用有效的刀具编号（本机无换刀，可删除 T 指令）。',
}

const ALARM_FIX: Record<number, string> = {
  1: '发送 $X 解锁，手动把笔抬起（Z 向上点动），确认位置后重新设原点再继续。',
  2: '发送 $X 解锁；检查作品是否超出纸张/行程，调整原点或缩小内容。',
  3: '发送 $X 解锁 → 点动 Z 把笔抬离纸面 → 把笔移回原点位置 → 设原点（XYZ） → 从中断行续打。',
  4: '检查探针接线后重试（本机一般不使用探针）。',
  5: '检查探针与工件距离后重试。',
  6: '发送 $X 解锁。本机无限位开关，请关闭归位（$22=0）。',
  7: '关闭安全门后发送 $X 解锁。',
  8: '发送 $X 解锁并增大 $27；本机无限位开关时应关闭归位。',
  9: '发送 $X 解锁并关闭归位（$22=0）：本机没有限位开关，无法自动归位。',
}

const E = (code: number, title: string, hint: string): Omit<GrblCode, 'fix'> => ({ code, title, hint })

export const GRBL_ERRORS: Record<number, GrblCode> = Object.fromEntries(
  [
    E(1, '缺少命令字母', 'G 代码每个词都必须以字母开头，检查是否有多余数字或空格。'),
    E(2, '数值格式错误', '数值缺失或格式不正确（如 X1..2）。'),
    E(3, '无法识别的 $ 系统命令', '$ 命令不受支持或拼写错误，发送 $ 查看帮助。'),
    E(4, '数值不能为负', '该设置或命令要求正值。'),
    E(5, '归位未启用', '$22=0 时不能执行 $H。本机无限位开关，不需要归位。'),
    E(6, '步进脉冲过短', '$0 必须 ≥ 3 微秒。'),
    E(7, 'EEPROM 读取失败', 'EEPROM 数据损坏，已恢复默认值，请检查 $$ 设置。'),
    E(8, '非空闲状态', '$ 命令只能在空闲（Idle）状态下执行，请等待运动结束。'),
    E(9, 'G 代码被锁定', '处于报警或点动状态时禁止 G 代码，先解锁（$X）。'),
    E(10, '软限位需要归位', '启用软限位（$20）前必须先启用归位（$22）。'),
    E(11, '行过长', '单行超过 80 个字符，已被丢弃。'),
    E(12, '步进速率过高', '设置导致步进频率超过 30 kHz，降低步数/毫米或最大速度。'),
    E(13, '安全门打开', '检测到安全门打开。'),
    E(14, '行长度超限', '启动行或构建信息超过 EEPROM 允许长度。'),
    E(15, '点动超出行程', '点动目标超出机器行程（软限位）。'),
    E(16, '点动命令无效', '$J= 命令缺少 = 或包含不允许的 G 代码。'),
    E(17, '激光模式需要 PWM', '激光模式需要支持 PWM 的主轴输出。'),
    E(20, '不支持的 G 代码命令', '包含 GRBL 不支持或无效的 G/M 代码。'),
    E(21, '同一模态组冲突', '一行中出现了同一模态组的多个命令（如 G0 与 G1）。'),
    E(22, '未设置进给速度', '执行 G1/G2/G3 前需要用 F 指定进给速度。'),
    E(23, '需要整数值', '该命令要求整数参数。'),
    E(24, '轴命令冲突', '一行中有多个需要坐标轴的命令。'),
    E(25, '重复的词', '同一行中一个字母出现了多次。'),
    E(26, '缺少轴坐标', '命令需要轴坐标但没有提供。'),
    E(27, '行号无效', 'N 行号超出范围（1–9,999,999）。'),
    E(28, '缺少参数', '命令缺少必需的 P 或 L 值。'),
    E(29, '不支持该坐标系', '不支持 G59.1、G59.2、G59.3。'),
    E(30, 'G53 运动模式错误', 'G53 只能与 G0 或 G1 一起使用。'),
    E(31, '多余的轴坐标', '该命令不使用轴坐标，但行中出现了轴坐标。'),
    E(32, '圆弧缺少平面内坐标', 'G2/G3 圆弧需要所选平面内至少一个轴坐标。'),
    E(33, '运动目标无效', '圆弧或运动目标无效（目标与起点相同或计算出错）。'),
    E(34, '圆弧半径错误', 'G2/G3 半径计算失败，检查 R 或 IJK 参数。'),
    E(35, '圆弧缺少偏移', 'G2/G3 IJK 格式需要所选平面内至少一个偏移。'),
    E(36, '多余的词', '行中有未被任何命令使用的词。'),
    E(37, '刀具长度补偿轴错误', 'G43.1 动态刀具长度补偿只能作用于已配置的轴。'),
    E(38, '刀具编号超限', '刀具编号超过支持的最大值。'),
  ].map((c) => [c.code, { ...c, fix: ERROR_FIX[c.code] ?? '' }]),
)

export const GRBL_ALARMS: Record<number, GrblCode> = Object.fromEntries(
  [
    E(1, '触发硬限位', '运动中触发了限位开关，位置可能已丢失：解锁后请抬笔并重新设原点。'),
    E(2, '超出软限位', '运动目标超出机器行程，未执行。解锁（$X）后可继续。'),
    E(3, '运动中复位，坐标已丢失', '运动中发生软复位（急停或断线），请抬笔并重新设原点。'),
    E(4, '探针初始状态错误', '探测开始前探针已处于触发状态。'),
    E(5, '探针未接触', '探测在行程内未接触到工件。'),
    E(6, '归位失败：复位', '归位过程中发生复位。'),
    E(7, '归位失败：安全门', '归位过程中安全门被打开。'),
    E(8, '归位失败：未能脱离开关', '回退距离不足以离开限位开关，增大 $27。'),
    E(9, '归位失败：未找到开关', '在搜索行程内没有找到限位开关。本机没有限位开关，这通常是因为 $22（归位循环）被打开了。'),
  ].map((c) => [c.code, { ...c, fix: ALARM_FIX[c.code] ?? '' }]),
)

export function grblErrorText(code: number | string | null | undefined): string {
  const n = Number(code)
  return GRBL_ERRORS[n]?.title ?? `未知错误 ${code ?? ''}`.trim()
}
export function grblAlarmText(code: number | string | null | undefined): string {
  const n = Number(code)
  return GRBL_ALARMS[n]?.title ?? `未知报警 ${code ?? ''}`.trim()
}
/** Deep link to the code reference row, e.g. codeHref('error', 20) → '/console?tab=codes&code=error:20'. */
export function grblCodeHref(kind: 'error' | 'alarm', code: number | string): string {
  return `/console?tab=codes&code=${kind === 'alarm' ? 'ALARM' : 'error'}:${code}`
}

/** Explain a firmware reply line such as `error:20` or `ALARM:3`. */
export function explainGrblLine(text: string): ({ kind: 'error' | 'alarm' } & GrblCode) | null {
  const m = /^(error|ALARM):(\d+)/i.exec(text.trim())
  if (!m) return null
  const code = Number(m[2])
  const alarm = m[1].toUpperCase() === 'ALARM'
  const c = (alarm ? GRBL_ALARMS : GRBL_ERRORS)[code] ?? { code, title: alarm ? grblAlarmText(code) : grblErrorText(code), hint: '', fix: '' }
  return { kind: alarm ? 'alarm' : 'error', ...c }
}

export type GrblSettingType = 'bool' | 'mask' | 'int' | 'float'

export interface GrblSettingMeta {
  name: string
  unit: string
  type: GrblSettingType
  desc: string
  /** Settings that are risky to change on this machine (steps/mm, travel…). */
  caution?: string
}

const S = (name: string, unit: string, type: GrblSettingType, desc: string, caution?: string): GrblSettingMeta => ({ name, unit, type, desc, caution })
const AXES = ['X', 'Y', 'Z'] as const

export const GRBL_SETTINGS_META: Record<number, GrblSettingMeta> = {
  0: S('步进脉冲宽度', 'µs', 'int', '每个步进脉冲的持续时间，≥ 3 µs。'),
  1: S('步进空闲延时', 'ms', 'int', '运动结束后电机保持使能的时间；255 = 一直锁定。'),
  2: S('步进脉冲反相', '掩码', 'mask', '按位反相步进信号（bit0 X、bit1 Y、bit2 Z）。'),
  3: S('方向反相', '掩码', 'mask', '按位反相方向信号（bit0 X、bit1 Y、bit2 Z），用于修正轴向。', '改动后点动方向会反转，请确认后再打印。'),
  4: S('使能引脚反相', '布尔', 'bool', '反相步进使能信号。'),
  5: S('限位引脚反相', '布尔', 'bool', '反相限位开关输入（常闭开关时启用）。'),
  6: S('探针引脚反相', '布尔', 'bool', '反相探针输入。'),
  10: S('状态报告内容', '掩码', 'mask', 'bit0 = 报告 MPos（否则 WPos），bit1 = 报告缓冲区状态。'),
  11: S('拐角偏差', 'mm', 'float', '拐角处的速度规划容差，越大拐角越快。'),
  12: S('圆弧精度', 'mm', 'float', 'G2/G3 圆弧拆分为线段的误差。'),
  13: S('以英寸报告', '布尔', 'bool', '位置报告使用英寸。'),
  20: S('软限位', '布尔', 'bool', '根据最大行程（$130–$132）拒绝越界运动，需要归位。'),
  21: S('硬限位', '布尔', 'bool', '启用限位开关触发即停止。本机无限位开关。'),
  22: S('归位循环', '布尔', 'bool', '启用 $H 归位。本机无限位开关，应保持关闭。'),
  23: S('归位方向反相', '掩码', 'mask', '按位设置各轴归位方向。'),
  24: S('归位定位速度', 'mm/min', 'float', '找到开关后的慢速定位速度。'),
  25: S('归位搜索速度', 'mm/min', 'float', '寻找限位开关时的速度。'),
  26: S('归位去抖延时', 'ms', 'int', '限位开关去抖时间。'),
  27: S('归位回退距离', 'mm', 'float', '归位后离开开关的距离。'),
  30: S('主轴最高转速', 'RPM', 'float', 'PWM 最大值对应的转速（标准 GRBL 中不是舵机参数）。', '标准 GRBL 1.1 的 $30/$31 是主轴转速上下限，不是抬落笔参数。'),
  31: S('主轴最低转速', 'RPM', 'float', 'PWM 最小值对应的转速。', '标准 GRBL 1.1 的 $30/$31 是主轴转速上下限，不是抬落笔参数。'),
  32: S('激光模式', '布尔', 'bool', '启用后 G1/G2/G3 运动不会因主轴变化而停顿。'),
  ...Object.fromEntries(AXES.map((a, i) => [100 + i, S(`${a} 轴步数`, 'step/mm', 'float', `${a} 轴每毫米步数。`, '改动会改变实际尺寸，务必实测校准。')])),
  ...Object.fromEntries(AXES.map((a, i) => [110 + i, S(`${a} 轴最大速率`, 'mm/min', 'float', `${a} 轴最大速度（G0 快移速度）。`)])),
  ...Object.fromEntries(AXES.map((a, i) => [120 + i, S(`${a} 轴加速度`, 'mm/s²', 'float', `${a} 轴加速度，过大会丢步。`)])),
  ...Object.fromEntries(AXES.map((a, i) => [130 + i, S(`${a} 轴最大行程`, 'mm', 'float', `${a} 轴行程，用于软限位。`)])),
}

export function grblSettingMeta(n: number): GrblSettingMeta {
  return GRBL_SETTINGS_META[n] ?? { name: `设置 $${n}`, unit: '', type: 'float', desc: '' }
}

/** Settings that must stay off on this machine (no limit switches). */
export const NO_LIMIT_SWITCH_SETTINGS = [20, 21, 22] as const
const NO_LIMIT_TEXT = '本机没有限位开关，打开后控制板会进入报警。'

export interface GrblRisk {
  level: 'danger' | 'caution'
  text: string
}

/**
 * Risk of changing `$n` from `from` to `to` on this machine (Z-stepper pen, no homing / limit switches).
 * `danger` writes need an explicit typed confirmation.
 */
export function grblChangeRisk(n: number, from: string | null, to: string): GrblRisk | null {
  const on = (v: string | null) => v != null && Number(v) !== 0
  if ((NO_LIMIT_SWITCH_SETTINGS as readonly number[]).includes(n)) {
    if (on(to) && !on(from)) return { level: 'danger', text: NO_LIMIT_TEXT }
    if (on(to)) return { level: 'danger', text: '本机没有限位开关，这一项应保持关闭（0）。' }
    return null
  }
  if (n >= 23 && n <= 27) return { level: 'caution', text: '归位相关参数。本机没有限位开关，通常不需要修改。' }
  if (n >= 100 && n <= 102) return { level: 'caution', text: '步数/毫米改动会改变实际书写尺寸，改完请画 10 mm 方块实测。' }
  if (n >= 110 && n <= 112) return { level: 'caution', text: '最大速率过高会导致电机丢步，写出的字会错位。' }
  if (n >= 120 && n <= 122) return { level: 'caution', text: '加速度过高会导致丢步。' }
  if (n >= 130 && n <= 132) return { level: 'caution', text: '最大行程只在软限位开启时生效；本机行程请在 设置 › 机器配置 里填写。' }
  if (n === 3) return { level: 'caution', text: '方向反相改动后点动方向会反转，请先点动确认方向。' }
  return null
}
