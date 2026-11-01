# 写字机工作台 · 使用手册

这份手册和网页里的「帮助」（`/help`）是同一份内容。源文件在 `webui/src/features/help/articles/`，改完后复制到这里：

```
cp webui/src/features/help/articles/*.md docs/manual/
```

| 章节 | 内容 |
|---|---|
| [快速开始](01-quick-start.md) | 连接、调笔、放纸设原点、写第一张 |
| [名词解释](02-glossary.md) | 原点、走边框、抬笔/落笔、G 代码、行程、抖动、种子、单线字体 |
| [纸张与位置](03-paper.md) | 选纸、放纸、原点与纸的关系、写歪了怎么办 |
| [字体与缺字](04-fonts.md) | 选字体、缺字方框、导入字体、字号 |
| [图片描线](05-image-trace.md) | 边缘 / 骨架 / 点阵三种描线方式 |
| [批量信件](06-batch.md) | 变量、表格、换纸、示例数据 |
| [多人使用与控制权](07-multi-user.md) | 角色、控制权、同时编辑 |
| [电传打字机](08-teletype.md) | 演示程序的两种模式和启动方法 |
| [故障排除](09-troubleshooting.md) | 连接、断线、WiFi、笔压、偏移、预览不一致、ALARM 与 error 码表 |
| [安全须知](10-safety.md) | 急停、运动安全、网络安全 |
| [API 入门](11-api.md) | 令牌、curl / Python 示例、WebSocket |

第一次使用请在网页里打开 **设置向导**（`/welcome`）。

文中的链接（如 `/help/glossary#origin`）指向网页帮助中心。章节标题后的 `{#anchor}` 是网页里的锚点名。
