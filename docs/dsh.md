# Magic Context for DeepSeek Harness (DSH)

Magic Context's self-managing context for **DeepSeek Harness** (DSH `>= 0.1.0-rc`): compaction without pauses, decayed checkpoints, and agent-driven context drops — with each drop visible in the conversation flow.

The engineering log, seam map, and empirical verification live in [dsh-adaptation.md](./dsh-adaptation.md); the package README is [`packages/dsh-plugin/README.md`](../packages/dsh-plugin/README.md).

## What it does

- **Replaces the built-in compaction backend** (`ctx.compaction`) with `CompartmentEngine`:
  - **Async historian.** Summarization runs in the background; the agent never waits. Measured pre-step overhead 0–8 ms vs the inline baseline of ~14 s. The summary commits at the next fold boundary as one checkpoint node.
  - **Decay.** Checkpoint compartments re-render into shorter tiers at later fold boundaries, so old context shrinks further over time.
  - **`ctx_reduce`.** The agent marks spent tool outputs (`[ctx §N§]` tags) for removal; they commit at fold boundaries as `[dropped §N§]` placeholders, preserving tool-pairing. Each drop renders a record in the conversation flow — `⧉ Freed from context [dropped §N§] −N tok` — like the opencode TUI.
- **Token breakdown is intentionally not included.** DSH's own ContextMeter next to the send button covers occupancy; Magic Context adds no competing panel.

## Install

### Wizard

```bash
npx @cortexkit/magic-context@latest setup --harness dsh
```

Setup auto-detects the DSH install and profile, adds `@cortexkit/dsh-magic-context` to the profile's bundles, writes the patch layer (disables the default `compaction-basic` entry, enables `mc-compaction` with sensible defaults), and checks `historian.model` in the shared `.cortexkit/magic-context.jsonc`. `doctor --harness dsh` verifies the result.

> Registry install requires `@cortexkit/dsh-magic-context` to be published to npm. Until then setup prints the manual steps below instead.

### Manual (dev profile)

```sh
# 1. Install the package into a dev profile (forwards to pnpm)
dsh plugin --profile mc-dev add "file:$PWD/packages/dsh-plugin"

# 2. Add the bundle to the profile manifest
#    $DSH_HOME/profiles/mc-dev/package.json:
#      "dsh": { "profile": { "bundles": [
#        "@deepseek-ai/dsh-base",
#        "@deepseek-ai/dsh-headless",   # or @deepseek-ai/dsh-web-app
#        "@cortexkit/dsh-magic-context"
#      ] } }

# 3. Patch layer — see "Disabling the built-in compaction" below

# 4. Boot
DSH_HOME=... dsh --profile mc-dev "run a long task"
```

## Configuration

Profile patch layer (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: mc-compaction
  config:
    auto: true
    maxTokens: 4096            # summary output cap
    thresholdRatio: 0.8        # compact when surface > ratio × model context window
    retainRatio: 0.16          # MUST stay below thresholdRatio
    summarizationProvider: opencode-go   # historian target
    summarizationModel: deepseek-v4-flash
```

The historian model also resolves from the shared project config `.cortexkit/magic-context.jsonc` (`historian.model: "provider/model"`), falling back to the session's routed model — so a project already configured for OpenCode or Pi works unchanged. With gateway models reporting 1M-token windows, tune `thresholdRatio` per profile so the trigger lands at a few tens of thousands of tokens (e.g. `0.005` for a ~5k-token trigger in short UI sessions).

## Disabling the built-in compaction

Same rule as the other harnesses — Magic Context manages context itself, so the host backend must be off:

- **Headless / CLI profiles** (`dsh-base` + `dsh-headless` bundles): the base bundle mounts `compaction-basic`. The patch layer MUST disable it:

  ```yaml
  - id: compaction-basic
    disabled: true
  ```

  (`setup --harness dsh` writes this automatically.)
- **Web profiles** (`dsh-base` + `dsh-web-app` bundles): the web-app bundle already disables `compaction-basic` (plus `command-compact` and `tool-result-pruner`) — only the `mc-compaction` config entry is needed.

Cordis services are single-provider: leaving the built-in engine mounted next to Magic Context's is a boot-time error, not silent double-compaction.

## Behavior notes

- **Drops ride fold boundaries.** `ctx_reduce` only queues; the replacement commits when the next compaction fold lands (cache-safe). A drop whose node was already folded is cleared as stale. If a session never folds again, queued drops stay pending.
- **Drop records** render in the conversation flow (live and after reload). The match only claims Magic Context placeholders, so the in-box tool-output pruner's truncations are unaffected.
- **Diagnostics:** `MC_DSH_DEBUG=1` writes `.dsh-ref/mc-debug.log`; the store lives at `MC_DSH_DB` (default `~/.local/share/cortexkit/magic-context/dsh-context.db`).

## Current status and limitations

- Verified end-to-end on real sessions: async historian + checkpoint commits, decay demotions, drop commits (stale-clear and replacement), replay determinism (byte-identical folds), and the client drop records on both live and history paths.
- **Verified against DSH `0.1.1-rc.2`** (the current release line): the plugin dependencies are aligned to `0.1.1-rc.2` (cordis pinned to `4.0.1`, matching the runtime). The compaction/session/projection/client seams we use are unchanged since the `0.1.0-rc.6` adaptation base, and the full pipeline (mount, async historian + summarizer, `ctx_reduce`, drop-record rendering) was re-verified on the new runtime.
- **`ctx_expand` is not implemented yet** (expanding a folded span has a natural home in the append-only log; see the divergence notes in `dsh-adaptation.md`).
- **npm publication pending** — until `@cortexkit/dsh-magic-context` is published, use the manual install path.
- The `mcBreakdown` projection remains registered server-side (observation-only; powers debug snapshots) but has no client consumer.
