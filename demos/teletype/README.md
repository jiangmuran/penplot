# 电传打字机 demo（纸上终端）

Orange Pi 上跑服务、驱动 GRBL；电脑浏览器负责键盘输入和监控。仅依赖标准库 + pyserial。

- **打字模式**：每按一个键就立刻写到纸上；退格 = 字车回退一格（下一个字叠打），回车换行。支持中文输入法，全角标点会自动转成 ASCII。
- **终端模式**：Orange Pi 上运行一个真正的交互式 bash（PTY），浏览器里是完整的 xterm.js 终端，ssh、python、top 等都能用。纸上同步抄写整个会话：
  - 回显和普通输出逐字实时写出。
  - 退格、`\r`、readline 重绘改写过的格子等这一行结束后再统一叠打；被删掉的字补一道「/」。所以进度条只会叠打一次最终结果，不会糊成一团。
  - 全屏程序（vim、top、less 这类使用备用屏幕的）在纸上只记一行 `[full-screen program - not printed]`。
  - PTY 的宽度等于纸面列数，程序会按纸宽自动换行。
  - 如果等待书写的字超过「积压上限」，后面的输出就不再上纸，之后补一行 `[... N chars not printed ...]`。
- 纸面按字符网格排版：A4、字高 3 mm 时是 80 列 × 58 行。页写满后，笔回原点并提示换纸，后面的输出会先缓存，换纸后接着写。
- 网页上的纸面预览：灰色是已排队，深蓝是已发给控制器，红圈是笔的实时位置（GRBL `?` 查询，5 Hz）。

```bash
# 在写字机控制板（如 Raspberry Pi / Orange Pi）上，假设代码在 $REPO
systemd-run --unit=teletype --working-directory=$REPO \
    $REPO/.venv/bin/python -u demos/teletype/teletype.py
journalctl -u teletype -f          # 看访问地址（带 ?k= 访问密钥）
systemctl stop teletype            # 释放串口

# 本机无硬件试用
.venv/bin/python demos/teletype/teletype.py --port fake
```

启动时把笔当前所在位置设为原点（笔应停在纸左上角、抬起），也可以用网页上的点动 + ⌖ 重新设定。
参数：`--char-h` 字高、`--feed` 书写速度（GRBL 会按 $110 限速）、`--z-up` 字间行进时的抬笔高度、`--paper W H`、`--margin`、`--max-backlog`。

`static/` 里放的是 xterm.js 6.0.0（MIT 许可），已经随项目附带，Pi 不需要联网。

速度：笔是 Z 轴步进，每一笔都要 Z0↔Z8 来回一次，这是主要耗时。字体是自制的等宽单笔画 ASCII 体（`font.py`），平均每个字 1.19 笔。如果实测笔尖抬 3–4 mm 就离开纸面，把「行进抬笔 Z」调大，可以明显提速。

安全：终端模式是服务进程用户（root）的完整交互式 shell。访问密钥保存在 `~/.teletype_key`，只适合在局域网里演示。
