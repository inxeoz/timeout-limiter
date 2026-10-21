import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(STATE_DIR, "timeout-limiter.json")
const DEFAULT_LIMIT_MS = 15_000
const DEFAULT_EXCLUDED = ["question"]

type State = { limitMs: number; excluded: string[] }

function loadState(): State {
  try {
    const raw = readFileSync(STATE_FILE, "utf8")
    const parsed = JSON.parse(raw) as Partial<State>
    const limitMs =
      typeof parsed.limitMs === "number" && parsed.limitMs > 0
        ? parsed.limitMs
        : DEFAULT_LIMIT_MS
    const excluded = Array.isArray(parsed.excluded)
      ? parsed.excluded.filter((x): x is string => typeof x === "string")
      : DEFAULT_EXCLUDED
    return { limitMs, excluded }
  } catch {
    return { limitMs: DEFAULT_LIMIT_MS, excluded: [...DEFAULT_EXCLUDED] }
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

export default {
  id: "timeout-limiter",
  setup: async (ctx: any) => {
    const state = loadState()
    let limitMs = state.limitMs
    const excluded = new Set<string>(state.excluded)

    const persist = () => saveState({ limitMs, excluded: [...excluded] })
    persist()

    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const clearTimer = (id: string | undefined) => {
      if (!id) return
      const t = timers.get(id)
      if (t) {
        clearTimeout(t)
        timers.delete(id)
      }
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "set_timeout_limit",
        description:
          "Set the hard timeout limit (in seconds) applied to tool calls. " +
          "Persisted across sessions.",
        input: {
          type: "object",
          properties: { time_in_sec: { type: "number" } },
          required: ["time_in_sec"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const ms = Math.max(100, Math.round(Number(input.time_in_sec) * 1000))
          limitMs = ms
          persist()
          return {
            title: "timeout limit updated",
            output: `Hard timeout limit set to ${input.time_in_sec}s (${ms}ms).`,
            metadata: { limitMs: ms },
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
          const names = Array.isArray(input.tools) ? input.tools : []
          for (const n of names) excluded.add(String(n))
          persist()
          return {
            title: "timeout exclusions updated",
            output: `Excluded from timeout: ${[...excluded].join(", ") || "(none)"}.`,
            metadata: { excluded: [...excluded] },
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
          const names = Array.isArray(input.tools) ? input.tools : []
          for (const n of names) excluded.delete(String(n))
          persist()
          return {
            title: "timeout inclusions updated",
            output: `Excluded from timeout: ${[...excluded].join(", ") || "(none)"}.`,
            metadata: { excluded: [...excluded] },
          }
        },
      })
    })

    await ctx.tool.hook("execute.before", (event: any) => {
      const toolName = event.tool

      // Skip excluded tools entirely.
      if (excluded.has(toolName)) return

      // Clamp shell/bash requested timeout to the configured hard limit.
      if (toolName === "bash" || toolName === "shell") {
        if (event.input && typeof event.input === "object") {
          if (typeof event.input.timeout === "number") {
            event.input.timeout = Math.min(event.input.timeout, limitMs)
          } else {
            event.input.timeout = limitMs
          }
        }
      }

      if (event.id && event.sessionID) {
        const timer = setTimeout(() => {
          try {
            void ctx.session.interrupt({ sessionID: event.sessionID })
          } catch {
            // best effort
          }
        }, limitMs)
        timers.set(event.id, timer)
      }
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      clearTimer(event.id)
    })
  },
}