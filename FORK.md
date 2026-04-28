# Fork notes

This is a fork of [`sst/opencode`](https://github.com/sst/opencode) maintained at [`adurham/opencode`](https://github.com/adurham/opencode). The default branch is `main`; upstream tracks `dev`.

## What this fork adds

Three features not in upstream, all in `packages/opencode/src/`:

### 1. `parallel_task` tool

Runs multiple subagent tasks concurrently in a single tool call instead of serial `task` invocations. Mirrors the existing `task.ts` design but uses `Effect.forEach` with `concurrency: "unbounded"` to fan out and collect results.

- Tool: `tool/parallel-task.ts`
- Wired in: `tool/registry.ts`, `cli/cmd/run.ts`, `cli/cmd/tui/routes/session/index.tsx`
- Agent config: adds a `parallel: boolean` flag to `agent/agent.ts` — only agents with `parallel: true` are eligible targets, and the tool's description lists them at registration time
- Permissions: per-task `task` permission check is performed for each unique `subagent_type` before fan-out; honors `bypassAgentCheck`
- Tool description prompts the model to prefer `parallel_task` over sequential `task` calls when lookups are independent

Originating commit: `26f38386d`. Typecheck fixes follow-up: `f6c9b5d88`, `7588ca933`.

### 2. URL auto-fetch in user messages

Pre-fetches up to 3 URLs found in user text parts and injects their content as synthetic context, mirroring how dropped files are auto-read. Eliminates the model needing to call `webfetch` itself for URLs the user explicitly pasted.

- Implementation: `session/prompt.ts` (the user-text branch in `resolvePromptParts`)
- Surfaces the existing `webfetch` tool through `ToolRegistry.named()` (see `tool/registry.ts` — adds `webfetch: WebFetchDef` to the registry's named tools and `Interface`)
- Behavior: regex-extracts `https?://` URLs, dedups, takes first 3, runs each through `webfetch` with `format: "markdown"`, wraps successful output as `<url url="...">…</url>` synthetic text part
- Failures are silently dropped (the URL just doesn't get pre-fetched)

Caveats: no opt-out, no allowlist, no rate-limit awareness. Currently always-on for any text part containing URLs.

Originating commit: `a1f7c5e73`.

### 3. `exo` cluster as a built-in provider

Registers exo ([`exo-explore/exo`](https://github.com/exo-explore/exo), distributed local-model inference) as a first-class provider alongside the model-dev catalog providers. Uses the OpenAI-compatible SDK and discovers available models dynamically from the cluster.

- Implementation: `provider/provider.ts`
- Defaults: `http://localhost:52415/v1`, override via `EXO_API_URL` env var or `provider.exo.options.baseURL` in config
- Reachability: 500ms timeout probe of `GET /models` at load time — if the cluster is unreachable AND no models are pre-configured, autoload is disabled (so it stays out of the way when exo isn't running)
- Model discovery: when reachable, fetches `GET /models` and converts each entry into an opencode `Model` with sensible defaults (8192 context, 4096 output, vision capability inferred from `capabilities` array)
- Cost is set to zero across the board (assumed self-hosted)
- Default request timeout is 10 minutes (`options.timeout: 600_000`) — local cluster generation is slower and more bursty than frontier APIs. Override via `provider.exo.options.timeout` in config or set to `false` to disable.

This commit also includes a small generalization: the gitlab-specific discovery-loader trigger in the provider layer was replaced with a loop over all registered `discoveryLoaders`, so any provider with a `discoverModels()` returns picks up the same wiring. That refactor is independent of the exo provider itself and is a clear standalone improvement.

Originating commit: `f7c0e71dd`. Tuning follow-up: `<pending>`.

#### Per-model config overrides

For any provider that returns a `discoverModels()` (currently exo, gitlab), config entries under `provider.<id>.models.<modelID>` are now **layered on top of** the discovered model rather than replacing it. The discovered base supplies `api.url`, `api.id`, dynamic `limit.context`, etc.; user-set fields in config take precedence per-field.

Useful for tagging local models with their actual capabilities without redefining everything:

```jsonc
{
  "provider": {
    "exo": {
      "options": { "timeout": 1200000 },
      "models": {
        "deepseek-r1": {
          "reasoning": true,
          "interleaved": { "field": "reasoning_content" }
        },
        "qwen2.5-7b": {
          "tool_call": false,
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  }
}
```

Implementation: `applyConfigOverrides()` in `provider/provider.ts`, called from the discovery loop. Field mapping mirrors the main config-model parser.

## Untracked / WIP

- `packages/opencode/src/provider/models-snapshot.ts` — present in the working tree, not committed. Origin/purpose unverified.

## Upstream status

| Feature | Upstreamability |
| --- | --- |
| `discoveryLoaders` generalization (carved out of the exo commit) | Easy PR — pure refactor, no behavior change for existing providers |
| `exo` provider | Likely accepted — clean implementation, real OSS project. File after the refactor PR lands |
| `parallel_task` | Needs design discussion first — duplicates much of `task.ts` and adds an agent-config field; some maintainers prefer model-driven parallelism (multiple `task` calls in one turn) over a dedicated tool |
| URL auto-fetch | Needs config gating before submitting — current always-on behavior with hardcoded limits will get pushed back on for cost/privacy reasons |

## Building locally

```sh
cd packages/opencode
bun run build --single
```

Builds only for the current platform (`darwin-arm64` here). Output: `packages/opencode/dist/opencode-darwin-arm64/bin/opencode`.

The `opencode-local` shell alias (in `~/.zshrc`) points at that binary so the fork build can be invoked alongside the npm-installed `opencode`.

## Syncing with upstream

```sh
git fetch upstream
git merge upstream/dev
```

Local `main` carries the fork commits on top of the upstream history. The husky pre-push hook runs `bun turbo typecheck`; upstream refactors that touch shared modules (e.g. the recent barrel-removal refactor) can break the fork commits and need to be patched on top of the merge before pushing.

Remotes:

- `origin` → `https://github.com/adurham/opencode.git` (default branch: `main`)
- `upstream` → `https://github.com/sst/opencode.git`
