# timeout-limiter

An OpenCode plugin that puts a hard ceiling on how long any tool call may run.

Every tool call gets a deadline. When a call runs past it, the call is aborted,
the agent is told what happened, and the session keeps going. The limit is
5 seconds by default.

```
timeout-limiter: KILLED
  tool: shell
  killed after: 5000ms (5s)
  normal limit: 5000ms (5s)
  agent ceiling: 180000ms (180s)
  per-tool-call reset: on
  excluded tools: question, task
  action: retry with a smaller scope, raise the limit for the next call with the
  timeout_limit_set tool, or ask the user to increase the ceiling, decrease the
  scope, or change strategy.
```

## Why

An agent that runs `npm install`, a test suite, or a `tail -f` can wedge a
session for as long as the command likes. There is no natural ceiling: the
model decides what to run, the tool runs it, and the session waits.

This plugin puts the ceiling somewhere the model cannot move.

## What it improves

- **Runaway calls get stopped.** A command that hangs is killed at the limit
  instead of stalling the session indefinitely.
- **The session survives a kill.** Only the offending call is aborted. The
  agent receives a message naming the limit and can retry with a smaller
  scope.
- **A raise is always explicit and always short-lived.** `/timeout_limit_set
  15s` applies to the *next* tool call only, then the limit drops back to 5s.
  A temporary bump can no longer leave a session wide open.
- **The model cannot opt itself out.** The disable switch, the reset mode, and
  the list of exempt tools live in the terminal half of the plugin. There is no
  server command and no agent tool that reaches them, so there is no prompt
  that can talk the limiter out of existence.
- **Less waste.** A call killed at 5s costs a fraction of a call that runs to
  completion, and the agent is free to pick a cheaper next step.

## Install

Requires **opencode v2.0.29 or newer** (the TUI plugin API and the `plugins`
config key).

1. Clone the repository:

   ```sh
   git clone git@github.com:inxeoz/timeout-limiter.git
   ```

2. Register the plugin directory in `~/.config/opencode/opencode.jsonc` under
   the **`plugins`** key (plural — the singular `plugin` key is deprecated):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/timeout-limiter/timeout-limiter"]
   }
   ```

   The value is the path to the `timeout-limiter/` directory that contains
   `package.json`, not to the repository root.

3. Restart opencode. The server half loads on the next start; the terminal half
   loads when the TUI starts.

4. Check that it loaded:

   ```sh
   opencode api get /api/plugin | grep timeout
   ```

   You want to see `features {server: true, tui: true}` and status `active`.
   The `tui: true` flag is what makes the CLI load the slash commands.

The plugin has no dependencies and installs nothing.

## Usage

### Terminal commands (you only)

These run in the opencode TUI. They show a toast and never wake the model.

Every name the plugin exposes — commands and tools alike — is `lower_snake_case`,
the shape models already use for tool names.

| Command | What it does |
| --- | --- |
| `/timeout_limit_show` | Show the current status: enabled or disabled, the normal limit, any pending one-call limit, and the exempt tools. |
| `/timeout_limit_set 15s` | Raise the limit. Applies to the next tool call only, then reverts. |
| `/timeout_limit_default 30s` | Set the default normal limit (user-only; agents cannot change it). |
| `/timeout_limit_ceiling 3m` | Set the highest limit an agent may request. Agent raises are clamped to it; only the user can raise it. |
| `/timeout_limit_disable` | Turn the limiter off. Tool calls are no longer killed. |
| `/timeout_limit_disable_reset` | Make raised limits stick instead of applying to one call. |
| `/timeout_limit_enable_reset` | Back to one-call raises (the default). |
| `/timeout_limit_exclude <name...>` | Exempt tools from the limit, e.g. `/timeout_limit_exclude question task`. |
| `/timeout_limit_include <name...>` | Put exempt tools back under the limit. |

Durations accept `15s`, `15000ms`, `1m`, or a bare number of seconds. They are
clamped to 100ms–10min.

Type the command in the prompt and press Enter. One Enter is enough, for
commands with an argument too:

```
/timeout_limit_set 15s⏎
```

The command list opens as soon as you type `/` and stays open while you type
the name, and while it is open Enter is bound to "select" rather than
"submit". For a command with no argument that is harmless — the first Enter
accepts the entry and runs it. For a command with an argument, type the
argument before you press Enter: the space after the command name closes the
list, so the argument is not swallowed. Press Enter while the list is still
open and it rewrites your line to `/timeout_limit_set `, dropping the `15s`
— in that case type the name only, press Enter, then type the argument and
press Enter again.

### Agent tools

The model gets exactly two:

| Tool | What it does |
| --- | --- |
| `timeout_limit_set(time_in_sec)` | Raise the limit for the next tool call. It can re-enable the limiter, never disable it. |
| `timeout_limit_status()` | Read the same status the terminal shows. |

The agent has no way to turn the limiter off, and no way to exempt a tool from
it. If the model needs longer, it raises the limit for one call.

### How a one-shot raise behaves

- It applies to the **next real tool call** and is spent afterwards, whether
  that call succeeded, failed, or was killed.
- Exempt tools leave it pending — an interactive prompt does not waste it.
- The plugin's own tools (`timeout_limit_set`, `timeout_limit_status`) leave
  it pending — checking the status does not waste it.
- Raising the limit again while a call is running does not erase the newer
  value.

### Defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| `limitMs` | `5000` | The hard limit for a tool call. |
| `ceilingMs` | `180000` | The highest limit an agent may request. Agent raises are clamped to it. |
| `excluded` | `["question", "task"]` | Tools that are not limited: interactive prompts and subagent sessions. |
| `disabled` | `false` | Whether the limiter is off. |
| `perToolCallReset` | `true` | Whether a raise applies to one call or sticks. |
| `oneShotMs` | `null` | The limit pending for the next call, if any. |

State lives in `~/.config/opencode/timeout-limiter.json` and is the single
source of truth. It is read fresh on every tool call, so a change takes effect
immediately — no restart, and no separate opencode instance getting a stale
copy.

## How it works

The plugin is two halves in one package:

```
timeout-limiter/
├── index.ts      # server half: the tool wrapper and the agent tools
├── tui.ts        # terminal half: the slash commands
└── package.json  # exports: "." -> index.ts, "./tui" -> tui.ts
```

`index.ts` wraps every registered tool. The wrapper resolves the effective
limit (pending one-call raise first, otherwise the normal limit), clamps the
timeout of shell-like tools so the tool kills its own process at the limit, and
races the call against a deadline. When the deadline wins, the call is aborted
with the message above.

`tui.ts` runs in the client. It reads and writes the same state file and shows
a toast. No server command is involved, which is why using these commands does
not wake the model or add a turn to the transcript.

## Notes

- The code-mode `execute` tool is not bounded. It runs a whole program, so
  bounding it would cut the agent off mid-work.
- Exempt tools are matched by short name or namespaced id.
- The state file lives under `~/.config/opencode/`, so an agent with write
  access to that directory could edit it directly. The plugin's own surface
  offers no such path; closing that last gap needs an opencode permission rule.
