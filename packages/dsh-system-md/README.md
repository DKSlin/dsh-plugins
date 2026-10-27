# System-md — 项目自有的系统提示词

让**工程目录里的一个文件整体接管系统提示词**（Pi 的做法），不再被内置提示词干扰。

放文件 = 覆盖；不放文件 = 一切照旧。没有全局副作用。

## 用法

在工程目录（会话的工作目录，或其任意上级目录）放：

```
你的项目/
├── .git/
├── .dsh/
│   └── SYSTEM.md      ← 这个文件的内容 = 该项目的完整系统提示词
└── src/
```

然后在该目录下**新建一个会话**（已存在的会话不受影响）。`.pi/SYSTEM.md` 同样被识别，两个都存在时 `.dsh/` 优先。

## 查找规则

- 从会话工作目录开始，**最近的**候选文件优先
- 逐级向上查找，遇到带 `.git` 的目录（工程根）就停止，不会串到无关的上级目录
- 最多向上 8 层，单文件超过 256 KiB 截断

## 生效时机

- 在 **agent 创建时**决定是否覆盖 → 改完需要新开一个会话；同一会话内切换工作目录不重算
- 文件**内容**在每次装配模型请求时重新读取 → 改 `SYSTEM.md` 立刻生效，无需重启或新建会话
- 文件被删除时沿用最后一次成功读取的内容，避免提示词突然变空

## 配置（`cordis.patch.yml` 里的行 config，全部可选）

| 字段 | 默认值 | 含义 |
|---|---|---|
| `files` | `['.dsh/SYSTEM.md', '.pi/SYSTEM.md']` | 候选文件名，按顺序、就近匹配 |
| `searchAncestors` | `true` | 是否向上级目录查找 |
| `projectRootMarkers` | `['.git']` | 命中的目录检查完后停止向上查找 |
| `maxDepth` | `8` | 最多向上几层（`0` = 只看工作目录） |
| `maxBytes` | `262144` | 单文件截断字符数 |
| `ignoreEmptyFile` | `true` | 空文件/纯空白 → 不覆盖，保留内置提示词 |
| `keepRuntimeContext` | `true` | 保留沙箱/审批策略/时间等运行时快照 |
| `applyToSubagents` | `false` | 是否同样覆盖子 agent（默认只覆盖顶层会话） |
| `excludePresets` | `['minimal']` | 跳过这些预设 |
| `sectionName` | `'project:system-md'` | 注册到提示词注册表里的 section 名 |

## 覆盖范围与边界

**被覆盖的**：harness identity、部署 persona（前缀与后缀）、第一方工具使用指导、plan-mode 段落、技能说明、以及任何其他插件注册的提示词 section。

**不被覆盖的**：

- **工具 schema 仍然发送**。这是协议层的能力声明，模型必须知道有哪些工具可调；它不属于提示词文本。
- `AGENTS.md` / `CLAUDE.md` 与技能目录是以 **user 角色的 system-reminder 消息**注入的，不是系统提示词。要彻底干净，需要在预设里把 `agent-instructions`、`skill-*`、`tool-skill` 这些行去掉或禁用。
- `keepRuntimeContext: false` 才会连沙箱/审批策略快照一起去掉。

## 已知冲突

`minimal` 预设自带一个 `complete: true` 的 persona；一次装配里出现两个 complete section 会直接报错，因此 `minimal` 默认在 `excludePresets` 里。若你在别的预设里也挂了 `complete: true` 的 persona，把它加进 `excludePresets`。

## 实现

监听 `agent/created`，在该 agent 自己的作用域上用 `ctx.systemPrompt.section({ complete: true, interpolate: false, text })` 注册**唯一一个** section，`text` 是每次装配都会重新读文件的回调。

全程不劫持 `system-prompt/assemble` 瀑布流，所以其他插件的注册原封不动，只是在文件生效期间不被渲染。只用 Node 内置模块，没有运行时依赖。

## 安装

```sh
dsh plugin --profile <profile> add dsh-system-md
```

插件市场里搜索 `dsh-system-md` 一键安装也可以。从仓库装（未发 npm 时）：

```sh
dsh plugin --profile <profile> add github:DKSlin/dsh-plugins#path:/packages/dsh-system-md
```

装好后出现在「设置 → 插件」里，可随时停用或卸载；它通过自带的
`cordis.patch.yml` 进入 profile 的 bundle 层，不需要手工编辑 profile。

开发时也可以直接把本目录 `link:` 进 profile 的 `dependencies`，再把它加进
`dsh.profile.bundles`。

## 验证

1. 在某个工程里放 `.dsh/SYSTEM.md`
2. 该工程下**新建**一个任务（已存在的会话保持创建时的提示词）
3. 问它「你的系统提示词第一行是什么」→ 应该就是你文件里的内容

## 许可

MIT

