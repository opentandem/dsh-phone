# dsh-phone

在手机上使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）。在 `dsh web` 里扫描二维码，在手机上登录 [OpenTandem](https://opentandem.org/?utm_source=github&utm_campaign=dsh-phone) 并点「允许」，就能把任务发给运行 `dsh` 的这台电脑。电脑上已有的 `dsh` 会话会出现在手机上，手机和电脑接着同一个会话聊。

[English](README.md)

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add dsh-phone
```

从 GitHub 安装：

```sh
dsh plugin --profile web add github:opentandem/dsh-phone
```

也可以在 `dsh web` 里打开「插件 → 添加插件」，输入 `dsh-phone`，安装后点「立即启用」。如果侧栏没有出现「手机连接」，刷新一次页面。

## 使用

1. 点 `dsh web` 侧栏的「手机连接」，再点「显示二维码」。
2. 用手机扫描二维码，用浏览器打开。
3. 在手机上登录 OpenTandem，点「允许」。
4. `dsh web` 的页面会显示这台电脑已经连接。
5. 在手机上打开 OpenTandem。`dsh` 用过的项目目录和其中最近的会话会自动添加到任务列表，可以接着聊，也可以新建任务。

要连接其他账号，在页面上点「换账号连接」。在手机上点「允许」之前，当前连接不受影响。

截图见[英文说明](README.md#use)。

## 它会安装什么、发送什么

这个插件只提供一个页面和配对步骤，让手机保持连接的是 OpenTandem 命令行。它是一个独立程序，点「显示二维码」之前应该先了解它会做什么：

| 项目 | 说明 |
|---|---|
| 下载 | 第一次使用时，插件从 `https://opentandem.org/api/cli-script?file=launcher.mjs` 下载启动器到 `~/.opentandem-dsh/`，用运行 `dsh` 的 Node.js 执行。启动器会安装 OpenTandem 命令行，大约需要一分钟。 |
| 后台服务 | 命令行会启动一个常驻后台的 Runner，关掉 `dsh web` 之后手机仍然能连到这台电脑。可以用 `opentandem uninstall` 卸载，也可以在 OpenTandem 设置里删除这台电脑。 |
| 手机能做什么 | 点「允许」之后，从该 OpenTandem 账号发出的任务会通过 `dsh` 在这台电脑上运行。只有配对是你自己发起的才应该允许。 |
| 账号 | 登录发生在手机上，所以插件不接触你的 OpenTandem 账号和密码，也不使用你的 DeepSeek 账号。任务使用你在 `dsh` 里已经配置好的模型。 |
| 连接校验 | 插件的所有路由都经过 `dsh` 自己接口使用的连接校验，POST 路由只接受 `application/json`。 |

[OpenTandem Runner 和命令行](https://github.com/opentandem/opentandem)的源码以 AGPL-3.0 公开。

## 配置

| 环境变量 | 含义 |
|---|---|
| `OPENTANDEM_CLI` | 使用指定的启动器或 `opentandem` 程序，不再下载。 |
| `OPENTANDEM_SERVER` | 下载和配对使用的 OpenTandem 服务器，默认是 `https://opentandem.org`。 |

## 兼容性

已在 macOS 上用 `dsh` 0.2.1-rc.2 和 0.2.2-rc.1 测试过，Windows 和 Linux 还没有测试。

## 关于 OpenTandem

**OpenTandem 是一款面向个人与团队、统一管理多个 AI 编码 Agent，并提供移动端接入的工具。**
**一个空间，连接你的所有机器，支持 Agent 切换、模型调度、实时额度追踪与团队协作。**

## 许可证

MIT。OpenTandem 命令行和 Runner 是独立的 AGPL-3.0 程序，本插件只把它们作为子进程启动，不包含它们的代码。
