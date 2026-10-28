import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(STATE_DIR, "timeout-limiter.json")
const DEFAULT_LIMIT_MS = 5_000
const DEFAULT_CEILING_MS = 180_000
const DEFAULT_EXCLUDED = ["question", "task"]
const MIN_LIMIT_MS = 100
const MAX_LIMIT_MS = 600_000

// The plugin's own tools only read and write the state file. They never need
// the extra time of a one-shot raise, and they must not spend it: checking
// the status or raising the limit again would waste the pending raise.
const PLUGIN_TOOLS = new Set(["timeout_limit_set", "timeout_limit_status"])

type State = {
  limitMs: number
  ceilingMs: number
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
    const ceilingMsRaw =
      typeof parsed.ceilingMs === "number" && parsed.ceilingMs > 0
        ? Math.min(Math.max(parsed.ceilingMs, MIN_LIMIT_MS), MAX_LIMIT_MS)
        : DEFAULT_CEILING_MS
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((x): x is string => typeof x === "string")
      : [...DEFAULT_EXCLUDED]
    // Ceiling is the absolute max: never below the configured base/one-shot.
    const ceilingMs = Math.min(
      Math.max(ceilingMsRaw, limitMs, typeof parsed.oneShotMs === "number" ? parsed.oneShotMs : 0),
      MAX_LIMIT_MS,
    )
    return {
      limitMs,
      ceilingMs,
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
      ceilingMs: DEFAULT_CEILING_MS,
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
    `  agent ceiling: ${state.ceilingMs}ms (${state.ceilingMs / 1000}s)`,
  ]
  if (state.oneShotMs) {
    lines.push(`  next call only: ${state.oneShotMs}ms (${state.oneShotMs / 1000}s)`)
  }
  lines.push(`  per-tool-call reset: ${state.perToolCallReset ? "on" : "off"}`)
  lines.push(`  excluded tools: ${state.excluded.join(", ") || "(none)"}`)
  lines.push(`  raise limit with: timeout_limit_set(time_in_sec)`)
  return lines.join("\n")
}

export default {
  id: "timeout-limiter",
  setup: async (ctx: any) => {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "timeout_limit_set",
        description:
          "Set the hard timeout limit (in seconds) applied to tool calls. " +
          "By default the limit applies to the next tool call only and then " +
          "reverts to the normal limit; when the per-tool-call reset is off " +
          "it is persistent. Also re-enables the limiter if it was disabled. " +
          "The limiter itself can only be turned off by the user in the " +
          "terminal.",
        input: {
          type: "object",
          properties: { time_in_sec: { type: "number" } },
          required: ["time_in_sec"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const requested = Math.min(
            Math.max(Math.round(Number(input.time_in_sec) * 1000), MIN_LIMIT_MS),
            MAX_LIMIT_MS,
          )
          const state = loadState()
          const ceiling = state.ceilingMs
          const clamped = requested > ceiling
          const ms = Math.min(requested, ceiling)
          if (state.perToolCallReset) {
            state.oneShotMs = ms
          } else {
            state.limitMs = Math.min(ms, ceiling)
          }
          state.disabled = false
          saveState(state)
          const content = [
            `timeout-limiter: SET`,
            `  mode: ${state.perToolCallReset ? "next call only" : "persistent"}`,
            `  new limit: ${ms}ms (${ms / 1000}s)`,
            ...(state.perToolCallReset
              ? [`  reverts to: ${state.limitMs}ms (${state.limitMs / 1000}s)`]
              : []),
            `  limiter: ENABLED`,
            `  agent ceiling: ${ceiling}ms (${ceiling / 1000}s)`,
            `  per-tool-call reset: ${state.perToolCallReset ? "on" : "off"}`,
            `  excluded tools: ${state.excluded.join(", ") || "(none)"}`,
            `  raise further with: timeout_limit_set(time_in_sec)`,
            clamped
              ? `  clamped: yes (ask the user to increase the ceiling, decrease the scope, or change strategy)`
              : `  clamped: no`,
          ].join("\n")
          return {
            content,
            metadata: { limitMs: state.limitMs, oneShotMs: state.oneShotMs, disabled: false, ceilingMs: ceiling, clamped },
          }
        },
      })

      editor.add({
        name: "timeout_limit_status",
        description:
          "Show the current timeout-limiter status: whether it is enabled, the limit " +
          "for tool calls, the limit pending for the next call only, and the tools " +
          "that are excluded from it.",
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
              ceilingMs: state.ceilingMs,
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

        // Never wrap interactive tools — their TUI dialog contract must keep
        // the original execute untouched (see DEFAULT_EXCLUDED).
        if (matches(name, id, loadState().excluded)) continue

        editor.update(id, (definition: any) => {
          definition.execute = async (input: any, context: any) => {
            // Read fresh: the state is shared by every location.
            const state = loadState()
            const oneShot = state.disabled ? null : state.oneShotMs
            const limit = state.disabled ? 0 : (oneShot ?? state.limitMs)
            const isExcluded = matches(name, id, state.excluded)

            if (!limit || isExcluded) {
              return original(input, context)
            }

            // The one-shot belongs to the next real call, not to a call that
            // only inspects or changes the state.
            const consumesOneShot =
              oneShot !== null && !PLUGIN_TOOLS.has(name) && !PLUGIN_TOOLS.has(id)

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
                    [
                      `timeout-limiter: KILLED`,
                      `  tool: ${name}`,
                      `  killed after: ${limit}ms (${limit / 1000}s)`,
                      `  normal limit: ${state.limitMs}ms (${state.limitMs / 1000}s)`,
                      ...(state.oneShotMs
                        ? [`  next call only: ${state.oneShotMs}ms (${state.oneShotMs / 1000}s)`]
                        : []),
                      `  agent ceiling: ${state.ceilingMs}ms (${state.ceilingMs / 1000}s)`,
                      `  per-tool-call reset: ${state.perToolCallReset ? "on" : "off"}`,
                      `  excluded tools: ${state.excluded.join(", ") || "(none)"}`,
                      `  action: retry with a smaller scope; raise the limit for the next call with timeout_limit_set(time_in_sec); or ask the user to increase the ceiling, decrease the scope, or change strategy.`,
                    ].join("\n"),
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
              // place for the next call. Only clear the value that was
              // actually used: a raise set during the call is newer and must
              // survive.
              if (consumesOneShot) {
                const s = loadState()
                if (s.oneShotMs === oneShot) {
                  s.oneShotMs = null
                  saveState(s)
                }
              }
            }
          }
        })
      }
    })
  },
}
