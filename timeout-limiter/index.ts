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

// The state file is the only source of truth. Every location loads its own
// copy of this plugin, so the file is read fresh instead of cached.
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

// A tool is excluded when its short name or its namespaced id matches.
function matches(name: string, id: string, list: string[]): boolean {
  for (const entry of list) {
    if (name === entry || id === entry || id.endsWith(`_${entry}`)) return true
  }
  return false
}

function describe(state: State): string {
  const status = state.disabled ? "DISABLED" : "ENABLED"
  const lines = [
    `timeout-limiter: ${status}`,
    `  normal limit: ${state.limitMs}ms (${state.limitMs / 1000}s)`,
  ]
  if (state.oneShotMs) {
    lines.push(`  next call only: ${state.oneShotMs}ms (${state.oneShotMs / 1000}s)`)
  }
  lines.push(`  per-tool-call reset: ${state.perToolCallReset ? "on" : "off"}`)
  lines.push(`  excluded tools: ${state.excluded.join(", ") || "(none)"}`)
  lines.push(`  state file: ${STATE_FILE}`)
  return lines.join("\n")
}

export default {
  id: "timeout-limiter",
  setup: async (ctx: any) => {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "set_timeout_limit",
        description:
          "Set the hard timeout limit (in seconds) applied to tool calls. " +
          "Persisted across sessions. Also re-enables the limiter if it was disabled.",
        input: {
          type: "object",
          properties: { time_in_sec: { type: "number" } },
          required: ["time_in_sec"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const ms = Math.min(
            Math.max(Math.round(Number(input.time_in_sec) * 1000), MIN_LIMIT_MS),
            MAX_LIMIT_MS,
          )
          const state = loadState()
          if (state.perToolCallReset) {
            state.oneShotMs = ms
          } else {
            state.limitMs = ms
          }
          state.disabled = false
          saveState(state)
          return {
            content: state.perToolCallReset
              ? `Next tool call only: ${ms}ms (${ms / 1000}s). Limiter enabled. Reverts to ${state.limitMs}ms after.`
              : `Hard timeout limit set to ${ms}ms (persistent). Limiter enabled.`,
            metadata: { limitMs: state.limitMs, oneShotMs: state.oneShotMs, disabled: false },
          }
        },
      })

      editor.add({
        name: "timeout_exclude_tools",
        description:
          "Exclude the given tools from the hard timeout (e.g. 'question' for " +
          "interactive prompts). Accepts a list of tool names.",
        input: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "string" } },
          },
          required: ["tools"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const state = loadState()
          const names = Array.isArray(input.tools) ? input.tools.map(String) : []
          state.excluded = [...new Set([...state.excluded, ...names])]
          saveState(state)
          return {
            content: `Excluded from timeout: ${state.excluded.join(", ") || "(none)"}.`,
            metadata: { excluded: state.excluded },
          }
        },
      })

      editor.add({
        name: "timeout_include_tools",
        description:
          "Re-enable the hard timeout for the given tools (remove them from the " +
          "exclusion list).",
        input: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "string" } },
          },
          required: ["tools"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const state = loadState()
          const names = Array.isArray(input.tools) ? input.tools.map(String) : []
          state.excluded = state.excluded.filter((n) => !names.includes(n))
          saveState(state)
          return {
            content: `Excluded from timeout: ${state.excluded.join(", ") || "(none)"}.`,
            metadata: { excluded: state.excluded },
          }
        },
      })

      editor.add({
        name: "timeout_limiter_status",
        description:
          "Show the current timeout-limiter status: whether it is enabled, the hard " +
          "limit for tool calls, and the tools that are excluded from it.",
        input: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const state = loadState()
          return {
            content: describe(state),
            metadata: {
              limitMs: state.limitMs,
              oneShotMs: state.oneShotMs,
              disabled: state.disabled,
              perToolCallReset: state.perToolCallReset,
              excluded: state.excluded,
            },
          }
        },
      })
    })

    // Deadline for every tool call. The call is aborted and fails with a
    // message the agent can act on; the session keeps running.
    await ctx.tool.transform((editor: any) => {
      for (const tool of editor.list()) {
        const id: string = tool.id
        if (typeof id !== "string" || !id) continue
        // The code mode entry point runs a whole program; do not bound it.
        if (id === "execute" || id.endsWith("_execute")) continue
        const name: string = tool.name ?? id
        const original = tool.execute
        if (typeof original !== "function") continue

        editor.update(id, (definition: any) => {
          definition.execute = async (input: any, context: any) => {
            // Read fresh: the state is shared by every location.
            const state = loadState()
            const limit = state.disabled ? 0 : (state.oneShotMs ?? state.limitMs)
            const isExcluded = matches(name, id, state.excluded)
            const oneShotUsed =
              !state.disabled && !isExcluded && state.oneShotMs !== null

            if (!limit || isExcluded) {
              return original(input, context)
            }

            // Shell timeouts are milliseconds. Clamp them here: the object we
            // mutate is the one the tool receives, so the tool kills the
            // process itself when the limit is reached.
            if ((name === "shell" || name === "bash") && input && typeof input === "object") {
              const requested = typeof input.timeout === "number" ? input.timeout : limit
              input.timeout = Math.min(requested, limit)
            }

            const controller = new AbortController()
            const signal = context?.signal
              ? AbortSignal.any([context.signal, controller.signal])
              : controller.signal

            let timer: ReturnType<typeof setTimeout> | undefined
            const deadline = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort()
                reject(
                  new Error(
                    `timeout-limiter: the tool "${name}" was killed after ${limit}ms, ` +
                      `which is the hard limit for tool calls. The call was aborted, ` +
                      `nothing else is running. Retry with a smaller scope, or change the ` +
                      `limit with /set-timeout-limiter <seconds>s ` +
                      `(/disable-timeout-limiter turns the limit off).`,
                  ),
                )
              }, limit)
            })

            try {
              return await Promise.race([
                Promise.resolve().then(() => original(input, { ...context, signal })),
                deadline,
              ])
            } finally {
              if (timer) clearTimeout(timer)
              // Consume the one-shot override after the call, whether it
              // succeeded, failed, or timed out. Excluded tools leave it in
              // place for the next call.
              if (oneShotUsed) {
                const s = loadState()
                s.oneShotMs = null
                saveState(s)
              }
            }
          }
        })
      }
    })
  },
}
