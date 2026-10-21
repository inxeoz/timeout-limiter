import { Plugin } from "@opencode/plugin/tui"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(STATE_DIR, "timeout-limiter.json")
const DEFAULT_LIMIT_MS = 5_000
const DEFAULT_EXCLUDED = ["question", "task"]
const MIN_LIMIT_MS = 100
const MAX_LIMIT_MS = 600_000

type State = {
  limitMs: number
  excluded: string[]
  disabled: boolean
  perToolCallReset: boolean
  oneShotMs: number | null
}

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
    return {
      limitMs,
      excluded,
      disabled: parsed.disabled === true,
      perToolCallReset: parsed.perToolCallReset !== false,
      oneShotMs:
        typeof parsed.oneShotMs === "number" && parsed.oneShotMs > 0
          ? Math.min(Math.max(parsed.oneShotMs, MIN_LIMIT_MS), MAX_LIMIT_MS)
          : null,
    }
  } catch {
    return {
      limitMs: DEFAULT_LIMIT_MS,
      excluded: [...DEFAULT_EXCLUDED],
      disabled: false,
      perToolCallReset: true,
      oneShotMs: null,
    }
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
  const parts = [`${status}`, `limit ${state.limitMs}ms (${state.limitMs / 1000}s)`]
  if (state.oneShotMs) {
    parts.push(`next call: ${state.oneShotMs}ms (${state.oneShotMs / 1000}s)`)
  }
  parts.push(`per-tool-call reset: ${state.perToolCallReset ? "on" : "off"}`)
  parts.push(`excluded: ${state.excluded.join(", ") || "(none)"}`)
  return parts.join(" · ")
}

export default Plugin.define({
  id: "timeout-limiter.tui",
  setup(context: any) {
    if (!context?.keymap?.layer || !context?.ui?.toast) return

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "timeout-limiter.show",
          title: "Show timeout limiter status",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_show" },
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
          slash: { name: "timeout_limit_set", arguments: true },
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
            if (state.perToolCallReset) {
              state.oneShotMs = ms
              state.disabled = false
              saveState(state)
              context.ui.toast.show({
                title: "timeout-limiter",
                message: `Next call only: ${ms}ms (${ms / 1000}s). Then reverts to ${state.limitMs}ms.`,
                variant: "success",
                duration: 6000,
              })
            } else {
              state.limitMs = ms
              state.disabled = false
              saveState(state)
              context.ui.toast.show({
                title: "timeout-limiter",
                message: `Hard limit set to ${ms}ms (persistent).`,
                variant: "success",
                duration: 5000,
              })
            }
          },
        },
        {
          id: "timeout-limiter.disable",
          title: "Disable timeout limiter",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_disable" },
          enabled: () => true,
          run: () => {
            const state = loadState()
            state.disabled = true
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: "DISABLED. Tool calls are no longer killed. Use /timeout_limit_set <n>s to turn it back on.",
              variant: "warning",
              duration: 8000,
            })
          },
        },
        {
          id: "timeout-limiter.exclude",
          title: "Exclude tools from the timeout limiter",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_exclude", arguments: true },
          enabled: () => true,
          run: (input) => {
            const names = String(input ?? "")
              .split(/[\s,]+/)
              .filter(Boolean)
            if (names.length === 0) {
              context.ui.toast.show({
                title: "timeout-limiter",
                message: "Name at least one tool, e.g. /timeout_limit_exclude question task",
                variant: "warning",
                duration: 8000,
              })
              return
            }
            const state = loadState()
            state.excluded = [...new Set([...state.excluded, ...names])]
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: `Not limited: ${state.excluded.join(", ")}`,
              variant: "success",
              duration: 6000,
            })
          },
        },
        {
          id: "timeout-limiter.include",
          title: "Include tools in the timeout limiter",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_include", arguments: true },
          enabled: () => true,
          run: (input) => {
            const names = String(input ?? "")
              .split(/[\s,]+/)
              .filter(Boolean)
            if (names.length === 0) {
              context.ui.toast.show({
                title: "timeout-limiter",
                message: "Name at least one tool, e.g. /timeout_limit_include question",
                variant: "warning",
                duration: 8000,
              })
              return
            }
            const state = loadState()
            const removed = state.excluded.filter((n) => names.includes(n))
            state.excluded = state.excluded.filter((n) => !names.includes(n))
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: removed.length
                ? `Limited again: ${removed.join(", ")}`
                : "Those tools were not excluded.",
              variant: "success",
              duration: 6000,
            })
          },
        },
        {
          id: "timeout-limiter.reset-disable",
          title: "Disable per-tool-call reset",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_disable_reset" },
          enabled: () => true,
          run: () => {
            const state = loadState()
            state.perToolCallReset = false
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: "Per-tool-call reset OFF. /timeout_limit_set now sets a persistent limit.",
              variant: "success",
              duration: 6000,
            })
          },
        },
        {
          id: "timeout-limiter.reset-enable",
          title: "Enable per-tool-call reset",
          group: "Timeout limiter",
          slash: { name: "timeout_limit_enable_reset" },
          enabled: () => true,
          run: () => {
            const state = loadState()
            state.perToolCallReset = true
            saveState(state)
            context.ui.toast.show({
              title: "timeout-limiter",
              message: "Per-tool-call reset ON. /timeout_limit_set now applies to the next call only.",
              variant: "success",
              duration: 6000,
            })
          },
        },
      ],
    }))
  },
})
