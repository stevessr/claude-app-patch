# Claude Desktop Patch — Linux 版

让 Linux 上的 Claude Desktop 接入自定义 API 端点、免登录使用。与 Windows 版三种方案一一对应，
但实现方式不同：Linux 版 Claude Desktop 没有注册表，3P（第三方推理）配置来自下面两处：

| 来源 | 路径 | 说明 |
|---|---|---|
| 用户级（默认） | `~/.config/Claude-3p/configLibrary/<id>.json` + `_meta.json` | 无需 root，即应用内 "Configure Third-Party Inference…" 写入的位置 |
| 系统级（`--system`） | `/etc/claude-desktop/managed-settings.json` | 需要 sudo；必须 root 所有、非 group/world 可写；存在时优先级高于用户级 |

配置是扁平键名的 JSON（`inferenceProvider` / `inferenceGatewayBaseUrl` / `inferenceGatewayApiKey` / `inferenceModels` …），
完整键名见 [官方文档](https://claude.com/docs/third-party/claude-desktop/configuration)。

> 在 **1.49585.0** (Electron 44) 上实测通过；补丁锚点用正则编写，尽量兼容后续版本。

---

## 准备

1. 安装 **Node.js >= 18**
2. 安装 Claude Desktop（AUR `claude-desktop` / 官方 `.deb` / 其它打包均可，脚本会自动寻找 `resources/app.asar`）
3. （可选）配置好端点，脚本 `--from-cli` 会直接复用。读取顺序：**运行时环境变量 > `~/.claude/settings.json` 的 `env`**：
   ```json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "https://your-api.com",
       "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
       "ANTHROPIC_MODEL": "claude-opus-4-6"
     }
   }
   ```
   - `ANTHROPIC_BASE_URL`；`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`，`ANTHROPIC_API_KEY` → `x-api-key` 头
   - 模型列表由 `ANTHROPIC_MODEL` 和 `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`（id）/ `..._MODEL_NAME`（显示名）组合而成，首项为默认模型
   - id 带 `[1m]` 后缀（如 `claude-fable-5-1[1m]`）时会同时设置 `prefer1m: true`，默认选中 1M 上下文变体

## 快速开始

```bash
cd linux
./setup.sh          # 交互菜单
```

或直接用子命令：

```bash
node setup.js config      --from-cli                       # 方案 1，复用 CLI 配置
node setup.js config      --url https://api.example.com --key sk-xxx --models claude-opus-4-6,claude-sonnet-4-6
node setup.js http-patch  --url http://192.168.1.10:8317 --key sk-xxx   # 方案 2
node setup.js full-patch                                    # 方案 3（实验性）
node setup.js status
node setup.js launch
node setup.js uninstall   [--system]
node setup.js patch-asar  --scheme http|full --in app.asar --out patched.asar   # 只打补丁，供打包脚本用
```

> Arch 用户可以直接装打好补丁的包：[arch_lib](https://github.com/stevessr/custom_lib_build) 仓库里的
> `claude-desktop-http-patch`（方案 2）/ `claude-desktop-full-patch`（方案 3），它们用 `patch-asar` 从官方 .deb 构建，
> 装好后用自带的 `claude-desktop-3p-config config --url ... --key ...` 写配置即可。

通用参数：`--from-cli`、`--url`、`--key`、`--auth bearer|x-api-key`、`--models a,b`（逗号分隔；不填则由端点的 `/v1/models` 自动发现）、
`--system`（写 `/etc/claude-desktop/managed-settings.json`）、`--in-place`（方案 2/3：用 sudo 原地替换 `app.asar`，不生成便携副本）。

---

## 三种方案

### ⭐ 方案 1 `config` — 只写配置，不改文件

- **适用**：HTTPS 端点，或 `http://127.0.0.1` / `http://localhost` 端点（Linux 版原生允许 loopback HTTP）
- 写入用户级配置后直接启动官方 Claude Desktop，即进入 3P 模式，**不需要登录**
- 3P 模式使用独立的用户目录 `~/.config/Claude-3p/`，不影响官方登录模式的数据
- 卸载：`node setup.js uninstall`

### 方案 2 `http-patch` — 允许任意 HTTP 端点

- **适用**：非 loopback 的 HTTP 端点（如局域网 `http://192.168.1.10:8317`）
- 未打补丁时应用会报 `must use https (or http on loopback)` 并进入降级模式；补丁去掉这一限制
- 默认把官方安装目录复制到 `linux/claude-portable/`（大多数文件系统上 `cp -a` 会用 reflink，几乎不占空间），
  重新打包 `app.asar` 并生成 `launch.sh`；以后用 `./launch.sh` 启动
- `--in-place`：用 sudo 直接替换 `/usr/lib/claude-desktop/resources/app.asar`（原文件备份为 `app.asar.orig`），软件包升级后需重新执行
- Linux 版 Electron 不校验 asar 完整性，无需翻转 fuse

### 方案 3 `full-patch` — 官方登录模式功能解锁（实验性）

需要 Anthropic 账号登录。Linux 1.49585.0 上 Cowork / Code 等功能已经原生可用且由账号能力和托管配置决定，
Windows 版那套补丁大部分已无对应锚点。本版移植了以下几项：

| 补丁 | 作用 |
|---|---|
| bypass isPackaged gate | 解锁只在开发版可见的特性 |
| sidebarMode → code | 默认打开 Code 侧栏 |
| CLI env 注入 | Claude Code 子进程追加 `~/.claude/settings.json` 的 `env`，走你自己的端点 |
| 去掉 `--model` | 不强制传模型名，交给 CLI 自己的配置 |
| bootstrap 能力注入 + DevTools | 渲染进程拦截 `/api/bootstrap` 把 `seat_tier` 改为 `max` 并补齐 `code/cowork/...` capabilities；F12 / Ctrl+Shift+I 打开 DevTools |
| `--all-flags`（可选） | 强制所有 GrowthBook feature flag 为开 |

主进程 hook 的运行记录写在 `~/.config/Claude/logs/patch.log`。
遥测/自动更新通过应用行为类配置键关闭，不会触发 3P 模式。

---

## 常见问题

**Q: 便携副本启动报 sandbox 错误？**
A: 副本里的 `chrome-sandbox` 不再是 root 所有的 setuid 文件。`launch.sh` 会在内核禁止非特权 user namespace 时自动加 `--no-sandbox`；
也可以 `CLAUDE_NO_SANDBOX=1 ./launch.sh` 强制。

**Q: 配置写了但还是要求登录？**
A: `node setup.js status` 看看 `/etc/claude-desktop/managed-settings.json` 是否存在（它优先级更高），再看 `~/.config/Claude-3p/logs/main.log`
里 `[custom-3p]` 开头的行；`Failed to parse managed config` 会说明哪个键不合法。

**Q: Claude 更新了怎么办？**
A: 方案 1 不受影响。方案 2/3 重新执行一次对应命令即可（原地模式会自动从 `app.asar.orig` 重新打补丁；若软件包升级覆盖了 asar，则以新文件为准）。

**Q: 日志里 `safeStorage isEncryptionAvailable=false`？**
A: 桌面环境没有可用的 keyring（gnome-keyring / kwallet），与本工具无关；3P 模式的凭据来自配置文件，不受影响。
