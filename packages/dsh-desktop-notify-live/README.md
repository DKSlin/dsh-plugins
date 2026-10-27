# 桌面通知（desktop-notify）

在两种时刻弹出 **Windows 右下角气泡**，并播放 **叮咚**（系统「通知」音效）：

1. 我调用 `ask_user_question` 问你问题时；
2. 一轮对话结束时（正常完成 / 达到输出上限 / 本轮出错）。

只在本地弹通知，不联网、不改会话内容、不影响回答流程。

## 行为细节

- **提问**：气泡内容为 `需要你回答：<第一个问题>`，多问题会注明「共 N 个问题」。监听 `user-questions/request` 瀑布流时用 `prepend` 排在最前，只观察不拦截，随后原样 `next()`。
- **本轮完成**：监听持久化的 `session/event` 里的 `turn/end`，从 `session-title` 服务读会话标题附在气泡第二行。`aborted` / `blocked`（你自己中止的）默认不打扰。
- **范围**：默认只通知顶层会话（`topLevelOnly: true`），子 agent 不弹。**所有**顶层会话都会弹，包括其他正在进行的对话——因为它们都是真实完成的回合。若嫌吵，见下方配置。
- **声音**：气泡本身设为静音，叮咚由脚本单独播放 `%WINDIR%\Media\Windows Notify System Generic.wav`，所以即使关掉「通知声音」也还能听到；方案为 None 时无声音。
- **重复抑制**：同一会话同一类事件 700ms 内只发一次。

## 配置

默认值写在 bundle 的 `cordis.patch.yml`；在 profile 的 `cordis.patch.yml` 里用同一 row id 覆盖即可（改完须重启 DSH 才生效）：

```yaml
- id: desktop-notify-live
  config:
    notifyOnQuestion: true      # 提问时通知
    notifyOnTurnEnd: true       # 回合结束时通知
    notifyOnError: true         # 回合出错时通知
    sound: true                 # 叮咚
    soundFile: ''               # 换成任意 .wav
    topLevelOnly: true          # 只通知顶层会话
    skipWhenFocused: false      # true = 窗口在前台时不打扰
    questionMaxChars: 120
    titleMaxChars: 60
    minIntervalMs: 700
    appId: com.deepseek.dsh     # Windows 通知归属的 AppUserModelID
    icon: ''                    # 默认用 DSH 安装目录的 icon.png
    enabled: true
```

`skipWhenFocused: true` 会通过 Win32 `GetForegroundWindow` 判断前台进程是否为 DSH，是则完全静默。

## 依赖与卸载

- 只用 Node 内置模块 + Windows 自带的 `powershell.exe`（5.1，WinRT Toast + SoundPlayer），无 npm 依赖。
- 安装：`dsh plugin --profile <profile> add dsh-desktop-notify-live`，或在插件市场里一键安装；它通过自带的 `cordis.patch.yml` 进入 profile 的 bundle 层。
- 卸载：Plugins 页移除「桌面通知」bundle，或 `dsh plugin ... remove dsh-desktop-notify-live`。

## 排障

- 收据日志：`%TEMP%\dsh-desktop-notify.log`，每次弹窗/加载各一行；有 `plugin loaded` 说明插件在当前进程生效，有 `shown=True` 说明 Toast API 接受。
- 没气泡：检查 Windows 设置 → 通知 → DeepSeek Harness 是否开启、勿扰模式是否打开；或手动跑：
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title Test -Body Hello`
- 没声音：检查声音方案与音量；`-NoSound` 可静音测试。
- 一次更新后代码不生效：Host 的插件模块不可热替换，改动 `index.js` 后需重启 DSH（或在 Plugins 页重装为新 bundle 名）。
