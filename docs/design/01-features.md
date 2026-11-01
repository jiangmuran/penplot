# 01 — Web 工作台功能清单（Feature Inventory）

> 范围：给 `penplot/` 包配一个 Web UI「工作台」。本文只定**功能**，不写实现。
> 目标硬件：Orange Pi Zero 3（2 GB，WiFi）+ USB 串口 GRBL 1.1f 写字机；Z 步进笔
> （Z0 抬笔＝静止位，Z+8 落笔），**无回零/限位**，原点＝开工时的笔位置。UI 语言：中文。
> 配置基线：`configs/grbl-zpen.json`。

**优先级**：P0 v1 必须 · P1 v1.x · P2 以后。**实现**：已有函数/类，`NEW` 是要新写的，
`FIX` 是核心有缺陷、UI 用之前要先修。函数名省略 `penplot.` 前缀。

---

## 0. 核心数据模型（NEW，P0）

现在核心里只有 `TextDocument`（一篇流式文本 → 页 → 行 → 字），**没有画布/元素模型**，
也没有工程文件。自由排版、模板、批量、历史都要靠下面这个模型。

```
Project { id, name, version, created/updated, machineProfileId, jobOverrides{},
          variables[] (模板占位符定义), pages[] , assets[] (引用库里的文件 id) }
Page    { id, paper{ w,h (mm), margins{l,r,t,b}, orientation, presetId },
          origin{ mode: penStart|corner|offset, corner: LU|RU|LD|RD, offX,offY },
          elements[] (按 z 序), guides[] }
Element { id, type, name, locked, hidden, z,
          transform{ x,y (mm, 页面左上), rotation°, scaleX,scaleY, anchor },
          bounds (派生，缓存), penOverride?{feed, zOn}, params{...按类型} }
  type = flowText   params{ text, fontId | fontMix[{fontId,w}], textSize, charSpace,
                            lineNum | lineHeightMm, align L|C|R|D, paragraph{spe_type,spe_value,left,right},
                            jitter(FontsSet 全字段), seed, simplify, box{w,h} }
       | textBox    同上，但单个框、不分页、溢出截断/警告
       | image      params{ assetId, mode edge|skeleton|dots|stipple, widthMm, 各模式参数 }
       | svg        params{ assetId, strokesOnly, flattenTol }
       | dxf        params{ assetId, layerFilter[] }
       | gcode      params{ assetId }   (导入的 G 代码作为一组折线，只能平移/缩放/旋转)
       | shape      params{ kind rect|ellipse|line|polyline|grid(田/米字格)|ruled, ... }
Render cache: Element → polylines (mm, 页面坐标) + hash(params) ；Page → 排序后的 toolpath
Job     { id, projectId|fileId, pageIdx, gcodeHash, profileSnapshot, overrides, copies,
          state, startedAt, endedAt, linesTotal/acked, errors[], alarm, durationS }
MachineProfile = MachineConfig.save() JSON + 新增字段{ workArea{w,h}, name, port, baud, safeZ }
```

关键规则：
- **一次布局、多次渲染**：`TextDocument.entities()` 每次都会重新跑一遍 `layout()`，同时消耗 RNG，
  所以开了抖动以后，预览和导出的分页、换行结果会不一样（实测：同一 seed 两次 layout，各页字数分别是
  475/479/6 和 474/480/6）。模型必须存「布局结果」，或者每次渲染前都用 `seed` 重建
  RNG（见 §18 B1）。
- 坐标链：元素局部 → 页面 mm（y 向下）→ `export_transform`（页旋转、Y 翻转、axes、象限）→
  `GcodeBuilder`（`Settings.rotate`）→ 机器 mm。UI 预览要能显示**两套坐标**：纸面和机器。

---

## 1. 字体

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| F1 | 字体列表（名称、格式、字形数、size、文件大小） | `psf.font_index`、`GFont.load(load_zip=False)` | P0 | gfont 头部 name 多为发行渠道名，不能拿来当显示名。显示名从文件名 `名称_渠道_别名` 解析，见 F2 |
| F2 | 显示名修复（乱码） | NEW | P0 | 10 个文件名是 GBK 被当成 Latin-1 解码的乱码（如 `ÐÜ×Ð.gfont`→`熊仔`），用 `encode('latin1').decode('gbk')` 修复；修复后会和已有的 `熊仔.gfont` 重名，所以 ID 用内容 hash，不用文件名 |
| F3 | 按名称/别名/拼音搜索、标签、收藏 | NEW | P0 搜索 / P1 标签收藏 | — |
| F4 | 字形覆盖检查：输入文本 → 每个字体的缺字列表，按覆盖率排序 | `has_glyph`（gfont 只读 ZIP 目录） | P0 | 实测 84 个字体全部载入要 1.5 s、RSS 580 MB（x86），**2 GB 板子上不能常驻全部**。做法：启动时生成码位集合索引（JSON 缓存，按文件 mtime 失效），字体用 LRU 缓存（约 8 个） |
| F5 | 样张预览（自定义样句 + 字表网格浏览全部字形） | `font.glyph` → 折线 JSON | P0 样句 / P1 网格 | 缩略图预渲染成 SVG 缓存；网格浏览要分页（7k 字） |
| F6 | 排版里缺字的处理：高亮缺字 + 一键换成覆盖率最高的字体或加入混排 | NEW（`_pick_font` 已有自动替换） | P0 | 单字体模式下缺字会**静默**画成方框或空格（见 `_char_path`，非空格字符画 rect），必须提示 |
| F7 | 上传 .gfont/.psf | `load_font` 校验 | P0 | 校验版本 ≤5、ZIP 能打开；大小上限约 20 MB；多用户时注意版权，不对外分享 |
| F8 | 上传 .ttf/.otf/.ttc → 单线字转换任务（skeleton/outline、size-px、face、simplify、字符集：快速 500 / GB2312 全 / 自定义 / 「仅当前文本」） | `ttffont.convert_ttf` | P1 | 核心**没有进度回调**，结果打印到 stderr，也不能取消，需 FIX。全 GB2312 在 ARM 上要几十分钟、内存很高，必须后台独立进程跑、单并发，必要时降 nice。依赖 PIL+fontTools+scikit-image |
| F9 | 「只转当前文本用到的字」临时字体 | `convert_ttf(chars=…)` | P1 | 几秒出结果，最实用 |
| F10 | makemeahanzi graphics.txt → psf | `mmah.convert_mmah` | P2 | 数据 30 MB，需用户自己上传 |
| F11 | 格式互转下载（gfont↔psf）、导出内置字体 | `psf.convert_font`、`load_builtin`、`write_psf` | P1 | — |
| F12 | 混排权重编辑器（多字体 + 权重滑块 + 预览） | `TextDocument(font_mix=…)` | P0 | 权重 ≤0 的字体被忽略；CLI 按前缀匹配名字有歧义，UI 一律用 ID |
| F13 | 字体详情：size、作者字段、zip_skipped（损坏字形数） | `GFont.zip_skipped` | P2 | 懒加载时只有访问到才计数 |
| F14 | 删除/重命名/禁用字体 | NEW | P1 | 正在被工程引用的字体禁止删除 |

## 2. 页面 / 纸张 / 方向

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| P1 | 预设：A4/A3/16开 × 普通/窄/适中/宽边距 | `layout.page_presets` | P0 | 预设尺寸是 209×296（不是 210×297），这是照搬原软件，UI 要标注 |
| P2 | 任意自定义尺寸（宽×高 mm），四边距独立设置 | `PageInfo(**kw)` | P0 | — |
| P3 | 保存自定义纸张预设（信封 DL/C5/C6、明信片、贺卡、笔记本内页、「A4 略小」…）；内置一批常用预设 | NEW（存 JSON） | P0 | — |
| P4 | 方向：纵/横；页面旋转 0/90/180/270 | `PageInfo.rotation`、`export_transform` | P0 | 机器级的 `Settings.rotate` 是另一个参数，在 `GcodeBuilder.move` 里才生效，两个会叠加；UI 要分开命名为「页面旋转」和「机器安装角」 |
| P5 | 每页行数 / 行高 mm 换算显示（行高 = (H−上−下)/行数） | `PageInfo.lineNum` | P0 | 只能填行数；UI 双向换算 |
| P6 | 纸张与机器行程的叠加显示（纸放在哪里） | NEW（profile.workArea） | P0 | `MachineConfig` 里没有行程字段，要新增 |
| P7 | 横线/方格/田字格背景（只显示，或真的画出来） | NEW（原软件 Note/GridTab） | P2 | — |
| P8 | 未使用的 PageInfo 字段（`fontSize`、`lineGap`、`lineGapOffset`、`baseLine`、`fontPath`、`fontChance`、`space`* ） | — | — | 前几个在 layout 里**完全没用到**，UI 不要暴露。*`space` 是字间距系数，有用 |

## 3. 文本排版（流式文本元素）

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| T1 | 文本输入（多行、`\f` 强制换页按钮）、上传 .txt/.md（md 去掉标记取纯文本） | `TextDocument.layout` | P0 txt / P1 md | CLI 只接受参数里的文本 |
| T2 | 字号系数 textSize、字间距 charSpace(mm)、字距系数 space | `text_size`、`char_space`、`PageInfo.space` | P0 | — |
| T3 | 对齐：左/中/右/分散 | `LineAlign`、`entities(align=)` | P0 | 现在是整篇统一对齐，不支持逐段 |
| T4 | 段落格式：首行缩进 / 悬挂缩进、左右缩进(mm) | `ParagraphFormat` | P0 | CLI 没暴露；也只能整篇统一 |
| T5 | 手写抖动：randomFontSize/Space/Rotate/XScale/YScale 区间、randomY、randomFirstPos、baseLine、特殊字符 widthAdd、space/tabWidthAdd | `FontsSet` | P0 常用 4 项 / P1 全部 | CLI 一项都没暴露。提供「工整/自然/潦草」三档预设。`spaceWidthAdd`、`tabWidthAdd` 单位是 px，不是 mm，UI 要换算 |
| T6 | 随机种子：固定、重新抽取、记录到工程 | `rng=random.Random(seed)` | P0 | 不同 seed 出来的效果不同，用户会想「换一种写法」 |
| T7 | 多页：页导航、每页一个文件或合成一个任务（换纸暂停） | `entities(page_index=)`；CLI 一页一个文件 | P0 | 合成任务需要 NEW「换纸」暂停点（M0 或 Sender 暂停） |
| T8 | 笔画排序：写字默认不排序（照搬原软件，蛇形行序）/ 贪心优化开关 | `generate_gcode(optimize=)` | P0 | — |
| T9 | RDP 简化 simple(px) | `FontsSet.simple` | P1 | — |
| T10 | 行首禁则（标点不出现在行首） | `_NO_LINE_START` | 内置 | 超宽单字会单独成一行（有意和原软件不同） |
| T11 | 逐字/逐段样式（不同字体、字号） | NEW（原设计文件的 items[] 是逐字的） | P2 | 自由画布里用多个文本框代替 |
| T12 | 读取原软件设计文件 .json | NEW（AUDIT P3） | P2 | — |

## 4. 自由排版画布（NEW）

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| C1 | 一页放多个元素：文本框、图片、SVG、DXF、G 代码、形状 | NEW 元素模型（§0） | P0 文本框+图片+SVG+G码 / P1 DXF+形状 | 核心只有单个流式文本，需要新写 `render_element()` → mm 折线 |
| C2 | 拖动、缩放、旋转手柄；数值输入 x/y/w/h/角度 | NEW 前端 + `Affine2D` | P0 | 文本框缩放时，是改字号还是做几何缩放，要说清楚（建议改字号） |
| C3 | z 序、锁定、隐藏、复制、成组 | NEW | P0 前三项 / P1 成组 | 笔绘不存在遮挡，z 序只影响**绘制顺序** |
| C4 | 对齐/分布、吸附（页边、边距、元素边缘、中心线）、标尺、网格 | NEW | P1 吸附 / P0 基础对齐 | — |
| C5 | 绘制顺序：按 z 序 / 全局贪心优化 / 每个元素内部各自设置 | `optimize_paths` | P0 | 全局优化会把不同元素的笔画交错，换笔、多色时不能用 |
| C6 | 每个元素单独设置笔参数（落笔深度、速度）→ 分段 G 代码 | NEW（GcodeBuilder 只有全局参数） | P2 | — |
| C7 | 元素越界提示（超出纸面、超出边距、超出机器行程） | NEW | P0 | — |
| C8 | 「流式模式」和「自由模式」切换：流式文本就是一个铺满版心的 flowText 元素 | NEW | P0 | — |
| C9 | 撤销/重做 | NEW | P0 | 只在前端做 |

## 5. 图片 → 路径

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| I1 | 上传 PNG/JPG/WebP/BMP；缩放上限 max-px；反相 | `image.load_gray(invert,max_px)` | P0 | 缩放用最近邻（`_resize_nn`），有锯齿。WebP 依赖 PIL/cv2 的编译选项 |
| I2 | 描边 edge：blur σ、低/高阈值、min-len、simplify | `canny`、`mask_to_paths` | P0 | 纯 numpy 加 Python 循环追踪轮廓，2000 px 图在 ARM 上可能要几十秒。要后台跑、出进度，预览先用低分辨率 |
| I3 | 骨架 skeleton：binarize、min-len、simplify | CLI 用的是 `zhang_suen` + `skeleton_to_paths` | P0 | FIX：CLI 没用更好的 `image.thin()`（skimage）和 `strokes.skeleton_strokes`（接笔、去毛刺、定向），UI 应该用后两者 |
| I4 | 点阵 dots：spacing、gamma、功率调制、驻留 | `halftone_dots`、`laser_dots_gcode` | P2（本机是笔） | 只能给激光用：Z 笔机器上 M3/S 没有任何效果。笔机器要用 I5 |
| I5 | 笔点画（stipple：每点落笔一下）/ 排线（hatch）/ 螺旋线 / 蛇形扫描 | NEW | P1 | — |
| I6 | 宽度 mm、在页面上的位置（作为画布元素） | `paths_to_mm` 只做缩放 | P0 | 图片原点固定在左上(0,0)，平移要靠 §0 的 transform |
| I7 | 参数实时预览（原图 / 边缘图 / 路径三视图叠加） | NEW | P0 | 后台出低分辨率草稿，确认后再出全分辨率 |
| I8 | 位图 → potrace 矢量（原 LinesTab） | NEW | P2 | — |

## 6. 矢量导入

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| V1 | SVG 导入：path/line/polyline/polygon/rect/circle/ellipse、transform、viewBox 单位 → mm；填充忽略，只画描边 | NEW（`geometry` 已有 `cubic_bezier`/`quad_bezier`/`arc_to_beziers`） | P0 | 现在完全没有（AUDIT P3）。`<text>`、`<use>`、CSS 类、mask 暂不支持，要明确提示；px→mm 默认 96 dpi |
| V2 | DXF 导入（LINE/LWPOLYLINE/ARC/CIRCLE/SPLINE，按图层过滤） | NEW（ezdxf） | P1 | 新依赖；单位用 $INSUNITS |
| V3 | G 代码导入为元素或直接作为任务 | `gcode.parse_gcode` | P0 | **FIX，严重**：不认 Z 轴笔。本机生成的 G 代码（`G1G90 Z8.0`）导回来是 **0 条路径**（实测）。另外不支持 G91 相对坐标、G20 英制、G2/G3 圆弧（被当成直线），也不输出空走 |
| V4 | HPGL/PLT 导入 | NEW | P2 | — |

## 7. 原点、坐标系、定位

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| O1 | 原点模式：①开工时笔位置＝原点（默认，`autoSetZero`）②沿用固件已有 G54 偏移 ③指定偏移 offsetX/Y | `Settings.autoSetZero`、`GrblController.set_zero`（`G10 P0 L20 X{offX}Y{offY}Z0`） | P0 | `set_zero` 会**同时把 Z 设为 0**：如果此时笔是落下的，Z0 就变成了落笔位，之后 Z+8 会再往下压 8 mm（扎纸、撞笔）。设零前必须强制抬笔，或改成只设 XY（FIX） |
| O2 | 原点角：左上/右上/左下/右下；轴交换 revxy；X/Y 反向 | `AxesSettings`、`export_transform` | P0 | 画布上用图标标出原点和 +X/+Y 方向。EBB 会强制变换（UI 置灰） |
| O3 | 每个任务单独选原点：页面上的哪一点对准笔的起始位置（纸面左上、版心左上、内容包围盒左上、中心） | NEW（`export_transform(origin=)` 有参数但 CLI 没用） | P0 | 默认取纸面左上，和原软件一致 |
| O4 | 走边框（Frame）：抬笔沿内容包围盒走一圈；可选「落笔轻点四角」 | NEW | P0 | 没有限位，这是唯一的上机前确认手段。走完回到原点 |
| O5 | 机器坐标/纸面坐标切换显示；实时笔位置叠加在预览上 | NEW | P0 | 依赖 M3 的 WPos 修复 |
| O6 | 软限位：profile.workArea 相对原点的包围检查，阻止越界任务或点动 | NEW | P0 | GRBL 的 `$20` 软限位需要先回零，本机用不了，只能在软件里做 |
| O7 | 越界检查要按真实坐标链做 | `cli._warn_bounds` | P0 | FIX：只假设 pos=0（X∈[0,W]、Y∈[−H,0]），也没算 `Settings.rotate`；多页导出时根本没调用 |

## 8. G 代码生成与打印参数

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| G1 | 生成 G 代码：GRBL/Marlin/EBB/K_AT | `generate_gcode`、`*Writer` | P0（GRBL）/ P2 其他 | 头部有一行空行（startGcode 为空时）和重复的抬笔，无害 |
| G2 | 本次任务可覆盖的参数：feed、jog、Z 落/抬/速度、落笔/抬笔延时、nearDst、优化开关、简化、份数 | `MachineConfig` 字段 | P0 | 机器参数分三层：机器 profile → 工程默认 → 本次任务覆盖。UI 要显示每个值来自哪一层，并可「恢复默认」 |
| G3 | start/end G 代码、宏 1-3 | `AdvancedSettings` | P1 | 宏现在没有任何执行入口（NEW） |
| G4 | 份数 copies（重复 N 次，每份之间换纸暂停） | NEW | P1 | — |
| G5 | 下载 .gcode；查看 G 代码文本（虚拟滚动） | — | P0 | 一页文字约 1.8 万行 |
| G6 | 上传 .gcode/.nc/.gco 直接打印 | `Sender.load_gcode_text` | P0 | 上传前先过 V3 预览和越界检查；含 `$`、`M2/M30`、G28 等命令时警告 |
| G7 | dry-run 统计（不生成文件） | `preview.stats` + NEW | P0 | 见 §9 |
| G8 | Marlin SD 卡上传/打印 | `Sender.load_sd_upload`、`MarlinController.sd_*` | P2 | 本机不用 |

## 9. 预览与统计

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| R1 | 页面预览：纸张、边距、版心、行线；矢量缩放/平移 | NEW（JSON 折线 + 前端 Canvas/SVG）；`preview.paths_to_svg` 只能作导出 | P0 | 前端渲染；后端只发折线（Float32 编码，约 10 万点/页） |
| R2 | 空走（抬笔移动）显示开关、颜色区分 | NEW | P0 | 要从**排序后的 toolpath** 生成，不能用元素 |
| R3 | 笔顺动画（播放/拖动进度条/调速），起点标记 | NEW | P1 | — |
| R4 | 统计：绘制长度、空走长度、抬笔次数、G 代码行数、预计时间 | `preview.stats`（只有前三项） | P0 | FIX：`stats()` 是对**排序前**的元素算的，和实际 G 代码不一致。预计时间要 NEW 模拟器：feed/jog/zSpeed/延时 + 加速度修正（读 `$120-$122`），再用历史任务的实际耗时回归校准 |
| R5 | 越界/缺字/空页警告汇总条 | NEW | P0 | — |
| R6 | 导出 SVG / PNG / PDF 预览 | `paths_to_svg`、`paths_to_png`（matplotlib） | P0 SVG / P1 PNG,PDF | matplotlib 在 ARM 上很重；PNG/PDF 改为前端导出或用 cairosvg |
| R7 | G 代码 ↔ 预览联动（点击一条笔画，跳到对应 G 代码行） | NEW | P2 | — |
| R8 | 打印中的实时叠加：已画部分变色 + 当前笔位置 | NEW | P0 | 依赖 M3、J3 |

## 10. 机器连接与手动控制

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| M1 | 串口列表（/dev/ttyUSB*、ttyACM*、by-id）、波特率、连接/断开、自动连接 | `make_controller`、`MachineController.open` | P0 | 打开串口会发 0x18 软复位，CH340 的 DTR 还会让板子重启。所以**后端守护进程必须独占串口**，网页刷新或断开都不能动串口；同时阻止 CLI 并发使用（加锁文件） |
| M2 | 固件横幅/版本、连接状态 | `firmware_version` | P0 | — |
| M3 | 实时状态：Idle/Run/Hold/Alarm/Jog/Door、位置(WPos)、进给率、缓冲 | `GrblController._dispatch`、`start_status_polling` | P0 | FIX：只解析 MPos/WPos，**不处理 WCO**。GRBL 默认 `$10=1` 报的是 MPos，设零以后显示的位置是错的。不解析 Bf/FS/Ov/Pn；Hold/Door/Check 没有中文映射；`updateStatus=false`（zpen 配置）时完全不轮询。后端应固定 4-5 Hz 轮询 |
| M4 | 断线检测、自动重连提示 | NEW | P0 | FIX：rx 线程遇异常就静默退出，`connected` 仍为 True，Sender 会永久等待 |
| M5 | 点动 XY（步长 0.1/1/10/50 mm、连续按住）、键盘方向键 | `GrblController.jog`（`$J=`） | P0 | 按住连续点动需要 NEW 的 jog cancel（0x85）；点动受 O6 软限位约束 |
| M6 | Z 点动 / 抬笔 / 落笔 / 当前 Z 显示；Z 落笔深度校准向导（从 0 每次 0.5 mm 下探，确认后写回 zOn） | `set_pen`、`jog(dz=)`、`AdvancedSettings.zJogStep` | P0 | 向导里要用户确认「笔尖刚接触纸」。Z 速度 5000 对步进电机可能太快而丢步 |
| M7 | 设零（XY / XYZ）、回原点（抬笔 → G0 X0Y0） | `set_zero`、`go_home` | P0 | 见 O1。`go_home` **不先抬笔**，FIX：UI 先发抬笔 |
| M8 | 解锁 `$X`、软复位、休眠 `$SLP` | `unlock`、`sleep`；软复位 NEW | P0 | `$H` 在本机无效（无限位），隐藏或置灰 |
| M9 | 电机释放/锁定（`$1=255` 或 `$SLP`） | NEW | P2 | — |
| M10 | 宏按钮（macro1-3） | NEW | P1 | — |

## 11. 任务执行

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| J1 | 开始（检查清单：已连接、Idle、笔已抬起、越界 OK、已走边框） | `Sender.load_gcode_text`/`start`、`cmd_print` 流程 | P0 | Alarm 状态禁止开始 |
| J2 | 暂停/继续：①软暂停（缓冲里的动作画完 → 抬笔）②立即保持（`!` feed hold）+ `~` 继续 | `Sender.pause/resume`；实时命令 NEW | P0 | 软暂停要等 RX 100 B 加 GRBL 规划缓冲（约 15 段）画完才停，延迟可能好几秒。`!` 停在落笔状态会洇墨，而且 Hold 状态下 GRBL 不能抬 Z |
| J3 | 进度：已确认行/总行、百分比、预计剩余时间、当前行文本、已用时间 | `Sender.progress()`（按**已发送**计数） | P0 | FIX：进度会比实际超前一个缓冲；要改成按 ack 计数。剩余时间用 R4 模拟器按行累计时间来算 |
| J4 | 停止（排空队列 → 抬笔 → 回原点） | `Sender.stop` | P0 | 已缓冲的动作仍会执行完，不是立即停止 |
| J5 | 急停（E-stop）：`!` → 等 Hold → 0x18 复位 → `$X` → 抬笔 | NEW | P0 | GRBL 运动中软复位会报 ALARM 并丢失位置；先 hold 再 reset 可以保住位置。要固定在页面上的大红按钮，并配快捷键 |
| J6 | 固件 error 处理：停止 / 记录后继续（选项） | `Sender(stop_on_error)`、`errors` | P0 | 显示 error 码的中文含义（GRBL error:1-38 表） |
| J7 | ALARM 处理：中止、提示原因（ALARM:1-9 中文表）、引导解锁 | `Sender.abort` | P0 | — |
| J8 | 任务队列（多个文件或页依次打印，每个之间「换纸」确认） | NEW（K_AT 有 `KatBatchQueue`） | P1 | — |
| J9 | 从第 N 行续打（断电、中断后）：抬笔 → G0 到该行起点 → 落笔 | NEW | P1 | 要求原点没丢；只能从某一笔画的开头开始 |
| J10 | 进给倍率实时调节（GRBL 0x90-0x9D） | NEW | P1 | 在线调速很有用 |
| J11 | 打印完成通知（页面提示音、浏览器通知） | `Settings.alertFileComplete` | P1 | — |
| J12 | 结束后等 Idle 再标记完成 | `GrblController.wait_idle` | P0 | — |
| J13 | 单步模式（逐行等 ok） | `Settings.singleStep` | P1 | 调试用 |

## 12. 机器配置

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| K1 | 多个机器 profile：新建/复制/切换/导入导出 JSON | `MachineConfig.load/save` | P0 | `Settings.save` 的目录名为空时会 makedirs('') 报错（FIX，小问题） |
| K2 | 结构化编辑器：通用（feed/jog/延时/nearDst/dpi/rotate/offset/autoSetZero/autoConnect）、笔类型（GRBL Servo/Stepper/Laser/Servo_bachin 的对应字段）、坐标轴、高级 | `Settings`、`GrblSettings`、`AxesSettings`、`AdvancedSettings` | P0 | 只显示当前机型、当前笔类型相关的字段。`KatSettings` 的 feedOutY/parkX/penE **完全不生效**（`KatWriter` 和 `Sender.stop` 里写死了），要么隐藏要么 FIX |
| K3 | 新增字段：机器名、行程 workArea、默认串口/波特率 | NEW | P0 | — |
| K4 | 字段校验与范围（例：zOn 0-20 mm，feed 100-10000） | NEW | P0 | 用 JSON Schema |
| K5 | 首次上机向导：连接 → 方向确认（点动 +X 看方向）→ Z 校准 → 原点角 → 行程 → 试画小方块 | NEW | P1 | 对应 AUDIT P0 的真机验证流程 |

## 13. GRBL `$$` 设置

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| S1 | 读取 `$$`，表格显示（编号、值、中文说明、单位） | `GrblController.read_params`；存储 NEW | P1 | FIX：`_read_param` 只解析 $6/$30/$31/$83/$84，并且会**改写 profile**（$30→penUpPos、$6→ecoServo，$83/84 存在时改成 Servo_bachin），其余值丢弃 |
| S2 | 修改单项 `$N=v`（需二次确认），改前备份全部 | NEW | P1 | 在 Run 状态下禁止。$100-$102（步/mm）、$110-$112（最大速度）、$120-$122（加速度）是常调项 |
| S3 | 「把笔参数写入固件」 | `GrblController.apply_settings`（$30/$31/$6） | 禁用（Stepper） | **危险**：标准 GRBL 1.1f 里 $30/$31 是主轴转速上下限，$6 是探针反相，不是厂商固件的舵机参数。Stepper 机型必须隐藏这个功能 |
| S4 | `$G` 解析状态、`$#` 查看坐标偏移（G54 等） | NEW | P1 | 用来核对原点 |

## 14. 调试 / 控制台

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| D1 | 原始串口控制台：发送任意命令、历史、收发日志（>>> / <<<）、过滤掉 `?` 状态报告 | `send`、`on_log` | P0 | 打印中禁止发送（实时命令除外），否则会破坏流控 |
| D2 | 日志持久化（按任务滚动保存）、下载 | NEW | P1 | SD 卡写入寿命：日志要限速、轮转 |
| D3 | 实时字符快捷键（`?` `!` `~` 0x18 0x85） | NEW | P1 | — |

## 15. 文件库、模板、批量、历史

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| L1 | 文件库：资源（图片/SVG/DXF/G码/文本/CSV）+ 工程，缩略图、标签、搜索、配额 | NEW | P0 | 存在 `~/.penplot/library/`；磁盘满了要告警 |
| L2 | 工程保存/打开/另存/复制，自动保存草稿 | NEW（§0） | P0 | 工程 JSON 带 `version` 字段，留好迁移 |
| L3 | 模板：工程里加变量占位符 `{{姓名}}`（文本元素里），可设为默认模板 | NEW | P1 | — |
| L4 | 批量：上传 CSV/XLSX → 列映射到变量 → 每行生成一页或一个任务，预览任意一行，按行范围打印 | NEW（原 ExcelTab；AUDIT P1 batch） | P1 | XLSX 需要 openpyxl。CSV 编码要自动识别（GBK/UTF-8-BOM，中文 Excel 导出常见）。每行的缺字要汇总报告 |
| L5 | 导入/导出工程和模板 JSON（引用的字体、资源可选打包成 zip） | NEW | P1 | gfont 涉及版权，打包时默认不含字体 |
| L6 | 任务历史：时间、工程、耗时（实际/预计）、结果、错误；一键重打 | NEW（SQLite） | P1 | 实际耗时同时用来校准 R4 |
| L7 | 「写过的内容」去重提示（同一名单重复打印） | NEW | P2 | — |

## 16. 系统、权限、文档

| # | 功能 | 实现 | P | 风险 / 备注 |
|---|---|---|---|---|
| Y1 | 板子状态：CPU 温度、负载、内存、磁盘、运行时长、服务状态 | NEW（/sys、/proc、`df`） | P1 | 读取开销小 |
| Y2 | WiFi：当前网络、信号、扫描/切换、热点（AP）兜底 | NEW（nmcli） | P2 | 改错配置会失联；必须有「N 分钟内未确认就回滚」，以及没有网络时自动开 AP |
| Y3 | 服务日志（journalctl -u）、重启服务、重启板子 | NEW | P1 | 打印中禁止重启 |
| Y4 | 更新：版本显示、检查更新、git pull / 上传 wheel 安装后重启 | NEW | P2 | 打印中禁止；失败要能回滚 |
| Y5 | 认证：单管理员密码（首次设置）、会话 | NEW | P0 | 局域网也要有认证：任何人都能让机器动起来。最低要求是密码加「只有一个控制者」锁 |
| Y6 | 多用户/角色（管理员、操作员、只读观察）、API Token（脚本调用） | NEW | P2 | — |
| Y7 | 控制权：同一时刻只有一个会话能控制机器，其他人只读并看到实时状态 | NEW | P0 | 多个标签页同时点击会互相冲突 |
| Y8 | 内置帮助：上机流程、参数说明、错误码表、常见问题 | NEW（docs/） | P1 | — |
| Y9 | 设置备份与恢复（profiles + 工程 + 字体索引） | NEW | P1 | — |
| Y10 | 时间/时区（OPi 没有 RTC，靠 NTP） | — | P2 | 历史记录时间可能错乱 |

## 17. 导入/导出格式汇总

| 格式 | 导入 | 导出 | 实现 | P |
|---|---|---|---|---|
| .gfont / .psf | 字体 | psf↔gfont | `load_font`、`convert_font` | P0 / P1 |
| .ttf/.otf/.ttc | → 单线字 psf | — | `convert_ttf` | P1 |
| PNG/JPG/WebP/BMP | 图片元素 | PNG 预览 | `load_gray`；前端导出 | P0 |
| SVG | 矢量元素 | 预览 SVG | NEW；`paths_to_svg` | P0 |
| DXF | 矢量元素 | — | NEW（ezdxf） | P1 |
| G-code (.gcode/.nc/.gco) | 任务 / 元素 | 每页/合并 | `parse_gcode`（FIX）；`generate_gcode` | P0 |
| TXT / Markdown | 文本 | — | NEW（md 去标记） | P0 / P1 |
| CSV / XLSX | 批量 | 批量结果清单 | NEW | P1 |
| 工程/模板 JSON | 是 | 是 | NEW | P0 保存 / P1 导入导出 |
| PDF | （P2：PDF 矢量导入） | 预览 PDF | NEW | P1 |
| 原软件设计 .json | P2 | — | NEW | P2 |

---

## 18. UI 会暴露的核心缺陷（建议在接 UI 前修）

| # | 严重 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| B1 | 高 | `layout.TextDocument.entities` | 每次调用都重新 `layout()` 并消耗 RNG；开抖动后每页分页、换行与之前的 `layout()` 结果不同，预览 ≠ 输出（已实测） | 布局一次缓存结果，或每次调用前用 seed 重建 RNG |
| B2 | 高 | `gcode.parse_gcode` | 不认 Z 笔（`G1 Z`）、G91、G20、G2/G3；本机 G 代码导入得到 0 条路径（已实测） | 按 profile 判定笔状态（Z>阈值为落笔），并输出空走段 |
| B3 | 高 | `GrblController.set_zero` | 设零时把当前 Z 也设为 0；笔是落下的状态时，Z 基准被破坏 | 提供只设 XY 的版本；UI 强制先抬笔 |
| B4 | 高 | `GrblController._dispatch` | 不处理 WCO，显示 MPos；不解析 FS/Bf/Ov | 解析 WCO 并缓存；位置统一用 WPos |
| B5 | 高 | `MachineController._rx_loop` | 断线时静默退出，没有 `disconnected` 事件，Sender 挂死 | 发出事件，Sender 进入错误状态 |
| B6 | 高 | `GrblController` | 没有实时命令（`!` `~` 0x18 0x85、倍率） | 补充 feed_hold/cycle_start/soft_reset/jog_cancel/override |
| B7 | 高 | `GrblController.apply_settings` | 在标准 GRBL 上会改主轴范围和探针反相 | Stepper/标准固件禁用 |
| B8 | 中 | `GrblController._read_param` | 读 `$$` 会改写 profile，其余参数丢弃 | 只存 `$$` 表，不改写 profile |
| B9 | 中 | `Sender.progress` | 按已发送计数，进度超前 | 按 ack 计数；对外暴露 acked/total 和当前行 |
| B10 | 中 | `preview.stats` | 对排序前的元素统计；没有时间估算 | 改为基于最终 toolpath / G 代码模拟 |
| B11 | 中 | `cli._warn_bounds` | 只适用于 pos=0、不含 rotate；多页时不检查 | 移到核心，按完整坐标链计算 |
| B12 | 中 | `go_home` | 回原点不先抬笔（`Sender.stop` 有抬笔，手动回原点没有） | 先抬笔 |
| B13 | 中 | `cmd_img skeleton` | 用的是 `zhang_suen`，没用 `thin()` 和 `strokes.skeleton_strokes` | 统一用后者 |
| B14 | 中 | `ttffont.convert_ttf` | 没有进度/取消，结果 print 到 stderr | 加 progress 回调和取消标志 |
| B15 | 中 | `KatWriter`、`Sender.stop` | 忽略 `KatSettings`，值写死 | 读配置 |
| B16 | 中 | `_char_path` | 缺字时非空格字符画成一个矩形框，不发警告 | 返回缺字列表 |
| B17 | 中 | 字体 | 头部 name 是渠道名；10 个乱码文件名；`simsun-hand.psf` 实际只有 193 字（README 写 6857），`simsun-outline.psf` 只有 7 字 | 显示名解析和修复；重新生成或修正文档 |
| B18 | 中 | 内存 | 全部字体载入约 580 MB RSS | 码位索引 + LRU 缓存 |
| B19 | 低 | `laser_dots_gcode` | `move` 后又多 append 一个 `\r\n`，产生空行；GRBL 头部也有空行和重复抬笔 | 清理（Sender 会跳过空行，所以无害） |
| B20 | 低 | `Settings.save` | dirname 为空时 makedirs('') 报错 | 和 `MachineConfig.save` 一样加 `or '.'` |
| B21 | 低 | `PageInfo` | fontSize/lineGap/lineGapOffset/baseLine/fontPath/fontChance 没有用到 | 文档里注明，UI 不暴露 |
| B22 | 低 | `_resolve_font` | 前缀匹配有歧义（`-f k` 会命中第一个以 k 开头的字体） | UI 用 ID |
| B23 | 低 | `image._resize_nn` | 最近邻缩放有锯齿 | 改用 PIL 的 LANCZOS |

## 19. 主要风险（按影响排序）

1. **安全与硬件**：无限位、无回零。越界、Z 基准错误（B3）、急停缺失（B6）都会直接扎纸、撞笔、丢步。
   P0 的 O1/O4/O6/J5/M6 都是为此设计的；任何会让机器动的操作都要经过「控制权 + 状态」检查。
2. **串口所有权**：打开串口就会复位板子。后端必须是唯一常驻的串口持有者，网页只是客户端；
   服务崩溃或重启等于中断任务（P1：任务状态持久化，配合 J9 续打）。
3. **2 GB ARM 性能**：字体内存（B18）、图像处理的 Python 循环、TTF 转换要几十分钟。所有重计算都放
   后台进程池（并发 1-2），能取消、有进度；预览先出低分辨率。
4. **预览要和输出一致**：B1/B2/B10 不修，用户看到的和实际画出来的会不同，失去信任。验收标准：
   预览用的 toolpath 与发送的 G 代码来自同一份对象。
5. **暂停/停止的延迟**：软暂停和停止都要排空缓冲，延迟几秒。UI 文案要说清楚，并同时提供立即保持（`!`）。
6. **网络与访问**：WiFi 配置改错会失联（Y2 要能回滚和开 AP）；局域网里没有认证就等于任何人都能开机器（Y5 列为 P0）。
7. **版权**：厂商 gfont 和 SimSun 派生字体不能随工程或模板对外分发（L5 默认不打包字体）。

## 20. P0 汇总（v1 范围）

- **字体**：F1 列表、F2 显示名修复、F3 搜索、F4 覆盖检查（索引）、F5 样句、F6 缺字处理、F7 上传 gfont/psf、F12 混排
- **页面**：P1-P6（预设、自定义尺寸与边距、保存纸张预设、方向/旋转、行数、行程叠加）
- **文本**：T1-T8（输入/txt、字号与间距、对齐含分散、段落缩进、抖动常用项与预设、seed、多页、排序开关）
- **画布**：C1（文本框/图片/SVG/G码）、C2、C3、C4 基础对齐、C5、C7、C8、C9
- **图片**：I1-I3、I6、I7；**矢量**：V1 SVG、V3 G 代码导入（含 B2 修复）
- **原点**：O1-O7（原点模式、原点角/轴、每任务原点、走边框、坐标显示、软限位、正确的越界检查）
- **生成**：G1、G2 三层参数覆盖、G5、G6、G7；**预览**：R1、R2、R4（含时间估算）、R5、R6-SVG、R8
- **机器**：M1-M8；**任务**：J1-J7、J12；**配置**：K1-K4；**调试**：D1
- **库**：L1 文件库、L2 工程保存；**系统**：Y5 认证、Y7 控制权
- **前置核心修复**：B1-B7、B9-B12、B16、B18
