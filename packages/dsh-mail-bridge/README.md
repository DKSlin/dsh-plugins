# dsh-mail-bridge

把每轮回复和每个待答问题用邮件推到手机；在手机上直接回复那封邮件，对应会话就继续工作。

插件是纯 Host 侧的观察者：不注册任何工具，也不进入模型上下文。

## 两个方向

| 方向 | 触发 | 动作 |
| --- | --- | --- |
| 出 | `session/event` 的 `turn/end` | 取该轮最后一条 assistant 消息的 `text` 块（不含推理内容），发一封带短码的邮件 |
| 出 | `user-questions/request` | 把问题与选项按序号发出，agent 继续阻塞等待，Web UI 一侧不受影响 |
| 入 | IMAP 轮询到新邮件 | 按短码找回会话；待答问题走 `userQuestions.answer()`，否则走 `sessionController.prompt()` |

只有顶层会话会推送，子 agent 的轮次不会打扰你。

## 配置

两种方式，任选其一：

**1. 设置页（推荐）**：在「插件管理 → 邮件桥」里直接填写并保存。四个字段分别是发信邮箱、发信授权码、通知接收邮箱、白名单，保存后邮件通道会自动重启。

**2. 配置文件**：放在 **profile 目录**的 `mail-bridge.json`，不在插件包里，也不在仓库里：

```
<profile 目录>/mail-bridge.json        # 例：~/.dsh/profiles/<profile>/mail-bridge.json
```

把 [`mail-bridge.example.json`](mail-bridge.example.json) 复制过去改名即可。最简形式只有四项：

```json
{
  "sender": "bot@example.com",
  "password": "邮箱授权码",
  "notifyTo": "you@example.com",
  "whitelist": "you@example.com, another@example.com"
}
```

设置页保存的值优先于该文件；文件里留空的字段会被设置页的值覆盖，反之亦然（空值不覆盖）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `sender` | 必填 | 发信邮箱，同时用于 IMAP 收信 |
| `password` | 必填 | 邮箱**授权码**，不是登录密码；支持 `env:NAME` 引用环境变量 |
| `notifyTo` | 必填 | 接收通知的邮箱 |
| `whitelist` | `[notifyTo]` | 允许驱动会话的发件地址，逗号或换行分隔；可填多个 |
| `enabled` | `true` | 关闭时插件立即空闲 |
| `pollMs` | `45000` | IMAP 轮询间隔，最小 15000 |
| `maxChars` | `0` | 字符上限，`0` 表示不限制，远程阅读可保留完整回复 |
| `topLevelOnly` | `true` | 只推顶层会话 |
| `startupNotify` | `true` | 启动时发一封自检邮件 |
| `failureNotify` | `true` | 回灌失败时回信说明原因 |

`sender` / `password` / `notifyTo` / `whitelist` 是扁平写法；`smtp`、`imap`、`to`、`from` 等嵌套写法同样有效，适合改端口或换服务商。行 config（`cordis.patch.yml`）优先级最高，但**不建议**把授权码写在那里。

## 邮件长什么样

```
[DSH:ab12] 本轮回复完成 · 插件调研

本轮回复完成（插件调研）

<最后一段回复>

--- 以下为原始通知，回复时无需删除 ---
[DSH:ab12]
```

手机上点「回复」，写下指令直接发送即可。插件会在正文里找 `[DSH:ab12]`，取它之前的内容，并把各客户端的引用头、`>` 前缀、签名一并剥掉。主题里的短码同时承担路由，因此同一个会话的通知会自然形成一条邮件线程。

短码由会话 ID 派生并持久化在 `~/.dsh/mail-bridge.state.json`，重启后仍可回复旧通知。

## 安全

这本质是一个远程驱动本机 agent 的入口，因此：

- 只接受 `whitelist` 中的发件地址，其余邮件直接丢弃并标记已读；
- 白名单校验在任何解析之前完成；
- 短码只映射已存在的会话，不存在时回一封说明而不会创建会话。

## 限制

- 依赖轮询，回复到进入会话有最长一个 `pollMs` 的延迟。
- QQ 邮箱需要在设置里开启 IMAP/SMTP 服务并生成授权码，不能使用登录密码。
- 只处理纯文本与简单 HTML 正文，不解析附件。
