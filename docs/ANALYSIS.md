# 原写字/雕刻软件的文件格式与行为说明（互操作参考）

> 本文档记录 penplot 为与一款常见的国产写字机/激光雕刻上位机（以下称"原软件"）**互操作**所需的
> 文件格式和可观察行为：`.gfont` 单线字体格式、G 代码/EBB 命令格式、排版引擎的度量规则、
> 串口协议和默认参数。目的是让 penplot 能读取用户合法拥有的字体文件、生成与原软件一致的
> G 代码，并驱动同一类硬件。
>
> 本文档**不**涉及也不提供原软件程序本身的解密、授权/激活机制或任何绕过手段；penplot 不包含
> 原软件的任何代码或字体。文中出现的数值均为格式常量或可通过对比输出文件验证的行为。

## 1. 背景

- 支持的机器类型: **Ebb**, **Grbl**(最常用), **Marlin**(3D打印机主板), **K_AT**(自动送纸写字机)
- 原软件的默认参数见 §7；用户配置以 JSON 保存（`settings.json`、`Grbl.json` 等）。
- 原软件的字体为 `.gfont` 单线笔画字体（§2–3），penplot 可读写该格式，也提供明文 `.psf` 格式。

## 2. gfont 头部的加密封装

`.gfont` 文件（v5）的元数据头经过一层 TEA 变种封装（字形数据本身不加密）。读取头部需要：

- 标准 TEA, **16 轮**, DELTA=0x9E3779B9
- 块=8字节。字节块 → (v0,v1)：**大端**解析；输出：**小端** v0 ++ 小端 v1（即 byte-swap）
- 分组模式：自定义 CBC（密文反馈+明文反馈混合）:
  - 头部: `[0x20|padLen][padLen个随机字节(50..127)][2个随机字节]`，尾部 7 个零字节
  - 加密: C_tmp = TEA(P ⊕ O_prev); O = C_tmp ⊕ Z_prev; Z = P⊕O_prev
- 密钥是格式常量（所有 `.gfont` 文件相同）: `[1,9,8,9,0,8,2,6,1,9,9,2,0,8,2,8]`

实现见 `penplot/tea.py`、`penplot/gfont.py`；`penplot font convert` 可在 `.gfont` 与明文 `.psf` 之间无损互转。

## 3. gfont 字体格式（v≤5）

```
[int32 BE version]                # 必须 <=5; >=3 用数字命名 zip 条目
若 version>=5:
  [int32 BE encLen][encLen字节]   # TEA加密的头(见上), 解密后:
      UTF(name) int32(type枚举序号) UTF(b) UTF(a) UTF(c) int32(size) int32(glyphCount)
      [若v>=2: UTF(n)] [若v>=4: UTF(o)]
[int32 BE nInline]                # 内联字形数(热字形, 最多30)
nInline × 字形: [uint16 BE charCode][int32 BE nFloats][float32 BE × n][int32 BE nBytes][byte × n]
[ZIP 归档]                        # 条目名=(int)charCode(v>=3)或单字符; 每条目=同上字形结构
```
- 字形数据 = 坐标 float 数组(x,y 交替) + 段类型字节数组(**0=moveTo, 1=lineTo**)，与路径实体同构
- 只读元数据时可只解析头部和内联字形；完整读取需再解析 ZIP 部分
- Java `DataOutputStream.writeUTF`: [uint16长度][修饰UTF-8字节]

## 4. 几何约定

路径实体: `float[] coords` + `byte[] ops`(0=move,1=line)
- `moveTo` 连续调用会替换上一个 move 点；`lineTo` 前必须有 move
- 支持反转、拼接(接点变 lineTo)、包围盒、坐标取整(int截断)
- 曲线全部多边形化: 椭圆(参数步进)、矩形、闭合多边形、
  二次/三次贝塞尔(de Casteljau 按 step)、**SVG arc→贝塞尔**(标准实现, 每90°一段, kappa=4/3·tan(θ/4))
- RDP 简化（按 moveTo 分段；penplot 用经典 RDP 实现）
- 变换 = Java AffineTransform: translate/scale(含预乘)/rotate(角度制+支点)/shear

## 5. 排版引擎（写字模式）

### 5.1 页面 PageInfo
- 预设: A4/A3/16开 × 普通(31.8)/窄(12.7)/适中(19.1)/宽(50.8)mm 边距; 上/下边距默认 25.4
- 字段: pageWidth/Height(mm), leftGap/rightGap/topGap/bottomGap, lineNum(每页行数,默认20),
  fontSize(95), space(字间距系数,默认1), lineGap/lineGapOffset, contentAlign, alignOffsetX/Y(±Max), rotation,
  fontPath[]/fontChance[] (多字体随机混用), baseLine
- 行高 u = (pageHeight - topGap - bottomGap) / lineNum   [px]

### 5.2 字符布局
```
baseline = lineHeight * 0.75 * baseLine系数
scale = lineHeight / font.size * randomFontSize * textSize        # font.size=gfont头部的size
glyph先缩放(scale*randomXScale, scale*randomYScale) → 绕原点旋转randomRotate → 求包围盒
若minX<0: x平移-minX; 特殊字符(默认"，,。")再加widthAdd mm
平移到 (shiftX, baseline + randomY*lineHeight抖动)
若simple>0: RDP简化
字宽 advance = bbox.maxX + max(0,minX) [+widthAdd]
空格: advance = lineHeight*textSize*0.3 + spaceWidthAdd
\t: advance = lineHeight*textSize*0.3*2 + tabWidthAdd    (无字形)
\n: advance= lineHeight*0.5, 绘制宽度0 (有回车箭头字形用于预览)
\f: 换页
字符间额外空隙 = charSpace(mm→px) + randomSpace抖动
```
- 随机抖动: 均匀随机 [lo,hi]（相等则返回定值）
  可调项: randomFontSize/Space/Rotate/XScale/YScale(各[lo,hi]), randomY(基线抖动系数), randomFirstPos

### 5.3 行/页与换行
- 每行 line cell: 行内 align(Left/Center/Right) + 段落首行缩进(2字符/gpNum 空格缩进)
- 自动换行: 光标x + 字宽 + 前字空隙 > 行宽 → 回退; **禁则处理**: 行首不能出现
  `,，;；.。!!??》}}]】)）、……"°%:` (这些标点跟前行挤)
- 多页: lineNum 行/页; \f 强制换页; 段落/选区/剪贴板/删除等编辑操作
- 设计文件 = JSON: `{pageInfo:{...}, items:[{char,textSize,charSpace,font,lineHeight,lineAlign}], paragraph:[...]}`

## 6. G 代码生成

### 6.1 导出管线
```
设计坐标(px, dpi默认96可取系统)
→ 绕页面中心旋转 rotation°
→ 平移 (旋转补偿 - 用户原点标记位置)
→ Y 翻转 (1,-1)
→ 坐标轴变换 AxesData: revxy(对调XY) / xAxeRev / yAxeRev / pos(原点象限: 左上0/右上1/左下2/右下3)
→ 缩放 25.4/dpi → 毫米
```
EBB 特例: 强制 revxy=xAxeRev=yAxeRev=true 再按上变换。

### 6.2 路径优化 —— "智能排序"
1. 拆分: 实体 → moveTo 分段的折线列表
2. 贪心最近邻: 从第一条折线开始, 每次找端点(首/尾取近者, 尾近则反转)距离当前末端最近的折线;
   距离 ≤ nearDst(默认0.3mm, 平方距离比较) 则**合并**进当前折线, 否则作为新折线输出
3. 输出: 每段 [抬笔] [G0 到起点] [落笔] G1…G1 [重复点跳过]

### 6.3 文件格式（逐字节一致）
- 行尾: **\r\n** (GRBL/Marlin/EBB 文件全部 \r\n; EBB 命令内不再有\r\n)
- 坐标格式: `DecimalFormat("#0.000")` — 3位小数, 无尾随零补齐(#表示可省略前导0)
- **GRBL**:
  ```
  {custom_start}\r\nG21\r\nG90\r\nF{feedRate}\r\n{pen_up}\r\n
  每段: {pen_down}\r\n[G4 P{toolOnDelay}秒\r\n] G0 X..Y..F{jogSpeed}\r\n G1 X..Y..F{feedRate}\r\n... {pen_up}\r\n[G4 P{toolOffDelay}\r\n]
  结尾: {pen_up}\r\n[G4 P{toolOffDelay}\r\n]G90G0 X0Y0\r\n{custom_end}\r\n
  ```
  - 抬笔/落笔按 GrblSettings.type: **Servo/Laser**: up=`M5`, down=`M3S{laserS(=laser_power,默认1000)}`;
    **Stepper**: up=`G1G90 Z{zOff}F{zSpeed}`, down=`G1G90 Z{zOn}F{zSpeed}`; **Servo_bachin**: `M3S{penUpPos}`/`M3S{penDownPos}`
  - 移动: 快速=`G0 X{x}Y{y}F{jogSpeed}`, 绘制=`G1 X{x}Y{y}F{feedRate}` (**X值与Y之间无空格**)
  - G4 参数单位=秒(GRBL特性)
- **Marlin**:
  ```
  {custom_start}\r\nG21\r\nG90\r\nG92X{offX}Y{offY}Z0\r\n{pen_up}\r\n
  段结构同上; G4 参数=毫秒(int)(delay*1000); 回零=`G0 X0Y0F{jogSpeed}`
  ```
  - 笔: **Servo**: `M280 P0 S{penUp=50|penDown=0}`; **Stepper**: `G1G90 Z{mm}F{zSpeed}`;
    **EStepper**: `G1G90 E{mm}F{zSpeed}`; **Fan**: up=`M107`, down=`M106 S{fanSpeed=255}`
  - G92X/Y 数值为 Java float 默认 toString(如 0.0)
- **K_AT** (kat): 生成同 Marlin 但笔=`G1G90 E0.2 F4000`(up)/`G1G90 E6 F4000`(down)
- **EBB**: 非文本协议, 直接生成 EBB 命令流:
  ```
  {custom_start}\r\n
  段: SP,0,{int(toolOnDelay*1000)}\r\n   ← 落笔(舵机槽0)
      XM,{duration},{stepsA},{stepsB}\r\n  ← 相对步进(增量, 带亚步累加)
      SP,1,{int(toolOnDelay*1000)}\r\n   ← 抬笔
  结尾: SP,1,..\r\n + XM 返回累计原点 + {custom_end}\r\n
  ```
  - `XM` duration = round(max(|dxA|,|dyB|) / (speed_mm_min/60*mmToSteps限25000) * 1000), 最小1
  - 速度: 绘制=feedRate, 空走=jogSpeed; 步进 = mm*mmToSteps(100) 取整+小数余数累加
- 激光点阵模式: `M3S0\r\n` 开头; 每点: G0到点\r\n + `S{laserS}\r\n`(落) + `S0\r\n`(抬), toolOnDelay 强制可调

### 6.4 机器控制协议
- 串口: jssc; 命令以 `\n` 结尾发送(在线控制), 波特率由用户选择(UI)
- **GRBL**: 连接=发 0x18 软复位 → 收 "Grbl" 横幅(解析版本) → 可选 `$$` 读参数
  - 状态查询 `?` 周期轮询(<...> 报文: Idle/Run/Alarm/Sleep/Jog/Home)
  - `$H` 归位, `$X` 解锁, `$SLP` 休眠, `G10 P0 L20 X{offX}Y{offY}Z0` 设零
  - 点动: v1.1+ `$J=G21G91 X.. Y.. Z.. F..`, 旧版 `G21G91 X.. Y.. Z.. F..`
  - 缓冲: 字符计数流控, **RX余量=100**; ok/error 应答
  - 写参数: `$30=penUpPos $31=penDownPos $6=ecoServo` (v1.1+)
- **Marlin**: 连接=发 `M115` → FIRMWARE_NAME/Marlin 横幅; `echo:` 行解析设置(M92/M201/M203)
  - `M280 P0 S..` 舵机, `G28 Z` 归位, `M18` 断电, `G92X..Y..Z0` 设零, 点动=`G91`+`G0 X.. Y.. F..`
  - 行号+校验和: `N{n} {cmd}*{xor(全部字符)}`; 处理 `Resend: n` 重发; **RX余量=96**
  - SD: `M20`(列表) `M23`(选) `M24`(印) `M30`(删) `M110 N0`+`M28 {name}.gco`…`M29`(上传)
- **EBB**: 0x18 复位; 横幅 "EBB…Version" 或 "Steamduino DrawCore"(定制固件); 应答=大写 `OK`(一次一发)
  - `SP,{0|1},{ms}` 笔(槽位), `XM,{ms},{A},{B}` 步进, `EM,0,0`+`S2,0,4` 休眠, `R` 复位,
    `SC,4,{penUpPos} SC,5,{penDownPos} SC,11,{upSpeed} SC,12,{downSpeed}` 后 `V`(vendor-x为`VV`) 保存
  - 命令耗时估计: SP→第3参, XM→第2参 (用于流控/进度)
- **K_AT** (extends Marlin): 横幅含 "K_AT"; `M998` 等纸 → "paper ready" 事件 → 流式打印;
  `Error:` = 缺纸/传感器异常; 完成后 `G0 Y420 F8000`(出纸)+`G0 X290 F3000`(笔归位); 批量队列 DrawFileItem{file, num份数}
- **发送器**: 队列+流控; 暂停=抬笔+换队列, 恢复=补落笔; 停止=抬笔+归位(K_AT出纸);
  single_step_command=true 时逐条等 ok; Marlin/KAT 流式时加行号校验

## 7. 默认参数 (default.properties 全部)
```properties
machine=vendor            feed_rate=1500(mm/min)    jog_speed=2500
tool_on_delay=0.2(秒)      tool_off_delay=0.2        auto_connect=true
auto_set_zero=true         single_step_command=false autoSleep=false
custom_start_gcode=        custom_end_gcode=
# EBB: mm_to_steps=100  max_pen_speed=32767  max_pen_value=30000  servo_speed=750
#      pen_up_pos=12000(SC,4)  pen_down_pos=18000(SC,5)
# GRBL: grbl_type=Servo  zOn=2  zOff=0  zSpeed=3000  laser_power=1000
# Marlin: marlin_type=Servo  down_mm=2  up_mm=0  pen_up=50  pen_down=0  z_speed=3000
# 坐标: axe_rev_xy/x/y=false  axe_pos=0(左上)
offset_x=0  offset_y=0     nearDst=0.3mm  rotate=0  dpi=96(或系统)
```

## 8. 其他功能页签（功能清单）
- **手写/文本**: 上述排版引擎, 多页, 页导航
- **Excel 名单**: Excel/CSV 导入 → 按每行生成一页; 网格分页
- **SVG 导入**: SVG 解析 → path
- **线稿**: 图像→轮廓线
- **描边**: OpenCV 边缘检测
- **细化**: 骨架化
- **点阵照片**: 灰度→点功率激光点阵(px2mm, internalScale)
- **笔记/网格/波浪字**
- 预览: 2D 渲染 + 3D 视图; 机器状态面板; 传输进度

## 9. 与原软件比对验证要点
1. gfont 解析 → 字形路径坐标逐点一致
2. 同一文本+同参数 → 生成 G 代码与原软件导出文件 diff
3. 随机抖动: 原软件每次随机, 无法逐字节复现, 但分布/参数语义一致(可选固定种子)
4. EBB 步进累进逻辑(亚步误差补偿)一致
```
