import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PendingNudges, buildIdentityPaths, type RecallCandidate } from "@oh-my-opencode/memory-core"

import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext, type MemoryIdentityContext } from "./context"
import { createMemorianGateWiring, type MemorianGatePort } from "./memorian-wiring"
import type { CollectedRecallCandidates } from "./recall-wiring"
import { rmEfaultTolerant } from "./teardown.test-support"

const IDENTITY = "memorian-agent"
const SESSION_ID = "session-gate-1"
const CANDIDATE_PATH = "reference/kubernetes-rollouts.md"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

const CANDIDATES: readonly RecallCandidate[] = [
  { path: CANDIDATE_PATH, description: "Rollout policy", excerpt: "drain first", score: 1 },
]

async function context(): Promise<MemoryIdentityContext> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memorian-wiring-")))
  roots.push(root)
  return createMemoryIdentityContext({
    identity: IDENTITY,
    identityPaths: buildIdentityPaths(root, IDENTITY),
    binding: createMemoryBinding({ identity: IDENTITY, repoPath: join(root, "repo"), boundAt: 0 }),
  })
}

function collected(identity: MemoryIdentityContext): CollectedRecallCandidates {
  return {
    sessionId: SESSION_ID,
    context: identity,
    candidates: CANDIDATES,
    surfaced: new Set<string>(),
    maxItems: 2,
    transcript: [{ role: "user", text: "how do we handle kubernetes rollouts" }],
  }
}

type Launch = Parameters<MemorianGatePort["launch"]>[0]

function gate(input: {
  readonly collect: () => Promise<CollectedRecallCandidates | undefined>
  readonly launches: Launch[]
  readonly identity?: MemoryIdentityContext
  readonly launch?: MemorianGatePort["launch"]
  readonly logs?: Array<{ message: string, details?: unknown }>
}) {
  return createMemorianGateWiring({
    collectCandidates: input.collect,
    resolveContext: (sessionId) => (sessionId === SESSION_ID ? input.identity : undefined),
    runnerFor: () => ({
      launch: input.launch ?? (async (launchInput) => {
        input.launches.push(launchInput)
        return { status: "empty" as const }
      }),
    }),
    ...(input.logs === undefined
      ? {}
      : {
          logger: {
            info: (message, details) => input.logs?.push({ message, details }),
            warn: (message, details) => input.logs?.push({ message, details }),
            error: (message, details) => input.logs?.push({ message, details }),
          },
        }),
  })
}

describe("createMemorianGateWiring onSettled", () => {
  test("#given collected candidates #when a turn settles #then the gate child launches with the judge's inputs", async () => {
    // given
    const identity = await context()
    const launches: Launch[] = []
    const wiring = gate({ collect: async () => collected(identity), launches })

    // when
    wiring.onSettled({})
    await wiring.whenIdle()

    // then
    expect(launches).toEqual([
      {
        sessionId: SESSION_ID,
        candidates: CANDIDATES,
        surfaced: new Set<string>(),
        maxItems: 2,
        transcript: [{ role: "user", text: "how do we handle kubernetes rollouts" }],
      },
    ])
  })

  test("#given no collected candidates #when a turn settles #then no gate child launches", async () => {
    // given: collection already encodes the recall.enabled gate, the sentinel gate and empty matches
    const launches: Launch[] = []
    const wiring = gate({ collect: async () => undefined, launches })

    // when
    wiring.onSettled({})
    await wiring.whenIdle()

    // then
    expect(launches).toEqual([])
  })

  test("#given a settle handler #when the launch rejects #then the turn is unaffected and the failure is logged", async () => {
    // given
    const identity = await context()
    const logs: Array<{ message: string, details?: unknown }> = []
    const wiring = gate({
      collect: async () => collected(identity),
      launches: [],
      launch: async () => {
        throw new Error("gate exploded")
      },
      logs,
    })

    // when
    wiring.onSettled({})
    await wiring.whenIdle()

    // then
    expect(logs).toHaveLength(1)
  })

  test("#given a ctx that goes stale once the handler returns #when a turn settles #then the launch still uses the snapshotted registry", async () => {
    // given: the real senpi ctx is invalidated by AgentSession dispose the moment the settle
    // handler returns, so any ctx read from the detached task throws assertActive's stale error.
    const identity = await context()
    const registry = { getAvailable: () => [], find: () => undefined }
    let stale = false
    const eventCtx = {
      get modelRegistry(): unknown {
        if (stale) throw new Error("This extension ctx is stale after session replacement or reload.")
        return registry
      },
    }
    const launches: Launch[] = []
    const logs: Array<{ message: string, details?: unknown }> = []
    const wiring = createMemorianGateWiring({
      // Collection is handed the snapshot, never the live ctx.
      collectCandidates: async () => collected(identity),
      resolveContext: () => identity,
      runnerFor: () => ({
        launch: async (launchInput) => {
          launches.push(launchInput)
          return { status: "empty" as const }
        },
      }),
      resolveModelRegistry: (ctx) => (ctx as { modelRegistry?: unknown }).modelRegistry as never,
      logger: {
        info: (message, details) => logs.push({ message, details }),
        warn: (message, details) => logs.push({ message, details }),
        error: (message, details) => logs.push({ message, details }),
      },
    })

    // when: the handler returns, THEN the host disposes the ctx
    wiring.onSettled(eventCtx)
    stale = true
    await wiring.whenIdle()

    // then: the gate still launched, carrying the registry captured before dispose
    expect(logs).toEqual([])
    expect(launches).toHaveLength(1)
    expect(launches[0]?.modelRegistry).toBe(registry)
  })

  test("#given a settle #when the handler returns #then it never waits on the gate child", async () => {
    // given: the settle path must not block on an advisory read
    const identity = await context()
    let released = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      released = resolve
    })
    const wiring = gate({
      collect: async () => collected(identity),
      launches: [],
      launch: async () => {
        await blocked
        return { status: "empty" as const }
      },
    })

    // when
    const returned = wiring.onSettled({})

    // then
    expect(returned).toBeUndefined()
    released()
    await wiring.whenIdle()
  })
})

describe("createMemorianGateWiring onCompactionAccepted", () => {
  test("#given pending nudges #when a compaction is accepted #then they are dropped instead of surfacing after the rewrite", async () => {
    // given: the nudges judged the pre-compaction transcript, which no longer exists
    const identity = await context()
    const pending = new PendingNudges(identity.identityPaths.recallPending)
    await pending.write(SESSION_ID, [{ path: CANDIDATE_PATH, hint: "Drain nodes first." }])
    const wiring = gate({ collect: async () => undefined, launches: [], identity })

    // when
    wiring.onCompactionAccepted(SESSION_ID)
    await wiring.whenIdle()

    // then
    expect(await pending.take(SESSION_ID)).toEqual([])
  })

  test("#given another session's pending nudges #when a compaction is accepted #then they survive untouched", async () => {
    // given
    const identity = await context()
    const pending = new PendingNudges(identity.identityPaths.recallPending)
    await pending.write("other-session", [{ path: CANDIDATE_PATH, hint: "Drain nodes first." }])
    const wiring = gate({ collect: async () => undefined, launches: [], identity })

    // when
    wiring.onCompactionAccepted(SESSION_ID)
    await wiring.whenIdle()

    // then
    expect(await pending.take("other-session")).toEqual([
      { path: CANDIDATE_PATH, hint: "Drain nodes first." },
    ])
  })
})
