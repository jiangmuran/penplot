# Changelog

## Unreleased

## 0.3.0 — 2026-11-01 (网页工作台 + 开源发布)

首个公开版本，以 `AGPL-3.0-or-later` 许可发布。

### 新增
- **网页工作台**（`penplot-web`，FastAPI + React）：创作台（自由排版 / 信笺模式、文本、形状、图片、
  SVG/DXF 导入、竖排、页面与图层、笔顺预览）、项目与模板、批量信件（CSV/Excel 变量）、字库管理
  （覆盖率、缺字检查、导入、TTF 转单线）、机器控制（行程图、点动、抬/落笔、设原点、落笔深度校准、宏、
  固件参数）、任务队列（服务端流控、暂停/继续/从某行重试、历史）、调试控制台、电传打字机、系统诊断与日志、
  上机向导和内置帮助。桌面、平板、手机自适应，浅色/深色主题。
- **位置预览 / 走边框**：打印前在机台上显示纸张、原点和书写范围，越出纸张或行程时提示。
- **多用户**：管理员 / 操作员 / 只读角色，机器控制权（lease），带权限范围的 API 令牌，首次启动初始化码，
  CSRF 防护，登录限速。
- **WebSocket** 实时状态（机器、任务、系统指标），断线自动重连并从快照恢复。
- **Cloudflare Tunnel 支持**：只信任来自本机回环的转发头，真实客户端 IP 用于限速，远程请求不能使用终端模式。
- **部署脚本**：`deploy/bootstrap.sh`（板子一次性初始化：低权限用户、systemd、udev）、
  `deploy/deploy.sh`（构建、上传、预检、原子切换、健康检查、失败回滚）。
- **开源单线字体**：文楷单线（由 LXGW WenKai 转换）、黑体单线（由 Noto Sans CJK SC 转换），
  各 7 122 字（GB2312 一二级 + ASCII + 全角标点）；Cursive Stroke（由 Caveat 转换）。均为 SIL OFL 1.1，
  生成脚本和预览在 `fonts/`。
- `.psf` 字形懒加载；字体样张在任务进程中渲染并缓存。
- Playwright 端到端测试（真后端 + FakeGrbl）、GitHub Actions CI。

### 变更
- 仓库不再包含任何第三方商业字体或由 Windows 字体转换的字体；`.gitignore` 对 `fonts/` 改为白名单。
- 文档整理：`docs/ANALYSIS.md` 改为纯互操作用的文件格式说明，`docs/AUDIT.md` 改为兼容性审计记录；
  文档和示例中的地址、路径改为占位符。
- 新增 `README.en.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`CONTRIBUTING.md`、`SECURITY.md`。

## 0.2.1 — 2026-10-31 (整理 + 串口可靠性修复)

### 修复
- **`penplot print` 从不发送**：装载 G 代码后没有调用 `Sender.start()`，命令会无限空等。
- **固件 `error` 导致卡死**：Sender 只处理 `ok`/`resend`，GRBL 回 `error:N` 时该行永远留在
  待确认队列里。现在 error 会消耗该行；默认停止任务（`--continue-on-error` 可改为继续），
  错误记录在 `Sender.errors`。`ALARM:` 立即中止，不再继续发送。
- **字符计数流控**：每收到一个 `ok` 就把已发送字节数清零，多行在途时会写爆 GRBL 128 字节
  RX 缓冲。现在按行精确记账，`ok` 只释放被确认那一行的字节。
- **停止时先回原点再抬笔**：会在纸上划出一道线。改为先抬笔再回原点 / 出纸。
- **暂停/恢复**：原实现暂停时从不真正抬笔，恢复时按 `set_pen` 的状态（而不是打印流的笔状态）
  落笔。现在暂停注入一次抬笔，恢复时若暂停前笔是落下的则重新落笔。
- **单步模式**：在途有未确认命令时仍可能再发一条。
- **`send(..., wait_ok=True)` 竞态**：监听器在写串口之后才注册，快速的 `ok` 会被错过并白等
  10 秒。现在先注册再写；返回 True/False（error 时 False）。
- **打印结束过早关串口**：最后一个 `ok` 只表示进入规划队列。现在 GRBL 轮询 `?` 直到 `Idle`，
  Marlin 用 `M400`。
- **点动残留相对坐标**：GRBL 旧版/未知版本的点动和 Marlin 点动用 `G91` 后不恢复 `G90`。
- **`--config` 文件不存在时静默使用默认参数**：现在报错退出。
- **字体加载慢**：`write -f 某字体` 会把目录里全部 84 个字体完整解码（约 11 s）。现在按文件名
  只加载选中的字体，且 `.gfont` 的 ZIP 字形按需解码：同一命令 0.17 s。

### 整理
- 目录结构：`penplot/` 包、`fonts/`、`configs/`、`tests/`、`scripts/`、`docs/`；`pyproject.toml`
  （`pip install -e .[all]`，命令行入口 `penplot`）。
- 测试改为 pytest；旧脚本移入 `tests/scripts/`，去掉写死的 `C:\Program Files` / `C:\Windows\Fonts`
  路径（改为 `PENPLOT_FONT_DIR` / `PENPLOT_TTF_DIR`），在临时目录运行不再污染仓库。
- 删除提交进来的测试产物（`test_out_*.gcode`、`test_preview.svg`）。
- 新增 `configs/grbl-zpen.json`（Orange Pi 上 GRBL 1.1f 写字机：Z 轴步进，`Z0` 抬笔（静止位）/ `Z8` 落笔（Z+ 向下压），
  坐标沿用原软件默认：原点左上、Y 向下为负——上机前请用小图确认方向）。
