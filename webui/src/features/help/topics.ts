/**
 * Contextual-help topics for <HelpLink topic="…" />. Each topic = short popover text + the article
 * section with the full explanation. Ids are English; the Chinese term works as an alias
 * (`<HelpLink topic="原点" />` = `<HelpLink topic="origin" />`).
 */
export interface HelpTopic {
  id: string
  title: string
  /** 1–3 short sentences, plain language. */
  short: string
  /** Article id + optional section anchor → /help/<article>#<anchor> */
  article: string
  anchor?: string
  aliases?: string[]
}

export const HELP_TOPICS: HelpTopic[] = [
  { id: 'origin', title: '原点', aliases: ['原点', '设零', 'zero', 'set-zero'], article: 'glossary', anchor: 'origin',
    short: '开始写字时笔所在的位置就是原点，默认对应要写内容的左上角（不是纸角）。断电、复位或报警后原点会失效，需要把笔移回起笔点重新设置。' },
  { id: 'frame', title: '走边框', aliases: ['走边框', '边框', 'framing'], article: 'glossary', anchor: 'frame',
    short: '笔抬着沿内容外框走一圈，不会落笔。用来确认内容落在纸上的位置，避免写出纸外。' },
  { id: 'pen', title: '抬笔 / 落笔', aliases: ['抬笔', '落笔', 'pen-up', 'pen-down', 'pen_down_z', 'pen_up_z', '笔压', '落笔高度'], article: 'glossary', anchor: 'pen',
    short: 'Z0 是抬笔（停放）位置，Z 越大笔压得越深，默认 Z8 落笔。落笔高度调到笔尖刚好碰到纸再多一点点。' },
  { id: 'gcode', title: 'G 代码', aliases: ['G代码', 'G 代码', 'g-code'], article: 'glossary', anchor: 'gcode',
    short: '写字机能听懂的指令，一行一条，例如 G1 X10 Y-5 表示直线移动到 (10, -5)。软件会自动生成，一般不用手写。' },
  { id: 'travel', title: '行程 / 工作区', aliases: ['行程', '工作区', 'work-area', 'workarea'], article: 'glossary', anchor: 'travel',
    short: '笔能到达的最大范围。本机没有回零开关，默认不设置行程、不检查行程，只检查内容是否在纸内。' },
  { id: 'jitter', title: '抖动', aliases: ['抖动', '随机', '仿手写'], article: 'glossary', anchor: 'jitter',
    short: '给每个字加一点随机的错位、旋转和大小变化，看起来更像手写。2–5% 最自然。' },
  { id: 'seed', title: '种子', aliases: ['种子', '随机种子'], article: 'glossary', anchor: 'seed',
    short: '抖动用的随机编号。同一个种子每次写出来都一样，换一个种子就换一种随机效果。' },
  { id: 'single-line-font', title: '单线字体', aliases: ['单线字体', '单线', 'gfont', 'psf'], article: 'glossary', anchor: 'single-line-font',
    short: '每一笔是一条线的字体（.gfont / .psf），笔尖照着写一遍即可。普通 TTF 是空心轮廓，描出来会是双线。' },
  { id: 'missing-glyph', title: '缺字', aliases: ['缺字', '方框', 'missing'], article: 'fonts', anchor: 'missing',
    short: '字体里没有的字会被写成方框。可以换字体、加第二种字体补字，或改用常用字。' },
  { id: 'font-size', title: '字号', aliases: ['字号', '字高', 'size_mm'], article: 'fonts', anchor: 'size',
    short: '字号按毫米设置。不同字体的字面大小不同，同样 10 mm 有的写出来只有 5 mm 高，以预览为准。' },
  { id: 'paper', title: '纸张', aliases: ['纸张', '纸', '纸张尺寸'], article: 'paper', anchor: 'size',
    short: '纸张决定页面大小和边距。宽高按竖放填写，横着放的纸选「横向」。' },
  { id: 'offset', title: '位置偏移', aliases: ['偏移', '写歪', '错位'], article: 'paper', anchor: 'offset',
    short: '整体偏移多半是原点没对准纸角；越写越偏是丢步，降低速度并检查皮带。' },
  { id: 'variables', title: '变量', aliases: ['变量', '{{}}', '占位符'], article: 'batch', anchor: 'how',
    short: '在文字里写 {{name}} 这样的占位符，批量打印时用表格每一行的值替换。' },
  { id: 'batch', title: '批量', aliases: ['批量', '批量打印', '邮件合并'], article: 'batch', anchor: 'steps',
    short: '上传一张表格（第一行是列名），每一行生成一个任务。默认写完一张暂停，换好纸再继续。' },
  { id: 'flow-text', title: '流式文字', aliases: ['流式', '流式文字', 'flow_text', '自动换页'], article: 'batch',
    short: '长文按纸张的行线自动换行，写满一页自动新建下一页，适合写信。' },
  { id: 'image-trace', title: '图片描线', aliases: ['描线', '描摹', 'trace'], article: 'image-trace', anchor: 'modes',
    short: '把图片变成笔能画的线：边缘适合照片，骨架适合线稿和签名，点阵表现明暗但很慢。' },
  { id: 'lease', title: '控制权', aliases: ['控制权', '占用', 'lease'], article: 'multi-user', anchor: 'lease',
    short: '同一时刻只有一个人能操纵机器。用完请释放；急停对所有人都有效。' },
  { id: 'estop', title: '急停', aliases: ['急停', 'e-stop', 'emergency'], article: 'safety', anchor: 'estop',
    short: '立刻停止一切运动（Ctrl/⌘ + .）。急停后原点失效，需要重新设原点。网络不稳时直接关电源同样安全。' },
  { id: 'alarm', title: '报警（ALARM）', aliases: ['报警', 'ALARM', '解锁'], article: 'troubleshooting', anchor: 'alarm',
    short: '报警时机器锁住。处理原因后点「解锁」，然后重新设原点。' },
  { id: 'gcode-error', title: '错误码（error:N）', aliases: ['错误码', 'error'], article: 'troubleshooting', anchor: 'error',
    short: '某一行 G 代码被机器拒绝。软件生成的代码一般不会出现，自己写的代码多为 error:20 / 22 / 33。' },
  { id: 'feed-rate', title: '书写速度', aliases: ['速度', '进给', 'feed', 'feed_rate'], article: 'paper', anchor: 'offset',
    short: '笔落下时移动的速度（mm/分钟）。太快容易丢步、线条发抖，写小字时调慢一些。' },
  { id: 'optimize', title: '优化路径', aliases: ['优化', '路径优化', 'optimize'], article: 'glossary', anchor: 'gcode',
    short: '重新排列笔画顺序，减少空走的距离，通常能省下 20–40% 的时间。笔画顺序会和手写不同。' },
  { id: 'api-token', title: 'API 令牌', aliases: ['令牌', 'token', 'API'], article: 'api', anchor: 'token',
    short: '给脚本用的钥匙，等同于密码。按需选择 read / control / admin 权限，不用了就吊销。' },
  { id: 'teletype', title: '电传打字机', aliases: ['电传', 'teletype'], article: 'teletype',
    short: '附带的演示程序：键盘敲一个字纸上写一个字。它和工作台不能同时占用串口。' },
  { id: 'disconnect', title: '断线', aliases: ['断线', '串口断开', 'serial_lost'], article: 'troubleshooting', anchor: 'serial-lost',
    short: '写到一半串口断开后原点失效。重连、重设原点后可以从断点继续。' },
  { id: 'wifi', title: 'WiFi 断开', aliases: ['WiFi', '网络', '断网'], article: 'troubleshooting', anchor: 'wifi',
    short: '浏览器断网不影响正在写的任务，它在控制盒上运行。恢复后网页会自动同步。' },
]

const byKey = new Map<string, HelpTopic>()
for (const t of HELP_TOPICS) {
  byKey.set(t.id.toLowerCase(), t)
  for (const a of t.aliases ?? []) byKey.set(a.toLowerCase(), t)
}

export function findTopic(topic: string): HelpTopic | undefined {
  return byKey.get(topic.trim().toLowerCase())
}

export function topicHref(t: Pick<HelpTopic, 'article' | 'anchor'>) {
  return `/help/${t.article}${t.anchor ? `#${t.anchor}` : ''}`
}
