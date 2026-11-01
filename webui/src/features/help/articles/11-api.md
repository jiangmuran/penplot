# API 入门
> 用脚本控制写字机：令牌、渲染、打印、实时状态。
<!-- keywords: API 接口 脚本 自动化 令牌 token curl python websocket REST 开发 -->

完整的接口文档在 [API 文档](/api/v1/docs)（自动生成，可直接在网页里试）。

## 1. 创建令牌 {#token}

**设置 → API 令牌 → 新建**，选权限：

- `read`：只读（状态、任务、预览）
- `control`：控制机器、打印
- `admin`：管理（用户、配置）

令牌形如 `ppt_xxxx_yyyy`，只显示一次，请立即保存。

## 2. 发请求 {#request}

所有请求的地址都以 `/api/v1` 开头，带上令牌：

```
TOKEN=ppt_xxxx_yyyy
HOST=http://192.168.1.50:8080    # 换成控制盒的地址
curl -H "Authorization: Bearer $TOKEN" $HOST/api/v1/machine/status
```

## 3. 写一段文字 {#print-text}

先渲染，再用渲染结果创建任务：

```
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"你好，世界","font_id":"xxn6900_kvenjoy_小晓宁","paper":{"paper_id":"a4-normal"}}' \
  "$HOST/api/v1/render/text?wait=10"
# → {"rid":"r9c2", "pages":[{"index":0, "est_s":95.0, ...}]}

curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"source":{"render_id":"r9c2","page":0},"name":"脚本测试","start":true}' \
  $HOST/api/v1/jobs
```

开始前请确认纸和原点已经放好。

## 4. Python 示例 {#python}

```
import requests
S = requests.Session()
S.headers['Authorization'] = 'Bearer ppt_xxxx_yyyy'
B = 'http://192.168.1.50:8080/api/v1'  # 换成控制盒的地址
r = S.post(B + '/render/text', params={'wait': 10}, json={'text': '早上好'}).json()
job = S.post(B + '/jobs', json={'source': {'render_id': r['rid'], 'page': 0}, 'start': True}).json()
print(job['id'], job['status'])
```

## 5. 实时状态 {#websocket}

连接 `ws://<主机>/api/v1/ws`，子协议 `penplot.v1, bearer.<令牌>`，会收到 `status`（机器状态）、`progress`（进度）、`job`（任务状态变化）、`alarm` 等消息。

## 错误格式 {#errors}

出错时统一返回：

```
{"error": {"code": "machine_busy", "message": "任务进行中，手动操作被拒绝", "detail": {...}}}
```

常见：`401` 令牌无效，`403` 权限不够，`409 machine_busy` 机器正忙，`503 machine_disconnected` 未连接。
