#!/usr/bin/env python3
"""Generate seed/templates/*.json (Project.doc, 04-contract-notes §8) and
seed/templates/index.json (manifest).

The JSON files are the deliverable; this script only exists so the layouts
stay easy to tweak.  After changing it run:

    .venv/bin/python seed/make_templates.py && .venv/bin/python seed/validate.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'templates')

# open fonts shipped in fonts/ (OFL single-line conversions; id = file stem)
WENKAI = 'open-wenkai-stroke'          # 文楷单线（LXGW WenKai, OFL）
HEI = 'open-hei-stroke'                # 黑体单线（Noto Sans CJK SC, OFL）
HAND = WENKAI                          # 清秀手写
KAI = WENKAI                           # 字帖示范字
XING = WENKAI                          # 诗词
ROUND = HEI                            # 标题/菜单
NOTE = WENKAI                          # 便签
SIGN = WENKAI                          # 签名练习
SANS = 'penplot-sans'                  # 内置单线体（数字、字母、邮编）
FULL = WENKAI                          # 字最全的那套（GB2312 一二级）

FONT_SCALE = {}

NOJ = {}                              # no jitter
SOFT = {'randomY': 0.04, 'randomRotate': [-2, 2], 'randomFontSize': [0.96, 1.04]}


def paper(pid, name, w, h, margins=(0, 0, 0, 0), orientation='portrait', line_num=20):
    l, r, t, b = margins
    return {'paper_id': pid, 'spec': {
        'name': name, 'width_mm': w, 'height_mm': h,
        'margins': {'l': l, 'r': r, 't': t, 'b': b},
        'orientation': orientation, 'rotation': 0,
        'ruling': {'line_num': line_num, 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0}}}


class Page:
    def __init__(self, pid='p1'):
        self.pid = pid
        self.els = []

    def _add(self, typ, x, y, props, name=None, rotation=0):
        n = len(self.els) + 1
        el = {'id': 'e%d' % n, 'type': typ, 'transform': {'x': round(x, 2), 'y': round(y, 2), 'scale': 1, 'sx': 1,
              'sy': 1, 'rotation': rotation}, 'z': n - 1, 'locked': False, 'hidden': False, 'pen': 1, 'props': props}
        if name:
            el['name'] = name
        self.els.append(el)
        return el

    def text(self, x, y, text, font, size, w=None, h=None, align='L', lh=1.3, cs=0.0, jitter=None,
             name=None, rotation=0, seed=None):
        if font in FONT_SCALE:            # fonts whose glyphs are drawn small inside the em box
            k = FONT_SCALE[font]
            size, lh = size * k, max(1.0, lh / k)
        lines = text.count('\n') + 1
        box = None
        if w is not None:
            box = {'w': w, 'h': h if h is not None else round(size * lh * lines + 0.01, 2)}
        props = {'text': text, 'font_id': font, 'size_mm': size, 'line_height': lh, 'char_space': cs,
                 'align': align, 'box': box, 'jitter': jitter if jitter is not None else NOJ,
                 'seed': seed if seed is not None else 1, 'missing_glyph': 'box'}
        return self._add('text', x, y, props, name, rotation)

    def vtext(self, x, y, text, font, size, gap=1.15, name=None, jitter=None):
        """Vertical column: one char per line, top -> bottom."""
        return self.text(x, y, '\n'.join(text), font, size, w=size * 1.2, lh=gap, align='C', name=name,
                         jitter=jitter)

    def flow(self, text, font, text_size=0.8, x=0, y=0, align='L', indent=True, jitter=None, name=None,
             line_num=None, seed=42):
        props = {'text': text, 'font_id': font, 'font_mix': None, 'text_size': text_size, 'char_space': 0.0,
                 'align': align,
                 'paragraph': {'spe_type': 1 if indent else 0, 'spe_value': 8.0 if indent else 0.0, 'left': 0, 'right': 0},
                 'line_num': line_num, 'seed': seed, 'missing_glyph': 'box',
                 'jitter': jitter if jitter is not None else SOFT}
        return self._add('flow_text', x, y, props, name)

    def rect(self, x, y, w, h, name=None, hatch=None):
        return self._add('shape', x, y, {'kind': 'rect', 'w': w, 'h': h, 'hatch': hatch}, name)

    def ellipse(self, x, y, w, h, name=None):
        return self._add('shape', x, y, {'kind': 'ellipse', 'w': w, 'h': h}, name)

    def line(self, x, y, pts, name=None, closed=False, kind='line'):
        return self._add('shape', x, y, {'kind': kind, 'points': pts, 'closed': closed}, name)

    def hline(self, x, y, w, name=None):
        return self.line(x, y, [[0, 0], [w, 0]], name)

    def grid(self, x, y, w, h, rows, cols, style='plain', name=None):
        return self._add('shape', x, y, {'kind': 'grid', 'w': w, 'h': h, 'rows': rows, 'cols': cols,
                                         'grid_style': style}, name)

    def out(self):
        return {'id': self.pid, 'paper': None, 'origin': None, 'elements': self.els}


def doc(name, paper_ref, pages, variables=(), print_=None):
    return {'version': 1, 'name': name,
            'variables': [{'name': n, 'default': d, 'type': 'text', 'label': lbl} for n, lbl, d in variables],
            'paper': paper_ref, 'print': print_ or {'optimize': True},
            'pages': [p.out() for p in pages]}


TEMPLATES = []


def template(tid, name, category, description, tags=(), sample=None):
    def deco(fn):
        TEMPLATES.append({'id': tid, 'name': name, 'category': category, 'description': description,
                          'tags': list(tags), 'sample_data': sample, 'build': fn})
        return fn
    return deco


# ------------------------------------------------------------------ 贺卡
@template('birthday-card', '生日贺卡', '贺卡', 'A5 横向对折贺卡，写在右半边内页：大标题、祝福语和落款，带蛋糕简笔画。',
          ['生日', '对折', '变量'])
def birthday():
    p = Page()
    # sheet 210 x 148 (landscape A5), fold at x = 105; content on the right half
    X0 = 105
    p.text(X0 + 10, 16, '生日快乐', ROUND, 15, w=85, align='C', lh=1.2, name='标题')
    # cake: plate, two tiers, candles
    cx = X0 + 52.5
    p.hline(cx - 22, 70, 44, name='盘子')
    p.rect(cx - 18, 56, 36, 14, name='下层')
    p.rect(cx - 12, 46, 24, 10, name='上层')
    p.line(cx - 18, 62, [[0, 0], [6, 2], [12, 0], [18, 2], [24, 0], [30, 2], [36, 0]], name='奶油')
    for dx in (-7, 0, 7):
        p.line(cx + dx, 40, [[0, 0], [0, 6]], name='蜡烛')
        p.ellipse(cx + dx - 1.2, 36, 2.4, 3.6, name='火苗')
    p.text(X0 + 12, 80, '{{name}}：\n愿你新的一岁平安喜乐，\n所求皆如愿，所行皆坦途。', HAND, 6, w=85, lh=1.55,
           jitter=SOFT, name='祝福语')
    p.text(X0 + 12, 120, '{{from}}\n{{date}}', HAND, 5.5, w=81, align='R', lh=1.5, jitter=SOFT, name='落款')
    return doc('生日贺卡', paper('card-a5-fold', '贺卡 A5 对折（210×148）', 148, 210, orientation='landscape'), [p],
               [('name', '寿星', '小明'), ('from', '落款', '全体同事'), ('date', '日期', '十月三十一日')])


@template('thank-you-card', '感谢卡', '贺卡', '明信片大小的感谢卡：双线边框、“谢谢你”标题、正文和落款。', ['感谢', '变量'])
def thanks():
    p = Page()
    p.rect(5, 5, 138, 90, name='外框')
    p.rect(7.5, 7.5, 133, 85, name='内框')
    p.text(10, 13, '谢谢你', XING, 13, w=128, align='C', lh=1.2, name='标题')
    p.hline(54, 32, 40, name='装饰线')
    p.text(16, 38, '{{name}}：\n谢谢你一直以来的帮助与陪伴，\n这份心意，我都记在心里。', HAND, 5.5, w=118, lh=1.6,
           jitter=SOFT, name='正文')
    p.text(16, 74, '{{from}} 敬上', HAND, 5.5, w=118, align='R', lh=1.4, jitter=SOFT, name='落款')
    return doc('感谢卡', paper('postcard-148x100', '明信片 148×100', 100, 148, orientation='landscape'), [p],
               [('name', '致', '王老师'), ('from', '落款', '小李')])


# ------------------------------------------------------------------ 明信片 / 信封
def postcode_boxes(p, x, y, size=7.0, gap=1.6, n=6, name='邮编框'):
    for i in range(n):
        p.rect(x + i * (size + gap), y, size, size * 1.15, name=name)
    return n * (size + gap) - gap


@template('postcard', '明信片', '贺卡', '148×100 明信片：左半写话，右半是邮编框、邮票框和收件人地址（{{name}} / {{address}} / {{postcode}}）。',
          ['明信片', '地址', '批量'], sample='samples/addresses.csv')
def postcard():
    p = Page()
    postcode_boxes(p, 8, 7, size=6.2)
    p.text(9.6, 8.2, '{{postcode}}', SANS, 4.6, lh=1.0, cs=4.65, name='邮编')
    p.rect(118, 7, 22, 26, name='邮票框')
    p.text(119, 17, '贴邮票', HAND, 3.2, w=20, align='C', name='邮票提示')
    p.line(76, 38, [[0, 0], [0, 56]], name='分隔线')
    # message (left)
    p.text(8, 40, '{{message}}', HAND, 4.5, w=64, h=50, lh=1.6, jitter=SOFT, name='留言')
    # address (right)
    for i in range(3):
        p.hline(82, 52 + i * 12, 58, name='地址横线')
    p.text(83, 42.5, '{{address}}', HAND, 4.6, w=56, h=21, lh=2.2, jitter=SOFT, name='地址')
    p.text(83, 66.5, '{{name}} 收', HAND, 6.2, w=56, lh=1.3, jitter=SOFT, name='收件人')
    return doc('明信片', paper('postcard-148x100', '明信片 148×100', 100, 148, orientation='landscape'), [p],
               [('name', '收件人', '李华'), ('address', '地址', '北京市海淀区中关村大街1号'), ('postcode', '邮编', '100080'),
                ('message', '留言', '见字如面。这里的秋天很好，银杏都黄了，等你来。')])


@template('envelope-cn5', '信封地址（中式 5 号）', '信封',
          '220×110 中式 5 号信封正面：左上邮编、收件地址与姓名、右下寄件人。配合 samples/addresses.csv 批量书写。',
          ['信封', '地址', '批量'], sample='samples/addresses.csv')
def envelope():
    p = Page()
    postcode_boxes(p, 12, 10, size=8, gap=2)
    p.text(14.1, 11.9, '{{postcode}}', SANS, 6.2, lh=1.0, cs=6.65, name='收件邮编')
    p.rect(186, 10, 22, 26, name='邮票框')
    p.text(20, 36, '{{address}}', HAND, 7, w=160, h=20, lh=1.45, jitter=SOFT, name='收件地址')
    p.text(30, 58, '{{name}}  收', HAND, 11, w=160, align='C', lh=1.2, jitter=SOFT, name='收件人')
    p.text(98, 84, '{{sender_address}}', HAND, 4.6, w=110, align='R', lh=1.4, jitter=SOFT, name='寄件地址')
    p.text(98, 92, '邮政编码：{{sender_postcode}}', HAND, 4.2, w=110, align='R', lh=1.4, name='寄件邮编')
    return doc('信封地址', paper('envelope-cn5', '中式 5 号信封 220×110', 110, 220, orientation='landscape'), [p],
               [('name', '收件人', '李华'), ('address', '收件地址', '北京市海淀区中关村大街1号'), ('postcode', '收件邮编', '100080'),
                ('sender_address', '寄件地址', '上海市徐汇区漕溪北路88号'), ('sender_postcode', '寄件邮编', '200030')])


# ------------------------------------------------------------------ 便签
@template('sticky-note', '便签', '便签', '76×76 方形便利贴：标题、待办三行、日期。', ['便签', '待办'])
def sticky():
    p = Page()
    p.text(6, 5, '{{title}}', NOTE, 7, w=64, lh=1.2, name='标题')
    p.hline(6, 15, 64, name='标题线')
    p.text(6, 19, '{{content}}', NOTE, 5.2, w=64, h=40, lh=1.7, jitter=SOFT, name='内容')
    p.text(6, 63, '{{date}}', NOTE, 4.2, w=64, align='R', lh=1.2, name='日期')
    return doc('便签', paper('sticky-76', '便签 76×76', 76, 76), [p],
               [('title', '标题', '今天要做'), ('content', '内容', '1. 取快递\n2. 回复客户邮件\n3. 买牛奶'),
                ('date', '日期', '10/31')])


# ------------------------------------------------------------------ 练字
@template('signature-practice', '签名练习', '练字', 'A4 签名练习纸：每行一个签名示范，后面留出空白基线自己练。', ['签名', '练字'])
def signature():
    p = Page()
    p.text(20, 14, '签名练习：{{name}}', ROUND, 7, w=170, lh=1.2, name='标题')
    y = 34
    for i in range(12):
        p.hline(20, y + 14, 170, name='基线')
        if i % 2 == 0:
            p.text(22, y, '{{name}}', SIGN, 12, lh=1.2, jitter=SOFT, name='示范签名', seed=i + 1)
        y += 21
    return doc('签名练习', {'paper_id': 'a4-normal', 'spec': None}, [p], [('name', '姓名', '张三')])


@template('calligraphy-tian', '书法字帖（田字格）', '练字', 'A4 田字格字帖：10×12 格，第一列是楷体示范字，后面描红留白。', ['字帖', '田字格'])
def tian():
    p = Page()
    cell, cols, rows = 17.0, 10, 13
    gx = (209 - cell * cols) / 2
    gy = 30
    p.text(gx, 12, '{{title}}', KAI, 9, w=cell * cols, align='C', lh=1.2, name='标题')
    p.grid(gx, gy, cell * cols, cell * rows, rows, cols, 'tian', name='田字格')
    size = 15.0                       # 楷体 glyph ≈ 0.69 em wide, centred by offset (wrapped lines ignore align)
    p.text(gx + 3.3, gy - 1.35, '{{chars}}', KAI, size, w=cell, h=cell * rows, align='L', lh=cell / size, name='示范字')
    return doc('书法字帖', {'paper_id': 'a4-normal', 'spec': None}, [p], [('title', '标题', '书法练习'), ('chars', '示范字（最多 13 个）', '永和九年春之初会于山阴兰亭')])


# ------------------------------------------------------------------ 诗词
@template('poem-vertical', '诗词竖排', '诗词', 'A5 竖排古诗：从右往左，每列一句，标题与作者在最右侧。', ['诗词', '竖排'])
def poem_v():
    p = Page()
    lines = ['床前明月光', '疑是地上霜', '举头望明月', '低头思故乡']
    size = 13
    x = 148 - 24
    p.vtext(x, 26, '静夜思', XING, 11, name='标题')
    p.vtext(x - 11, 70, '李白', XING, 7, name='作者')
    x -= 34
    for i, ln in enumerate(lines):
        p.vtext(x - i * 22, 26, ln, XING, size, gap=1.18, jitter=SOFT, name='第%d句' % (i + 1))
    p.text(12, 192, '{{note}}', XING, 5, w=60, lh=1.2, name='题记')
    return doc('诗词竖排', paper('a5', 'A5 148×210', 148, 210), [p], [('note', '题记', '甲辰秋 书')])


@template('poem-horizontal', '诗词横排', '诗词', 'A5 横向：居中标题、作者、正文，适合宋词。', ['诗词', '横排'])
def poem_h():
    p = Page()
    p.text(10, 12, '水调歌头', FULL, 11, w=190, align='C', lh=1.2, name='标题')
    p.text(10, 27, '苏轼', FULL, 6, w=190, align='C', lh=1.2, name='作者')
    body = ('明月几时有？把酒问青天。\n不知天上宫阙，今夕是何年。\n我欲乘风归去，又恐琼楼玉宇，\n高处不胜寒。起舞弄清影，何似在人间。\n'
            '转朱阁，低绮户，照无眠。\n不应有恨，何事长向别时圆？\n人有悲欢离合，月有阴晴圆缺，此事古难全。\n但愿人长久，千里共婵娟。')
    p.text(18, 40, body, FULL, 6.2, w=174, align='C', lh=1.75, jitter=SOFT, name='正文')
    return doc('诗词横排', paper('a5-landscape', 'A5 横向 210×148', 148, 210, orientation='landscape'), [p])


# ------------------------------------------------------------------ 菜单
@template('menu', '菜单', '活动', 'A4 菜单：店名标题、四个分类、菜名左对齐、价格右对齐。', ['菜单', '餐厅'])
def menu():
    p = Page()
    p.text(20, 18, '{{title}}', ROUND, 14, w=169, align='C', lh=1.2, name='店名')
    p.text(20, 38, '{{subtitle}}', ROUND, 5, w=169, align='C', lh=1.2, name='副标题')
    p.hline(60, 47, 89, name='标题线')
    sections = [('前菜', [('凉拌木耳', '18'), ('口水鸡', '32'), ('拍黄瓜', '12')]),
                ('主菜', [('红烧肉', '58'), ('清蒸鲈鱼', '68'), ('宫保鸡丁', '38'), ('麻婆豆腐', '22')]),
                ('甜点', [('杨枝甘露', '26'), ('桂花糕', '16')]),
                ('饮品', [('酸梅汤', '10'), ('菊花茶', '12')])]
    y = 56
    for title, items in sections:
        p.text(30, y, title, ROUND, 7, lh=1.2, name=title)
        p.hline(30, y + 10, 149, name='分类线')
        y += 14
        names = '\n'.join(n for n, _ in items)
        prices = '\n'.join(v for _, v in items)
        p.text(36, y, names, HAND, 5.5, w=100, lh=1.7, name=title + '菜名')
        p.text(129, y, prices, SANS, 5, w=50, align='R', lh=5.5 * 1.7 / 5, name=title + '价格')
        y += len(items) * 5.5 * 1.7 + 8
    p.text(20, 270, '价格单位：元', HAND, 4, w=169, align='C', lh=1.2, name='备注')
    return doc('菜单', {'paper_id': 'a4-normal', 'spec': None}, [p],
               [('title', '店名', '小院家常菜'), ('subtitle', '副标题', '今日推荐  欢迎光临')])


# ------------------------------------------------------------------ 席位卡（批量）
@template('place-card', '席位卡', '活动',
          '100×100 卡纸对折成 100×50 帐篷卡：两面都写名字（上半部分倒写，折起后两侧都正着看）。用 samples/guests.csv 批量。',
          ['席位卡', '婚礼', '批量'], sample='samples/guests.csv')
def place_card():
    p = Page()
    # bottom half (y 50..100) upright
    p.text(5, 60, '{{name}}', XING, 13, w=90, align='C', lh=1.2, jitter=SOFT, name='姓名')
    p.text(5, 82, '{{table}}', ROUND, 5, w=90, align='C', lh=1.2, name='桌号')
    # top half rotated 180° around its origin: origin at bottom-right of the text box
    p.text(95, 40, '{{name}}', XING, 13, w=90, align='C', lh=1.2, jitter=SOFT, name='姓名（背面）', rotation=180)
    p.text(95, 18, '{{table}}', ROUND, 5, w=90, align='C', lh=1.2, name='桌号（背面）', rotation=180)
    return doc('席位卡', paper('place-card-100', '席位卡 100×100（对折）', 100, 100), [p],
               [('name', '宾客', '王小明'), ('table', '桌号', '第 1 桌')])


# ------------------------------------------------------------------ 信件（批量）
@template('letter', '通知函（批量信件）', '信件', 'A4 信纸流式正文：抬头 {{name}}，正文自动换行换页，落款与日期。配合 samples/addresses.csv 批量。',
          ['信件', '批量', '流式'], sample='samples/addresses.csv')
def letter():
    p = Page()
    body = ('尊敬的{{name}}：\n'
            '您好！感谢您一直以来对我们工作的支持。根据今年的安排，本季度的服务回访将在下个月上旬进行，'
            '届时工作人员会提前和您联系，确认具体的时间。\n'
            '如果您的联系方式或地址有变动，请在本月底前告诉我们，以便及时更新资料。手写的信比消息慢一些，'
            '但我们希望每一位客户都能收到一封认真写下的信。\n'
            '此致\n敬礼')
    p.flow(body, HAND, 1.0, name='正文')
    p.text(110, 190, '{{from}}\n{{date}}', HAND, 6, w=67, align='R', lh=1.6, jitter=SOFT, name='落款')
    return doc('通知函', {'paper_id': 'a4-normal', 'spec': None}, [p],
               [('name', '收信人', '李先生'), ('from', '写信人', '客户服务部'), ('date', '日期', '十月三十一日')])


# ------------------------------------------------------------------ 作业纸
@template('lined-paper', '横线信纸', '作业纸', 'A4 小一圈（200×287）横线信纸：只画格线，适合手写或配合流式文字。', ['信纸', '横线'])
def lined():
    p = Page()
    for i in range(24):
        p.hline(15, 30 + i * 10.5, 170, name='横线')
    p.text(15, 14, '{{title}}', ROUND, 6, w=170, align='C', lh=1.2, name='页眉')
    return doc('横线信纸', paper('a4-inset', 'A4 小一圈 200×287', 200, 287, margins=(15, 15, 25, 20)), [p],
               [('title', '页眉', '读书笔记')])


@template('english-four-line', '英文四线格', '练字', 'A4 英文四线三格：每组上两条细线、红线（基线）与下线，第一行带示范字母。', ['英文', '练字'])
def four_line():
    p = Page()
    p.text(20, 12, 'English Practice', SANS, 7, w=169, align='C', lh=1.2, name='标题')
    y = 30
    for i in range(10):
        for k, dy in enumerate((0, 4, 8, 12)):
            p.hline(20, y + dy, 169, name='四线')
        if i == 0:
            p.text(22, y - 1.68, '{{sample}}', SANS, 12.9, lh=1.0, cs=1.0, name='示范')
        y += 24
    return doc('英文四线格', {'paper_id': 'a4-normal', 'spec': None}, [p], [('sample', '示范字母', 'Aa Bb Cc Dd Ee Ff Gg')])


def main():
    index = []
    for t in TEMPLATES:
        d = t['build']()
        fn = t['id'] + '.json'
        with open(os.path.join(OUT, fn), 'w', encoding='utf-8') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write('\n')
        index.append({'id': t['id'], 'file': fn, 'name': t['name'], 'category': t['category'],
                      'description': t['description'], 'tags': t['tags'], 'sample_data': t['sample_data'],
                      'preview': 'previews/%s.png' % t['id'], 'preview_svg': 'previews/%s.svg' % t['id'],
                      'variables': [v['name'] for v in d['variables']],
                      'fonts': sorted({e['props'].get('font_id') for pg in d['pages'] for e in pg['elements']
                                       if e['props'].get('font_id')}),
                      'paper_id': d['paper'].get('paper_id')})
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'templates': index}, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('wrote %d templates' % len(index))


if __name__ == '__main__':
    main()
