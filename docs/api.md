# penplot Web 工作台 API 使用说明

本文写给想用脚本控制写字机的人。完整的接口定义在设备上的 `http://<设备IP>:8080/api/v1/docs`
（Swagger，需要登录，页面资源从 CDN 加载），离线版本在仓库的 `docs/design/openapi.json`。
各数据结构的 JSON 样例见 `docs/design/04-contract-notes.md`。

- 基础地址：`http://<设备IP>:8080/api/v1`
- 下面的示例用 `192.168.1.50` 代表设备地址，请换成你的控制盒的 IP 或主机名
- 数据格式：JSON，长度单位毫米，时间是 Unix 秒（浮点数）
- 错误统一返回 `{"error":{"code":"...","message":"...","detail":...}}`，脚本请按 `code` 判断，`message` 是给人看的中文说明

## 1. 首次设置

设备第一次启动时还没有管理员。这时除 `/auth/state`、`/auth/setup`、`/system/health` 外，所有接口都返回
`423 setup_required`。

服务启动时会生成一个 8 位初始化码，有两种方式查看：

```bash
ssh root@192.168.1.50 cat /var/lib/penplot/setup-code
ssh root@192.168.1.50 "journalctl -u penplot-web | grep 'setup code'"
```

用初始化码创建第一个管理员（用户名默认 `admin`，密码至少 10 个字符）：

```bash
curl -c cookies.txt -H 'X-Penplot: 1' -H 'Content-Type: application/json' \
  -d '{"setup_code":"<8位初始化码>","password":"至少十个字符的密码"}' \
  http://192.168.1.50:8080/api/v1/auth/setup
```

忘记密码时，在板子上执行 `/opt/penplot/venv/bin/python -m penplot.web reset-password [--user 用户名]`，
命令会生成一个随机新密码并打印出来，同时注销这个用户的所有会话；加 `--password 新密码` 可以直接指定密码。

## 2. 认证

有两种方式：

| 方式 | 用法 | 适合 |
|---|---|---|
| Cookie 会话 | `POST /auth/login {"password"}` 后服务器设置 `pp_session`，30 天内有效，使用时自动续期 | 浏览器、临时调试 |
| API Token | 请求头 `Authorization: Bearer ppt_<id>_<secret>` | 脚本、自动化 |

**用 Cookie 时，所有 POST/PUT/PATCH/DELETE 请求都必须带请求头 `X-Penplot: 1`**，否则返回
`403 csrf`。这是防跨站请求伪造（CSRF）的措施。用 Bearer Token 的请求不需要这个头。

登录失败有频率限制：同一个 IP 5 分钟内错 5 次就会被锁定一段时间（从 30 秒起按次加倍，最长 15 分钟），
期间返回 `429 rate_limited`，`detail.retry_after_s` 是还要等的秒数。

### 2.1 创建 Token

```bash
# 先登录
curl -c cookies.txt -H 'X-Penplot: 1' -H 'Content-Type: application/json' \
  -d '{"password":"你的密码"}' http://192.168.1.50:8080/api/v1/auth/login

# 创建一个有 read+control 权限、90 天过期的 token（token 只显示这一次）
curl -b cookies.txt -H 'X-Penplot: 1' -H 'Content-Type: application/json' \
  -d '{"name":"脚本","scopes":["control"],"expires_days":90}' \
  http://192.168.1.50:8080/api/v1/auth/tokens
# => {"id":"a1b2c3d4","token":"ppt_a1b2c3d4_xxxxxxxx", ...}
```

权限范围（scope）：

| scope | 能做什么 |
|---|---|
| `read` | 查看状态、字体、工程、任务，渲染预览 |
| `control` | 在 read 基础上：操作机器（点动、抬落笔、设零、急停）、创建和控制任务、编辑工程和文件 |
| `admin` | 全部操作，包括原始 G 代码命令、`$$` 写入、机器配置、用户管理、重启服务 |

`control` 自动包含 `read`，`admin` 包含全部。Token 属于创建它的用户，权限不会超过该用户的角色。
吊销 Token：`DELETE /auth/tokens/{id}`。

### 2.2 多用户与控制权

用户有三种角色：**管理员**（admin）、**操作员**（operator，能控制机器和编辑项目）、**只读观察**（viewer）。
管理员通过 `POST /users {"username","password","role"}` 加用户，通过 `POST /users/{id}/password` 重置密码。
登录时带上用户名：`{"username":"ann","password":"…"}`。

同一时间只有一个人持有机器的**控制权**（lease）：

```bash
curl -H "$AUTH" $PP/machine/lease                      # 谁在控制
curl -H "$AUTH" -X POST $PP/machine/lease              # 申请；被别人占着时返回 409 lease_held
curl -H "$AUTH" -X DELETE $PP/machine/lease            # 释放
```

点动、抬落笔、设零、开始/暂停/停止任务、电传打字都要求持有控制权。控制权空着时，第一个操作的人会自动拿到。
管理员可以强制接管（`{"force":true}`）。持有者离线并且 60 秒没有任何操作后，控制权自动释放。
**急停对所有登录用户都可用**，包括只读观察。

后面的例子都假定已经设置好：

```bash
export PP=http://192.168.1.50:8080/api/v1
export AUTH="Authorization: Bearer ppt_a1b2c3d4_xxxxxxxx"
```

## 3. 常用操作（curl）

### 3.1 机器状态与手动控制

```bash
curl -H "$AUTH" $PP/machine/status                 # 连接、状态、坐标、笔状态、origin_valid
curl -H "$AUTH" -X POST $PP/machine/connect        # 按当前配置的串口连接
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST -d '{"state":"up"}' $PP/machine/pen
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST \
  -H 'Idempotency-Key: 6f1c...' -d '{"dx":5,"dy":0}' $PP/machine/jog        # 单次 ≤50 mm
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST -d '{"axes":"xy"}' $PP/machine/zero
curl -H "$AUTH" -X POST $PP/machine/goto-origin    # 先抬笔再回原点
curl -H "$AUTH" -X POST $PP/machine/estop          # 急停：任何状态都可用
```

几点说明：

- **原点**：笔在开工时的位置就是原点（Z0 为抬笔静止位）。开始任务时只会把 XY 设零，不会动 Z 的基准。
  重新连接、复位或发生 ALARM:3 后笔的高度未知，开始任务会返回 `409 pen_unknown`：先用 Z 点动把笔抬起来，
  再调用 `POST /machine/zero {"axes":"xyz"}`。
- **安全检查**：创建任务时会剥掉 G 代码里的注释。含有 `! ~ ?`、非 ASCII 字符或 `$` 命令的行会被拒绝
  （`400 unsafe_gcode`）。空走超出工作区、Z 超出抬落笔范围、含有 G28/G53 的任务不能直接开始
  （`409 out_of_work_area`），只有管理员可以加 `{"allow_out_of_bounds":true}` 强制开始。
- 任务进行中，手动操作会返回 `409 machine_busy`。软暂停后等缓冲走完（`busy=false`）就可以点动；
  恢复时机器会先回到暂停时的位置。
- 点动、设零、原始命令这类非幂等请求可以带 `Idempotency-Key`（随机 UUID）。网络超时重试时，
  30 秒内同一个 key 只执行一次。

### 3.2 打印一个 G 代码文件

```bash
# 导入（同时得到分析结果：行数、范围、预计时间、警告）
curl -H "$AUTH" -F file=@heart.gcode $PP/import/gcode
# => {"file":{"id":"f12",...},"analysis":{"lines":812,"est_s":95.2,...}}

# 创建任务并立即开始（默认在当前笔位置设零）
curl -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"source":{"file_id":"f12"},"start":true}' $PP/jobs

curl -H "$AUTH" $PP/jobs/current                                 # 进度、预计剩余时间
curl -H "$AUTH" -H 'Content-Type: application/json' -X POST -d '{"mode":"soft"}' $PP/jobs/j7f3a2c1/pause
curl -H "$AUTH" -X POST $PP/jobs/j7f3a2c1/resume
curl -H "$AUTH" -X POST $PP/jobs/j7f3a2c1/stop                    # 抬笔、回原点
```

暂停有两种模式：`soft` 把已经缓冲的动作走完，然后抬笔停下，会有几秒延迟；`hold` 立即减速停住，笔保持原位。

任务失败后，`can_retry_from` 是建议的续打行号：

```bash
curl -H "$AUTH" -H 'Content-Type: application/json' -d '{"from_line":1200}' $PP/jobs/j7f3a2c1/retry
```

只有原点仍然有效（期间没有复位或重新连接）时才能从中间续打，否则返回 `409 origin_invalid`。

### 3.3 写一段文字

```bash
curl -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"床前明月光，疑是地上霜。","font_id":"penplot-sans","paper":{"paper_id":"a4-normal"},"seed":42}' \
  "$PP/render/text?wait=10"
# => {"rid":"r9c2","pages":[{"index":0,"est_s":120.5,"gcode_lines":2311,...}]}

curl -H "$AUTH" "$PP/render/r9c2/pages/0/preview.svg" -o preview.svg
curl -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"source":{"render_id":"r9c2","page":0},"start":true}' $PP/jobs
```

渲染在后台进程里执行。`?wait=N` 表示最多等 N 秒：在这之内完成就返回 `200` 和结果；超时则返回
`202 {"task_id":...}`，之后用 `GET /tasks/{task_id}` 轮询，或者在 WebSocket 上等 `task` 消息。
渲染结果放在内存缓存里，过一段时间会被清理，访问已清理的 `rid` 会返回 `404 render_expired`，重新渲染即可。

查字体：`GET /fonts?q=宋`；查哪些字体缺字：`GET /fonts?covers=要写的字`（结果里每个字体带 `missing` 列表）。

### 3.4 工程与批量

```bash
curl -H "$AUTH" -H 'Content-Type: application/json' -d '{"name":"贺卡"}' $PP/projects
curl -H "$AUTH" -F file=@名单.csv $PP/import/table                 # => file.id = f30
curl -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"data_file_id":"f30","mapping":{"name":"姓名"},"name_pattern":"{{name}}"}' \
  "$PP/projects/p01/batch?wait=60"
# => {"batch_id":"b1","jobs":["j1","j2",...]}
curl -H "$AUTH" -X POST $PP/batches/b1/start-next   # 每换一张纸调一次
```

批量任务不会自动开始下一张（需要换纸）。如果是自动进纸的机器，可以在设置里打开
`batch_auto_advance`（`PATCH /settings`）。

### 3.5 电传打字机（纸上终端）

```bash
curl -H "$AUTH" -H 'Content-Type: application/json' -d '{"char_h":3,"paper":{"paper_id":"a4-normal"}}' $PP/teletype/session
curl -H "$AUTH" -H 'Content-Type: application/json' -d '{"text":"Hello, 纸上终端！\n"}' $PP/teletype/type
curl -H "$AUTH" -X POST $PP/teletype/newpage           # 页写满（409 need_paper）后换好纸调用
curl -H "$AUTH" -X DELETE $PP/teletype/session
```

会话期间机器归电传占用，不能开始任务，急停照常可用。终端模式（网页上的 shell）默认关闭，
只有管理员在设置里打开 `teletype.terminal_enabled` 后才能用，每次使用都会记入审计。

### 3.6 自检与故障恢复

`POST /system/diagnostics` 会检查串口、固件、`$$` 参数是否合理、状态查询延迟、WiFi、磁盘、内存、温度、
字体和时钟，每一项都带修复建议。加 `{"pen_test":true,"confirm":true}` 会顺带做一次落笔、抬笔测试。
`GET /machine/recovery` 根据当前状况（断线、报警、原点失效、上个任务失败）给出下一步该做什么，
每一步都附带可以直接调用的 API。

## 4. WebSocket 实时消息

地址：`ws://<设备IP>:8080/api/v1/ws`

- 浏览器：同源连接时自动带上会话 Cookie。
- 脚本：在子协议里带 Token，`Sec-WebSocket-Protocol: penplot.v1, bearer.ppt_...`。
  Token 不要放在 URL 查询参数里，否则会被记进日志。

连接成功后，服务器先发一条 `hello`，里面的 `snapshot` 包含机器、当前任务和后台任务的完整状态。
每次重连都应该用它重置本地状态。之后推送这些消息：

| type | 内容 | 频率 |
|---|---|---|
| `status` | 机器状态（同 `GET /machine/status`） | 任务中 ≤4 次/秒，空闲时有变化才发，另有 5 秒心跳 |
| `progress` | 任务进度：已确认行、总行数、百分比、预计剩余时间、当前坐标 | 2 次/秒 |
| `job` | 任务状态变化 `{job_id, from, to, reason, job}` | 每次变化 |
| `alarm` / `error` | GRBL 报警 / `error:N` 回复 | 发生时 |
| `task` | 后台任务（渲染、转换）进度和结果 | 发生时 |
| `log` | 串口收发记录（需要先订阅） | 每 200 ms 一批 |
| `system` | CPU、温度、内存、WiFi 信号 | 每 5 秒 |
| `notice` | 服务关闭、重启、原点失效、串口断开等提示 | 发生时 |
| `gap` | 客户端太慢，有消息被丢掉：请重新拉取 `/jobs/current` 和 `/machine/status` | — |
| `attention` | 需要人处理的事：写完、换纸、报警、出错、断线后自动暂停、控制权变化。带 `code`、中文 `message`、`sound` | 发生时 |
| `presence` / `lease` | 谁在线、在看哪个页面；控制权变化 | 变化时 |
| `project` / `locks` | 你正在看的工程被别人改了、元素锁 | 变化时 |
| `teletype` | 电传：排队的字、已写完、笔位置、换纸 | 发生时 |

客户端可以发送：

```json
{"type":"subscribe","topics":["status","progress","job","alarm","error","task","system","log"]}
{"type":"cmd","id":"k1","op":"estop","args":{}}
{"type":"cmd","id":"k2","op":"pause","args":{"mode":"hold"}}
{"type":"cmd","id":"k3","op":"jog","args":{"dx":1,"dy":0,"seq":17}}
{"type":"ping","t":1761900000.0}
```

`cmd` 的执行结果通过 `{"type":"ack","id":"k1","ok":true|false,"error":{...}}` 返回，规则和对应的 REST 接口相同，
需要 `control` 权限。网络不好时，急停优先走已经建立的 WebSocket，这样不用等新的 TCP 连接。

Python 示例：

```python
import asyncio, json, websockets

TOKEN = "ppt_a1b2c3d4_xxxxxxxx"

async def main():
    async with websockets.connect("ws://192.168.1.50:8080/api/v1/ws",
                                  subprotocols=["penplot.v1", "bearer." + TOKEN]) as ws:
        hello = json.loads(await ws.recv())
        print("机器:", hello["snapshot"]["machine"]["state_text"])
        async for raw in ws:
            m = json.loads(raw)
            if m["type"] == "progress":
                d = m["data"]
                print("%.1f%%  剩余 %s 秒" % (d["percent"], d["eta_s"]))
            elif m["type"] == "job" and m["data"]["to"] in ("done", "failed", "aborted"):
                print("任务结束:", m["data"]["to"], m["data"]["reason"])
                break

asyncio.run(main())
```

关闭码：`4401` 未登录，`4423` 还没初始化，`1013` 客户端太慢被断开。

## 5. 常见错误码

| HTTP | code | 含义 |
|---|---|---|
| 401 | `unauthenticated` / `bad_password` / `bad_token` | 没登录、密码错、Token 无效 |
| 403 | `csrf` / `csrf_origin` / `forbidden` | 缺少 `X-Penplot` 头、来源不对、权限不够 |
| 409 | `machine_busy` | 任务进行中，手动操作被拒绝 |
| 409 | `job_active` | 已经有任务在进行 |
| 409 | `origin_invalid` | 原点无效，需要重新设零 |
| 409 | `port_busy` | 串口被别的进程占用（比如命令行的 `penplot print`） |
| 409 | `rev_conflict` | 工程在别处被改过，需要先刷新 |
| 423 | `setup_required` | 还没设置管理员 |
| 429 | `rate_limited` | 登录尝试次数过多 |
| 501 | `feature_unavailable` | 设备上没装这个功能需要的可选依赖 |
| 503 | `machine_disconnected` | 机器没有连接 |

## 6. 安全提示

设备只走局域网 HTTP，没有加密。同一 WiFi 下被入侵的设备有可能截获密码和 Cookie。建议：

- 不要把端口直接映射到公网。需要远程访问时用 Cloudflare Tunnel 等反向隧道并在前面加一层访问控制
  （如 Cloudflare Access），见 README「远程访问」一节。经隧道来的请求会被标记为远程，电传打字机的终端模式拒绝远程用户。
- 脚本使用权限最小的 Token（只读就用 `read`），不用的 Token 及时吊销。
- 需要加密时，可以设置 `PENPLOT_TLS_CERT` 和 `PENPLOT_TLS_KEY` 启用自签名 HTTPS，但手机浏览器会提示证书警告。
