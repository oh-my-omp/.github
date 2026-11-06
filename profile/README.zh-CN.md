<img src="https://raw.githubusercontent.com/oh-my-omp/.github/main/profile/logo.png" alt="oh-my-omp logo" width="96" align="right">

# oh-my-omp

[English](https://github.com/oh-my-omp/.github/blob/main/profile/README.md) | 简体中文

为终端编码代理宿主 [Oh My Pi](https://github.com/can1357/oh-my-pi)（`omp`）提供插件、扩展和一套受治理的配置。各插件仓库都可以单独安装；[omp-config](https://github.com/oh-my-omp/omp-config) 把它们接成一个运行时：派发前设门禁，旁路判定每一轮，让长任务始终对齐人类原话里的意图。

## 安装

安装整套 omomp，请从 [omp-config 的 `/onboard-omp` 引导](https://github.com/oh-my-omp/omp-config/blob/main/README.zh-CN.md#安装)开始。安装说明给出了克隆仓库、启动 `omp` 和运行命令的步骤。agent 会用你的语言介绍配置，结合你已有的规则与 skills 帮助定制；你明确要求安装后，它才会应用配置并安装声明的插件。

如果只需要某个插件，可以从对应仓库单独安装：

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

各插件 README 写明前置条件（Tern、Bun、Mutagen、Codex 订阅）。

**强烈推荐搭配 Tern 使用。** 这些插件的 GUI 界面（Todo 编辑器、终端 HUD、Playbook 卡片）都是 Tern 面板，在 Tern 的 GUI 下才能获得完整体验。

## 仓库

| 仓库 | 为 omp 增加的能力 |
|---|---|
| [omp-config](https://github.com/oh-my-omp/omp-config) | 版本化配置：分层系统提示、按成本与可信度分级的子代理、本地扩展（派发与交付门禁、JUDGE 角色旁路检查、输入润色、工作树与重启工具）、启动时自动更新和轻量模式 |
| [omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) | 替换原生 Todo：目标、阶段、逐项说明与时间预算、续做提醒、完成即提交、`ctx` 回顾工具和 Tern 编辑器 |
| [omp-unified-exec](https://github.com/oh-my-omp/omp-unified-exec) | 长驻 PTY 会话（`exec_command`、`write_stdin`、`monitor` 等），用于 REPL、TUI、`ssh` 和开发服务器；在 Tern 中有终端 HUD，人可以旁观并输入 |
| [omp-playbooks](https://github.com/oh-my-omp/omp-playbooks) | Playbook：把设计、执行 prompt 和编排放进一份 YAML 文档，人和代理在 Tern 面板里以卡片共同编辑，支持 Run 和冻结的子代理 Launch |
| [omp-dispatch](https://github.com/oh-my-omp/omp-dispatch) | 通过持久票据、一次性 Owner 会话和独立门禁交付 GitHub issue 图，从 issue 里的链接启动 |
| [omp-remote-build](https://github.com/oh-my-omp/omp-remote-build) | 每个工作树在远程 Docker 主机上维护一份 Mutagen 副本，配一个由 Komodo 管理的构建/测试容器和容器 PTY 工具 |
| [omp-thinking-translator](https://github.com/oh-my-omp/omp-thinking-translator) | 只为显示翻译可见的思考块，按行流式输出，模型按回退链依次尝试 |
| [omp-codex-image-gen](https://github.com/oh-my-omp/omp-codex-image-gen) | 借 ChatGPT Plus/Pro 的 Codex 订阅，用 `gpt-image-2` 生成或编辑 PNG，最多参考五张图片 |

## 界面语言

这里的每个插件都把面向人的文字（通知、标签、对话框、渲染器）显示为英文或中文，解析顺序相同：`OMOMP_LANG`（`en` 或 `zh`）→ `LC_ALL` / `LC_MESSAGES` / `LANG` → 英文。omp-unified-exec 也能在 Pi 下运行，此时这一解析只读环境变量；omp-config 的 `omomp-lang` 扩展会在启动时把配置的语言导出为 `OMOMP_LANG`，所以只读环境变量的使用方也能拿到配置的语言。发给模型的文字保持原样。
