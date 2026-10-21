# Handoff — timeout-limiter-user-only-and-one-shot

**Task:** `/disable_timeout_limiter` must be user-only (no agent path), and `/set_timeout_limiter 15s` must apply to the next tool call only, then revert to the normal limit; on by default, toggleable by the user with `/disable_per_toolcall_reset`.
**Done when:** implemented, committed, and verified in a real TUI — agent has no way to disable the limiter, and a raised limit is consumed by the next tool call.

## Context for this task
- **Status: implemented, committed** (see `git log`; the plugin repo is this repo, `master`). Working tree clean.
- Plugin is two halves in one package dir: `index.ts` (server: tools + per-call deadline) and `tui.ts` (terminal: slash commands). `package.json` maps `exports: { ".": "./index.ts", "./tui": "./tui.ts" }`.
- Registered in `~/.config/opencode/opencode.jsonc` under the **plural** `plugins` key with the absolute path to the package dir. It reports as `{server: true, tui: true}` — that flag is what makes the CLI load the TUI half.
- State file `~/.config/opencode/timeout-limiter.json` is the single source of truth (read fresh per tool call; every location has its own plugin instance, so caching it caused flip-flopping between dirs). Current value: `limitMs 5000, excluded [question, task], disabled false, perToolCallReset true, oneShotMs null`.
- **User-only is structural, not a check:** every control that decides *whether* a tool call is bounded lives in `tui.ts` (client-side). There is no server command and no tool for them, so an agent has no path to them.

### Decisions (do not relitigate)
- Commands live in the **TUI plugin**, not the server. A server-side command that reports via `ctx.session.synthetic` wakes the model (the endpoint "schedules execution"); with `resume: false` the message never reaches the transcript. The TUI plugin runs in the client: it reads/writes the state file and shows a toast. No agent turn, no session message.
- The shell timeout clamp happens **inside the wrapper**, not in the `execute.before` hook: the hook mutates a copy, so the tool never saw the clamped value and processes outlived the limit.
- The one-shot is consumed after the call (success, failure, or kill) and only by non-excluded tools — a `question` prompt must not waste it.
- The one-shot is consumed **only by the value that was actually used**: if the limit is raised again while a call is running, the newer value survives. Without this, a second `set_timeout_limit` silently erased the first.
- The plugin's **own** tools (`set_timeout_limit`, `timeout_limiter_status`) do not consume the one-shot. They only read and write the state file; spending the pending raise on introspection would waste it.
- The **exclusion list is user-only too** (`/exclude_timeout_tool`, `/include_timeout_tool`). The old `timeout_exclude_tools` / `timeout_include_tools` agent tools let the agent exclude every tool, which is functionally the same as switching the limiter off and broke the "no agent path to disable" guarantee. The agent's remaining tools are `set_timeout_limit` (raises the limit for one call, never disables) and `timeout_limiter_status`.

### Ruled out (will waste time if retried)
- Server-side `ctx.command.transform` commands for these three names → agent gets woken.
- `ctx.session.synthetic({resume: false})` → message stays pending, never rendered.
- Flat `~/.config/opencode/plugins/<name>.tui.ts` → the server also loads that file and claims it, the CLI then reports no `features.tui` and skips it. Works only as a *sibling* of a flat server file **and** only if the server-side load fails — fragile. The package-dir layout is the one that works.
- Plugin directories are not auto-discovered by the server in v2.0.29; they must be listed in `plugins`.

### Gotchas
- The **server half hot-reloads** in v2.0.29: edit `index.ts` and the next tool call already uses the new code. Edit the file in one piece — a half-written file makes the next tool call fail with a `ReferenceError` from the plugin. The **TUI half still needs a TUI restart** (the CLI loads client plugins at start).
- In the TUI, typing `/` opens the command list and Enter is bound to "select autocomplete item" (not "submit") while it is open. A command with no argument runs on that first Enter. A command with an argument does not: the list rewrites the line to `/name ` and drops any argument already typed. Type the whole line including the argument — the space after the command name closes the list — and press Enter once. ESC hides the list without running anything.
- The TUI repaints the screen with cursor moves, so a toast that was on screen can appear in the log with characters missing ("Not limitd:question, tak, foo"). Grep the log for a stable fragment, not the full string, or check the state file instead — the state file is the ground truth.
- `opencode --standalone` has no `--standalone` flag (it is `opencode run --standalone`); that path sends the text as a prompt, so it is useless for testing slash commands.
- The `code-mode` `execute` tool can call the plugin's own tools with no LLM involved — the fastest way to test state transitions. The `execute` tool itself is not limited (`index.ts` skips `execute`).
- The limiter also applies to **background** shell calls, so a long verification script needs a raised limit first (`set_timeout_limit`) or it is killed at 5s.
- `opencode --standalone`… see above.

### Pointers
- `timeout-limiter/index.ts:22` `loadState()` — reads the state file fresh, applies defaults for missing fields (old files lack `perToolCallReset`/`oneShotMs`).
- `timeout-limiter/index.ts:114` `set_timeout_limit` tool — agent-facing; one-shot when `perToolCallReset` is on, persistent when off. It only ever *re-enables* the limiter.
- `timeout-limiter/index.ts:238` tool wrapper — picks `oneShotMs ?? limitMs`, clamps the shell timeout, and consumes the one-shot in the `finally`.
- `timeout-limiter/tui.ts:95` `show_timeout_limiter`, `:112` `set_timeout_limiter`, `:154` `disable_timeout_limiter`, `:172` `exclude_timeout_tool` / `include_timeout_tool`, `:190` `disable_per_toolcall_reset`, `:210` `enable_per_toolcall_reset` — all terminal-side, user-only.
- `/home/inxeoz/chill.md` — the prose describing the plugin (the old `/home/inxeoz/AGENTS.md` was removed by the user, backup at `AGENTS.md.bk`).

### Commands
- Check what is loaded: `opencode api get /api/plugin | grep timeout` → expect `features {server: true, tui: true}`, status `active`.
- Check the server exposes no timeout command: `opencode api get /api/command` → no `timeout` entries.
- Read state: `cat ~/.config/opencode/timeout-limiter.json`.
- Drive a real TUI in a pty (no LLM needed) — raise the limit first, the script runs longer than 5s:
  `execute: tools.set_timeout_limit({time_in_sec: 60})`, then
  `bash -c '(sleep 12; printf "/show_timeout_limiter"; sleep 2; printf "\r"; sleep 1; printf "\r"; sleep 8) | cat' | script -qec "timeout 40 opencode" /dev/null > /tmp/opencode/tui.log`
  then grep the log for `ENABLED`.

## Open (?)
- `~/.config/opencode/plugins/probe.ts` is the user's leftover debug plugin (writes `/tmp/opencode/probe-global.txt` on every load). Not touched — offer to remove it.
- The persistent normal limit is 5s by default; there is no user command to change it while per-tool-call reset is on (turn the reset off to set it persistently).
- The state file lives in `~/.config/opencode/`, which the agent can also write with the generic `write` tool. The plugin cannot stop that; only a permission rule or a different location would.
