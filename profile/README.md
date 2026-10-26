# oh-my-omp

English | [简体中文](https://github.com/oh-my-omp/.github/blob/main/profile/README.zh-CN.md)

Plugins, extensions and a governed configuration for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), the terminal coding-agent harness. Each repository is an `omp` plugin installable on its own; [omp-config](https://github.com/oh-my-omp/omp-config) wires them into one runtime that gates dispatch, judges turns in a side channel and keeps long tasks on the human's stated intent.

## Repositories

| Repository | What it adds to omp |
|---|---|
| [omp-config](https://github.com/oh-my-omp/omp-config) | The versioned configuration: system-prompt layers, cost/trust-tiered subagents, 22 local extensions (dispatch and delivery gates, JUDGE-role sideband checks, input polish, worktree and restart tools), a startup auto-updater and a light mode |
| [omp-todo-more](https://github.com/oh-my-omp/omp-todo-more) | Rich Todo that replaces the native one: goal, phases, per-item explanation and time budget, continuation reminders, commit-on-done, the `ctx` recall tool and a Tern editor |
| [omp-unified-exec](https://github.com/oh-my-omp/omp-unified-exec) | Long-lived PTY sessions (`exec_command`, `write_stdin`, `monitor`, …) for REPLs, TUIs, `ssh` and dev servers, with a terminal HUD in Tern that a human can watch and type into |
| [omp-playbooks](https://github.com/oh-my-omp/omp-playbooks) | Playbooks: design, execution prompts and orchestration in one YAML document that people and agents co-edit as cards in a Tern pane, with Runs and frozen subagent Launches |
| [omp-roundtable](https://github.com/oh-my-omp/omp-roundtable) | Delivers a GitHub issue graph through durable tickets, one-shot Owner sessions and independent gates, launched from a link in the issue |
| [omp-remote-build](https://github.com/oh-my-omp/omp-remote-build) | Per-worktree Mutagen replica on a remote Docker host with a Komodo-managed build/test container and container PTY tools |
| [omp-thinking-translator](https://github.com/oh-my-omp/omp-thinking-translator) | Translates visible assistant thinking blocks for display only, streaming per line through a fallback chain of models |
| [omp-codex-image-gen](https://github.com/oh-my-omp/omp-codex-image-gen) | Generates or edits PNGs with `gpt-image-2` through a ChatGPT Plus/Pro Codex subscription, from up to five reference images |

## Install

Install any plugin from its repository:

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

Each README lists its prerequisites (Tern, Bun, Mutagen, a Codex subscription). To take the whole setup, follow [omp-config](https://github.com/oh-my-omp/omp-config#72-quick-start-and-operational-workflows): its updater installs the plugins it declares and applies the configuration to `~/.omp/agent`.

## UI language

Every plugin here shows its person-facing text (notifications, labels, dialogs, renderers) in English or Chinese, resolved the same way: `OMOMP_LANG` (`en` or `zh`), then the `omomp-lang` section of `~/.omp/agent/omomp.yml`, then `LC_ALL` / `LC_MESSAGES` / `LANG`, then English. omp-unified-exec also runs under Pi and reads only `OMOMP_LANG`, which omp-config's `omomp-lang` extension exports from that section at startup. Text sent to the model stays as written.

```yaml
# ~/.omp/agent/omomp.yml
omomp-lang:
  language: zh
```
