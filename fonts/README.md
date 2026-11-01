# fonts/ — 随附的开源单线字体

写字机用的是**单线（单笔画）字体**：每一笔是一条折线，笔沿着它走一遍就写完，不像普通字体那样
描一圈轮廓再填充。本目录只放可以自由再分发的字体。

| 文件 | 显示名 | 字数 | 大小 | 来源 | 许可 |
|---|---|---|---|---|---|
| `penplot-sans.psf` | penplot-sans | 80（A–Z、0–9、常用标点，小写映射为小型大写） | 6 KB | penplot 原创 | 随项目 AGPL-3.0-or-later |
| `open-wenkai-stroke.psf` | 文楷单线 WenKai Stroke | 7 122 | 5.9 MB | LXGW WenKai v1.530 | SIL OFL 1.1 |
| `open-hei-stroke.psf` | 黑体单线 Hei Stroke | 7 122 | 5.4 MB | Noto Sans CJK SC 2.004 | SIL OFL 1.1 |
| `open-caveat-stroke.psf` | Cursive Stroke | 107（ASCII + 常用标点） | 24 KB | Caveat（wght 400） | SIL OFL 1.1 |

两个中文字体的字符集：ASCII、GB2312 符号区（全角标点等）、GB2312 一级 + 二级汉字（6 763 字），
外加 `—–‘’“”…·•～€￥`。常用字和次常用字全部覆盖。

预览图在 [`previews/`](previews/)（由 penplot 自己的排版引擎渲染，浅蓝线是基线）：

![文楷单线](previews/open-wenkai-stroke.png)
![黑体单线](previews/open-hei-stroke.png)
![Cursive Stroke](previews/open-caveat-stroke.png)

## 许可与命名

转换后的字体是原字体的"修改版本"（Modified Version），按 SIL Open Font License 1.1 继续以 OFL 发布，
不能单独出售，也不能改用其他许可证。许可证全文和原版权声明在 [`LICENSES/`](LICENSES/)，
每个 `.psf` 文件开头的注释里也写明了来源、版权和许可。

OFL 不允许修改版本使用原字体的**保留字体名**（Reserved Font Name）作为主名称，因此：

- LXGW WenKai 的保留名是「霞鹜」「霞鶩」「落霞孤鹜」「落霞孤鶩」和「LXGW」，转换版命名为
  **文楷单线 WenKai Stroke**，不含这些名字。
- Noto Sans CJK 的许可没有声明保留名，但「Noto」是 Google 的商标，转换版命名为 **黑体单线 Hei Stroke**。
- Caveat 没有保留名，为避免混淆仍命名为 **Cursive Stroke**。

文件名和显示名里都不用原字体名，只在版权声明和本文档里注明来源，这是 OFL 第 4 条允许的致谢方式。

| 来源 | 版权 | 上游 | 许可文本 |
|---|---|---|---|
| LXGW WenKai v1.530 | © 2021-2026 LXGW；© 2020 The Klee Project Authors | <https://github.com/lxgw/LxgwWenKai> | [OFL-LXGW-WenKai.txt](LICENSES/OFL-LXGW-WenKai.txt) |
| Noto Sans CJK SC 2.004 | © 2014-2021 Adobe | <https://github.com/notofonts/noto-cjk> | [OFL-Noto-CJK.txt](LICENSES/OFL-Noto-CJK.txt) |
| Caveat | © 2014 The Caveat Project Authors | <https://github.com/googlefonts/caveat> | [OFL-Caveat.txt](LICENSES/OFL-Caveat.txt) |

## 重新生成

```bash
pip install -e '.[ttf]'
mkdir -p /tmp/src && cd /tmp/src
curl -LO https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf
curl -L -o 'Caveat[wght].ttf' 'https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat%5Bwght%5D.ttf'
# Noto Sans CJK：Debian/Ubuntu 上 apt install fonts-noto-cjk，脚本会从 /usr/share/fonts/opentype/noto/ 读取
cd -
python fonts/tools/build_open_fonts.py --src-dir /tmp/src          # 每个中文字体约 20 秒
python fonts/tools/render_previews.py                              # 渲染预览并检查缺字和基线
```

转换参数：`skeleton`（手写单笔画）模式，栅格 160 px，RDP 容差 1.2 px。源文件的 sha256 记录在每个
`.psf` 的头部注释里。

## 添加自己的字体

字体目录查找顺序：`$PENPLOT_FONT_DIR` → `./fonts` → `./gcodeFonts` → 仓库内 `fonts/` → `~/.penplot/fonts`。
网页工作台用 `PENPLOT_FONT_DIR`（部署时是 `/var/lib/penplot/fonts`），也可以在「字库」页直接导入。

- **`.psf`**：penplot 的明文单线字体格式（见主 README），任何能输出折线的工具都能生成。
- **`.gfont`**：一些国产写字机软件使用的单线字体格式，penplot 可以直接读取，也能和 `.psf` 互转：
  `penplot font convert a.gfont a.psf`。请只使用你有权使用的字体文件。
- **`.ttf` / `.otf` / `.ttc`**：普通轮廓字体要先转成单线：

  ```bash
  penplot font ttf 某字体.ttf my-hand.psf --all          # 手写单笔画，GB2312 一二级 + 全角标点
  penplot font ttf 某字体.ttc my.psf --face 2 --all       # .ttc 选第几个 face（Noto CJK 的 SC 是 2）
  penplot font ttf 某字体.ttf my-outline.psf --mode outline   # 轮廓描边（激光用）
  ```

  网页「字库 → 转换 TTF…」做的是同一件事。转换前请确认字体许可允许修改和再分发：
  Windows 自带的宋体、微软雅黑等**不能**随项目分发，转出来的文件只能自己用。

**不要把没有再分发许可的字体提交到仓库。** 根目录 `.gitignore` 对 `fonts/` 采用白名单：只有
上表中的文件、`LICENSES/`、`previews/`、`tools/` 和本文件会被跟踪；`*.gfont`、`*.ttc` 和由微软字体
转换的 `msyh*.psf`/`simsun*.psf` 在任何位置都会被忽略。要加入新的开源字体，先在 `.gitignore`
里加白名单行，再把许可证放进 `LICENSES/` 并更新本文件。
