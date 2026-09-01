import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, realpathSync, writeFileSync } from "node:fs"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  PendingNudges,
  buildIdentityPaths,
  type MemoryIdentityPaths,
  type RecallCandidate,
} from "@oh-my-opencode/memory-core"
import type { SenpiModelPort } from "@oh-my-opencode/senpi-task"

import { MemorianGateRunner } from "./memorian-runner"
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

const MODEL: SenpiModelPort = { provider: "omo-mock", id: "mock-1" }

const CANDIDATES: readonly RecallCandidate[] = [
  { path: CANDIDATE_PATH, description: "Rollout policy", excerpt: "drain first", score: 1 },
]

async function fixture(): Promise<{ root: string, identityPaths: MemoryIdentityPaths }> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memorian-runner-")))
  roots.push(root)
  return { root, identityPaths: buildIdentityPaths(root, IDENTITY) }
}

/** A stub child: writes the scripted NDJSON to $MEMORIAN_NUDGE_PATH, then exits. */
function stubChild(root: string, script: string): { senpiCommand: string, senpiPrefixArgs: readonly string[] } {
  const file = join(root, `stub-child-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, script, "utf8")
  return { senpiCommand: process.execPath, senpiPrefixArgs: [file] }
}

const WRITE_ONE_NUDGE = `
import { appendFileSync } from "node:fs"
const target = process.env.MEMORIAN_NUDGE_PATH
if (target === undefined) throw new Error("no nudge sink")
if (process.env.SENPI_MEMORY_MEMORIAN !== "1") throw new Error("no memorian sentinel")
appendFileSync(target, JSON.stringify({ path: ${JSON.stringify(CANDIDATE_PATH)}, hint: "Drain nodes before a rollout." }) + "\\n")
`

function runnerOptions(
  identityPaths: MemoryIdentityPaths,
  overrides: Partial<ConstructorParameters<typeof MemorianGateRunner>[0]> = {},
): ConstructorParameters<typeof MemorianGateRunner>[0] {
  return {
    identityPaths,
    loadConfig: () => ({
      config: { categories: { quick: { model: "omo-mock/mock-1" } } },
      diagnostics: [],
      layers: [],
      sources: [],
    }),
    resolveModelRegistry: () => ({
      getAvailable: () => [MODEL],
      find: (provider, modelId) => (provider === MODEL.provider && modelId === MODEL.id ? MODEL : undefined),
    }),
    env: {},
    ...overrides,
  }
}

function launchInput(overrides: Partial<Parameters<MemorianGateRunner["launch"]>[0]> = {}) {
  return {
    sessionId: SESSION_ID,
    candidates: CANDIDATES,
    surfaced: new Set<string>(),
    maxItems: 2,
    transcript: [{ role: "user" as const, text: "how do we handle kubernetes rollouts" }],
    ...overrides,
  }
}

describe("MemorianGateRunner", () => {
  test("#given a scripted gate child #when the runner launches #then the validated nudge lands in the pending store", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(root, WRITE_ONE_NUDGE)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, stub))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result.status).toBe("nudged")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID)).toEqual([
      { path: CANDIDATE_PATH, hint: "Drain nodes before a rollout." },
    ])
  }, 30_000)

  test("#given the quick category cannot resolve #when the runner launches #then it warns, skips and spawns nothing", async () => {
    // given
    const { identityPaths } = await fixture()
    const warnings: string[] = []
    let spawned = 0
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      loadConfig: () => ({ config: { categories: {} }, diagnostics: [], layers: [], sources: [] }),
      resolveModelRegistry: () => ({ getAvailable: () => [], find: () => undefined }),
      logger: { info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined },
      sandbox: (args) => {
        spawned += 1
        return args
      },
    }))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result.status).toBe("skipped")
    expect(spawned).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID)).toEqual([])
  }, 30_000)

  test("#given a launch already in flight #when a second trigger arrives #then only one child runs", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(root, `${WRITE_ONE_NUDGE}\nawait new Promise((resolve) => setTimeout(resolve, 300))\n`)
    let spawned = 0
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, {
      ...stub,
      sandbox: (args) => {
        spawned += 1
        return args
      },
    }))

    // when
    const [first, second] = await Promise.all([runner.launch(launchInput()), runner.launch(launchInput())])

    // then
    expect(spawned).toBe(1)
    expect([first.status, second.status].sort()).toEqual(["active", "nudged"])
  }, 30_000)

  test("#given a child that fabricates a path #when the runner validates #then nothing is pending", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(
      root,
      `
import { appendFileSync } from "node:fs"
appendFileSync(process.env.MEMORIAN_NUDGE_PATH, JSON.stringify({ path: "notes/never-offered.md", hint: "nope" }) + "\\n")
`,
    )
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, stub))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result.status).toBe("empty")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID)).toEqual([])
  }, 30_000)

  test("#given a crashing gate child #when the runner launches #then it reports the skip without throwing and writes no pending", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(root, "process.exit(7)\n")
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, stub))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result.status).toBe("failed")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID)).toEqual([])
  }, 30_000)

  test("#given a child that outlives the deadline #when the runner launches #then the run is abandoned with no pending nudges", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(
      root,
      "await new Promise((resolve) => setTimeout(resolve, 30_000))\n",
    )
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, { ...stub, deadlineMs: 200 }))

    // when
    const result = await runner.launch(launchInput())

    // then
    expect(result.status).toBe("failed")
    expect(await new PendingNudges(identityPaths.recallPending).take(SESSION_ID)).toEqual([])
  }, 30_000)

  test("#given a completed run #when the runner finishes #then the run directory is removed", async () => {
    // given
    const { root, identityPaths } = await fixture()
    const stub = stubChild(root, WRITE_ONE_NUDGE)
    const runner = new MemorianGateRunner(runnerOptions(identityPaths, stub))

    // when
    await runner.launch(launchInput())

    // then
    const runsDir = join(identityPaths.recall, "runs")
    expect(existsSync(runsDir) ? await readdir(runsDir) : []).toEqual([])
  }, 30_000)
})
