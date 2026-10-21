import { Plugin } from "@opencode/plugin/tui"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(STATE_DIR, "timeout-limiter.json")
const DEFAULT_LIMIT_MS = 15_000
const DEFAULT_EXCLUDED = ["question", "task"]
const MIN_LIMIT_MS = 100
const MAX_LIMIT_MS = 600_000

type State = { limitMs: number; excluded: string[]; disabled: boolean }

// The server plugin reads the same file on every tool call, so writing it
// here takes effect immediately, in every location.
function loadState(): State {
  try {
    const raw = readFileSync(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<State>
    const limitMs =
      typeof parsed.limitMs === "number" && parsed.limitMs > 0
        ? Math.min(Math.max(parsed.limitMs, MIN_LIMIT_MS), MAX_LIMIT_MS)
        : DEFAULT_LIMIT_MS
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((x): x is string => typeof x === "string")
      : [...DEFAULT_EXCLUDED]
    return { limitMs, excluded, disabled: parsed.disabled === true }
  } catch {
    return { limitMs: DEFAULT_LIMIT_MS, excluded: [...DEFAULT_EXCLUDED], disabled: false }
  }
}

function saveState(state: State): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {
    // best effort
  }
}

// Accepts "15s", "15", "15000ms", "1m". Returns milliseconds, clamped.
function parseDuration(raw: string): number | undefined {
  const text = raw.trim().toLowerCase()
  if (!text) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(text)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = match[2] ?? "s"
  const ms = unit === "ms" ? value : unit === "m" ? value * 60_000 : value * 1_000
  return Math.min(Math.max(Math.round(ms), MIN_LIMIT_MS), MAX_LIMIT_MS)
}

function summary(state: State): string {
  const status = state.disabled ? "DISABLED" : "ENABLED"
  const excluded = state.excluded.join(", ") || "(none)"
  return `${status} · limit ${state.limitMs}ms (${state.limitMs / 1000}s) · excluded: ${excluded}`
}

export default Plugin.define({
  id: "timeout-limiter.tui",
  setup(context: any) {
    // The server also loads this file. Only the terminal has a keymap and a
    // toast, so the server side does nothing.
    if (!context?.keymap?.layer || !context?.ui?.toast) return

    // These run entirely in the terminal: no server round trip, no model, no
    // session message. The status is read from and written to the same state
    // file the server plugin uses.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "timeout-limiter.show",
          title: "Show timeout limiter status",
          group: "Timeout limiter",
          slash: { name: "show-timeout-limiter" },
          enabled: () => true,
          run: () => {
            context.ui.toast.show({
              title: "timeout-limiter",
              message: summary(loadState()),
              duration: 8000,
            })
          },
        },
        {
          id: "timeout-limiter.set",
          title: "Set timeout limiter limit",
          group: "Timeout limiter",
          slash: { name: "set-timeout-limiter", arguments: true },
          enabled: () => true,
          run: (input) => {
            const raw = String(input ?? "").trim()
            const ms = parseDuration(raw)
            if (!ms) {
              context.ui.toast.show({
                title: "timeout-limiter",
                message: `Could not parse "${raw || "(empty)"}". Use a duration like 15s, 15000ms or 1m.`,
                variant: "warning",
                duration: 8000,
              })
              return
            }
            const state = loadState()
            state.limitMs = ms
            state.disabled = false
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: `Limit set to ${ms}ms (${ms / 1000}s). Limiter enabled.`,
              variant: "success",
              duration: 5000,
            })
          },
        },
        {
          id: "timeout-limiter.disable",
          title: "Disable timeout limiter",
          group: "Timeout limiter",
          slash: { name: "disable-timeout-limiter" },
          enabled: () => true,
          run: () => {
            const state = loadState()
            state.disabled = true
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message:
                "DISABLED. Tool calls are no longer killed. Use /set-timeout-limiter <n>s to turn it back on.",
              variant: "warning",
              duration: 8000,
            })
          },
        },
      ],
    }))
  },
})
