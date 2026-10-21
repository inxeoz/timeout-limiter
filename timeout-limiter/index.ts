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

// A tool is excluded when its short name or its namespaced id matches.
function matches(name: string, id: string, list: string[]): boolean {
  for (const entry of list) {
    if (name === entry || id === entry || id.endsWith(`_${entry}`)) return true
  }
  return false
}

function describe(state: State): string {
  return [
    `timeout-limiter: ${state.disabled ? "DISABLED" : "ENABLED"}`,
    `  limit: ${state.limitMs}ms (${state.limitMs / 1000}s)`,
    `  excluded tools: ${state.excluded.join(", ") || "(none)"}`,
    `  state file: ${STATE_FILE}`,
    `  change it with /set-timeout-limiter <seconds>s,`,
    `  turn it off with /disable-timeout-limiter, show it with /show-timeout-limiter`,
  ].join("\n")
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
          const state = loadState()
          const ms = Math.min(
            Math.max(Math.round(Number(input.time_in_sec) * 1000), MIN_LIMIT_MS),
            MAX_LIMIT_MS,
          )
          state.limitMs = ms
          state.disabled = false
          saveState(state)
          return {
            content: `Hard timeout limit set to ${ms}ms.`,
            metadata: { limitMs: ms, disabled: false },
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
              disabled: state.disabled,
              excluded: state.excluded,
            },
          }
        },
      })
    })

    // Slash commands live in tui.ts: they run in the terminal, so they show
    // the status without waking the model and without touching the session.

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
            const limit = state.disabled ? 0 : state.limitMs
            if (!limit || matches(name, id, state.excluded)) {
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
            }
          }
        })
      }
    })
  },
}
