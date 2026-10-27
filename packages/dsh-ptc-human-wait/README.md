# dsh-ptc-human-wait

`run_code` 里嵌套调用 `ask_user_question` 等人回答时，**暂停执行超时**。

`ask_user_question` 的阻塞模式会一直等你回答，但它作为嵌套工具跑在
`run_code` 程序内部，而 PTC 运行时的执行超时把这段等待也算在内。
回答得慢一点，整个程序就会以 `execution deadline reached (120000ms)`
被杀掉，问题本身也被中断。

这个插件把运行时自己的墙钟计时器换成等价的一个，只在
`ask_user_question` 正在派发期间暂停。从不提问的程序仍然按原定
deadline 被终止（默认 120 秒）；等待人工回答的时间不再计入。

## 安装

```sh
dsh plugin --profile <profile> add dsh-ptc-human-wait
```

或从仓库直接安装：

```sh
dsh plugin --profile <profile> add github:DKSlin/dsh-plugins#path:/packages/dsh-ptc-human-wait
```

装好后出现在「设置 → 插件」里，可随时停用。

## 注意

- 它替换的是 PTC 运行时的执行计时器，依赖该运行时内部结构。
  宿主升级后如果计时逻辑变了，插件可能失效——那种情况下它不会
  破坏原有超时，只是失去暂停能力。
- 它不改变 `ask_user_question` 自己的行为，也不影响工具的审批超时。

## 许可

MIT

