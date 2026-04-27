import * as Tool from "./tool"
import { Session } from "../session"
import { MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Config } from "../config"
import { Permission } from "@/permission"
import { Effect, Schema } from "effect"
import type { TaskPromptOps } from "./task"

const id = "parallel_task"

const TaskItem = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
})

const Parameters = Schema.Struct({
  tasks: Schema.Array(TaskItem).annotate({
    description: "Array of tasks to run in parallel. Each task runs on its own agent concurrently. Minimum 2 tasks.",
  }),
})

export const ParallelTaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agentService = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("ParallelTaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const allAgents = yield* agentService.list()
      const callerInfo = yield* agentService.get(ctx.agent)
      const nonPrimary = allAgents.filter((a) => a.mode !== "primary")
      const accessible = callerInfo
        ? nonPrimary.filter((a) => Permission.evaluate("task", a.name, callerInfo.permission).action !== "deny")
        : nonPrimary
      const parallelAgents = accessible.filter((a) => a.parallel)

      if (parallelAgents.length === 0) {
        return yield* Effect.fail(new Error("No parallel-capable agents are configured."))
      }

      // Permission checks for all unique agent types
      if (!ctx.extra?.bypassAgentCheck) {
        const uniqueAgents = [...new Set(params.tasks.map((t) => t.subagent_type))]
        for (const agentType of uniqueAgents) {
          yield* ctx.ask({
            permission: "task",
            patterns: [agentType],
            always: ["*"],
            metadata: {
              description: `parallel: ${params.tasks.map((t) => t.description).join(", ")}`,
              subagent_type: agentType,
            },
          })
        }
      }

      yield* ctx.metadata({
        title: `${params.tasks.length} parallel tasks`,
        metadata: {
          tasks: params.tasks.map((t) => ({ description: t.description, agent: t.subagent_type })),
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("ParallelTaskTool requires promptOps in ctx.extra"))

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const baseModel = { modelID: msg.info.modelID, providerID: msg.info.providerID }

      const results = yield* Effect.forEach(
        params.tasks,
        Effect.fn("ParallelTaskTool.runTask")(function* (task) {
          const next = yield* agentService.get(task.subagent_type)
          if (!next) {
            return yield* Effect.fail(
              new Error(`Unknown agent type: ${task.subagent_type} is not a valid agent type`),
            )
          }

          const canTask = next.permission.some((rule) => rule.permission === "task")
          const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

          const model = next.model ?? baseModel

          const nextSession = yield* sessions.create({
            parentID: ctx.sessionID,
            title: task.description + ` (@${next.name} subagent)`,
            permission: [
              ...(canTodo
                ? []
                : [
                    {
                      permission: "todowrite" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              ...(canTask
                ? []
                : [
                    {
                      permission: "task" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              ...(cfg.experimental?.primary_tools?.map((item) => ({
                pattern: "*",
                action: "allow" as const,
                permission: item,
              })) ?? []),
            ],
          })

          const messageID = MessageID.ascending()

          function cancel() {
            ops.cancel(nextSession.id)
          }

          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              ctx.abort.addEventListener("abort", cancel)
            }),
            () =>
              Effect.gen(function* () {
                const parts = yield* ops.resolvePromptParts(task.prompt)
                const result = yield* ops.prompt({
                  messageID,
                  sessionID: nextSession.id,
                  model: {
                    modelID: model.modelID,
                    providerID: model.providerID,
                  },
                  agent: next.name,
                  tools: {
                    ...(canTodo ? {} : { todowrite: false }),
                    ...(canTask ? {} : { task: false }),
                    ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                  },
                  parts,
                })

                return {
                  description: task.description,
                  subagent_type: task.subagent_type,
                  sessionId: nextSession.id,
                  model,
                  output: result.parts.findLast((item) => item.type === "text")?.text ?? "",
                }
              }),
            () =>
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", cancel)
              }),
          )
        }),
        { concurrency: "unbounded" },
      )

      const firstSessionId = results[0]?.sessionId

      const output = results
        .map((r, i) => `[Task ${i + 1}: ${r.description} (@${r.subagent_type})]\n${r.output}`)
        .join("\n\n")

      return {
        title: `${results.length} parallel tasks`,
        metadata: {
          sessionId: firstSessionId,
          tasks: results.map((r) => ({ sessionId: r.sessionId, model: r.model })),
        },
        output,
      }
    })

    const allAgents = yield* agentService.list()
    const nonPrimary = allAgents.filter((a) => a.mode !== "primary")
    const parallelAgents = nonPrimary.filter((a) => a.parallel)

    if (parallelAgents.length === 0) {
      return {
        description: "No parallel-capable agents available.",
        parameters: Parameters,
        execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
          Effect.fail(new Error("No parallel-capable agents are configured.")).pipe(Effect.orDie),
      }
    }

    const agentList = parallelAgents.map((a) => `- ${a.name}: ${a.description ?? "No description"}`).join("\n")

    const description = `Run multiple subagent tasks in parallel. All tasks execute concurrently and results are returned together. Use this when you have 2+ independent lookups or tasks that can run simultaneously.

Available parallel agents:
${agentList}

Example: to search for API routes and data models at the same time:
{
  "tasks": [
    {"description": "Find API routes", "prompt": "Search for API route definitions...", "subagent_type": "explore"},
    {"description": "Find data models", "prompt": "Search for data model definitions...", "subagent_type": "explore-heavy"}
  ]
}

IMPORTANT: Always prefer parallel_task over sequential task calls when you have independent lookups. This runs them at the same time on different hardware.`

    return {
      description,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
