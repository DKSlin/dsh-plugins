# dsh-plugins

DeepSeek Harness (dsh) plugins, one package per directory under `packages/`.

| Package | What it does |
| --- | --- |
| [`dsh-system-prefix`](packages/dsh-system-prefix) | Prepends one configurable sentence to a new top-level session's system prompt without replacing anything else. |
| [`dsh-system-md`](packages/dsh-system-md) | A project's `.dsh/SYSTEM.md` replaces the whole built-in system prompt for that project's sessions. |
| [`dsh-ptc-human-wait`](packages/dsh-ptc-human-wait) | The `run_code` execution deadline pauses while a nested `ask_user_question` waits for the user. |
| [`dsh-desktop-notify-live`](packages/dsh-desktop-notify-live) | Windows toast notification and a ding when the agent asks a question or a turn finishes. |
| [`dsh-mail-bridge`](packages/dsh-mail-bridge) | Emails each finished turn and every pending question to your phone; replying to the email continues the session. |

## Install

These packages are not published to npm, so install them from this repository:

```sh
dsh plugin --profile web add github:DKSlin/dsh-plugins#path:/packages/dsh-system-prefix
dsh plugin --profile web add github:DKSlin/dsh-plugins#path:/packages/dsh-system-md
dsh plugin --profile web add github:DKSlin/dsh-plugins#path:/packages/dsh-ptc-human-wait
dsh plugin --profile web add github:DKSlin/dsh-plugins#path:/packages/dsh-desktop-notify-live
dsh plugin --profile web add github:DKSlin/dsh-plugins#path:/packages/dsh-mail-bridge
```

Once a package is listed in the plugin market, installing it from the market uses
the same GitHub source.

Each package declares `dsh.bundle` with its own `cordis.patch.yml`, so it lands
in the profile's bundle layer and can be enabled or disabled from the plugin
list without editing the profile by hand.

## Layout

```
packages/<name>/
  package.json        name, version, dsh.bundle, peerDependencies
  cordis.patch.yml    the row this bundle inserts into a profile
  index.js            the cordis plugin itself
```

## License

MIT — see [LICENSE](LICENSE).

