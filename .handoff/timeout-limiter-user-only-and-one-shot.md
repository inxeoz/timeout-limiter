# Handoff — timeout-limiter-user-only-and-one-shot

**Task:** `/disable-timeout-limiter` must be user-only (no agent path), and `/set-timeout-limiter 15s` must apply to the next tool call only, then revert to the normal limit; on by default, toggleable by the user with `/disable-per-toolcall-reset`.
**Done when:** implemented, committed, and verified in a real TUI — agent has no way to disable the limiter, and a raised limit is consumed by the next tool call.

## Context for this task
- **Status: implemented and committed** (`6ce0c7e` on `master` in the plugin repo; earlier: `e3a9b2f`, `feb3c6a`, `a8e104b`). Working tree clean.
- Plugin is two halves in one package dir: `index.ts` (server: tools + per-call deadline) and `tui.ts` (terminal: slash commands). `package.json` maps `exports: { ".": "./index.ts", "./tui": "./tui.ts" }`.
- Registered in `~/.config/opencode/opencode.jsonc` under the **plural** `plugins` key with the absolute path to the package dir. It reports as `{server: true, tui: true}` — that flag is what makes the CLI load the TUI half.
- State file `~/.config/opencode/timeout-limiter.json` is the single source of truth (read fresh per tool call; every location has its own plugin instance, so caching it caused flip-flopping between dirs). Current value: `limitMs 5000, excluded [question, task], disabled false, perToolCallReset true, oneShotMs null`.
- **User-only is structural, not a check:** disable and the per-tool-call-reset toggles exist only in `tui.ts` (client-side). There is no server command and no tool for them, so an agent has no path to them.

### Decisions (do not relitigate)
- Commands live in the **TUI plugin**, not the server. A server-side command that reports via `ctx.session.synthetic` wakes the model (the endpoint "schedules execution"); with `resume: false` the message never reaches the transcript. The TUI plugin runs in the client: it reads/writes the state file and shows a toast. No agent turn, no session message.
- The shell timeout clamp happens **inside the wrapper**, not in the `execute.before` hook: the hook mutates a copy, so the tool never saw the clamped value and processes outlived the limit.
- The one-shot is consumed after the call (success, failure, or kill) and only by non-excluded tools — a `question` prompt must not waste it.

### Ruled out (will waste time if retried)
- Server-side `ctx.command.transform` commands for these three names → agent gets woken.
- `ctx.session.synthetic({resume: false})` → message stays pending, never rendered.
- Flat `~/.config/opencode/plugins/<name>.tui.ts` → the server also loads that file and claims it, the CLI then reports no `features.tui` and skips it. Works only as a *sibling* of a flat server file **and** only if the server-side load fails — fragile. The package-dir layout is the one that works.
- Plugin directories are not auto-discovered by the server in v2.0.29; they must be listed in `plugins`.

### Gotchas
- Plugin **code** changes need `opencode service restart` (the file watcher does not reload plugin modules). The TUI half needs a **TUI restart** — CLI plugins load at client start.
- In the TUI, the autocomplete dropdown swallows the first Enter. Type the command, then Enter (accepts) and Enter again (runs), or press Escape first, then Enter. For an argument command, ESC then Enter is the reliable path.
- `opencode --standalone` has no `--standalone` flag (it is `opencode run --standalone`); that path sends the text as a prompt, so it is useless for testing slash commands.
- The `code-mode` `execute` tool can call the plugin's own tools with no LLM involved — the fastest way to test state transitions.

## Pointers
- `timeout-limiter/index.ts:22` `loadState()` — reads the state file fresh, applies defaults for missing fields (old files lack `perToolCallReset`/`oneShotMs`).
- `timeout-limiter/index.ts:104` `set_timeout_limit` tool — agent-facing; one-shot when `perToolCallReset` is on, persistent when off.
- `timeout-limiter/index.ts:225` tool wrapper — picks `oneShotMs ?? limitMs`, clamps the shell timeout, and consumes the one-shot at `:276`.
- `timeout-limiter/tui.ts:95` `show-timeout-limiter`, `:112` `set-timeout-limiter`, `:154` `disable-timeout-limiter`, `:172` `disable-per-toolcall-reset`, `:190` `enable-per-toolcall-reset` — all terminal-side, user-only.
- `/home/inxeoz/chill.md` — the prose describing the plugin (the old `/home/inxeoz/AGENTS.md` was removed by the user, backup at `AGENTS.md.bk`).

## Commands
- Reload the server: `opencode service restart` (interrupts the calling tool call; the session survives).
- Check what is loaded: `opencode api get /api/plugin | grep timeout` → expect `features {server: true, tui: true}`, status `active`.
- Read state: `cat ~/.config/opencode/timeout-limiter.json`.
- Drive a real TUI in a pty (no LLM needed):
  `bash -c '(sleep 8; printf "/show-timeout-limiter"; sleep 3; printf "\r"; sleep 3; printf "\r"; sleep 7) | script -qec "timeout 24 opencode" /dev/null' > /tmp/opencode/tui.log` then grep the log for `ENABLED`.

## Open (?)
- `~/.config/opencode/plugins/probe.ts` is the user's leftover debug plugin (writes `/tmp/opencode/probe-global.txt` on every load). Not touched — offer to remove it.
- The persistent normal limit is 5s by default; there is no user command to change it while per-tool-call reset is on (turn the reset off to set it persistently).

---

## Task
**Goal:** Make the timeout limiter's disable switch user-only and make raised limits one-shot by default.
**Done:**
- [x] `/disable-timeout-limiter` reachable only from the terminal; no server command, no agent tool
- [x] `/set-timeout-limiter 15s` (and the agent's `set_timeout_limit`) applies to the next tool call only, then reverts
- [x] One-shot on by default (`perToolCallReset: true`); `/disable-per-toolcall-reset` and `/enable-per-toolcall-reset` toggle it, user-only
- [x] Verified in a real TUI: toast shows the status, one-shot consumed by the next call
- [x] Committed (`6ce0c7e`)
**Constraints:** no agent-reachable path to disable; state file stays the single source of truth; server plugin code must not break the CLI's `features.tui` detection.
**Start:** `timeout-limiter/index.ts:225` — the wrapper that resolves the effective limit and consumes the one-shot.
**Out of scope:** the leftover `probe.ts` plugin; changing the 5s default.
**First step:** if more work is needed, read `timeout-limiter/index.ts:225` and `timeout-limiter/tui.ts:95`, then `opencode service restart` and re-verify in a pty-driven TUI.
