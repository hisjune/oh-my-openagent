// Memorian gate runner (plan .omo/plans/memorian-m3-gate.md todo 7).
//
// At settle, when lexical candidates exist, ONE quick-category child judges them against the recent
// transcript and answers only through the nudge tool. The launch follows the facts runner's
// semantics - resolveReflectionModel("quick"), warn+skip when the category cannot resolve, no
// fallback ladder, one activeLaunch latch - but carries NO durable machinery: there is no queue, no
// failure store and no run ledger, because a gate run that dies is simply a turn without a nudge.
// The run directory is scratch and is removed once the NDJSON has been read.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import {
  PendingNudges,
  parseNudgeLines,
  validateNudges,
  type MemoryIdentityPaths,
  type RecallCandidate,
  type RecallNudge,
} from "@oh-my-opencode/memory-core"
import type { SenpiModelPort, SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"

import type { ComponentLogger } from "../../extension/types"
import type { SenpiOmoConfigResult } from "../config-resolution"
import { resolveReflectionModel } from "./worker/resolve-model"
import { prepareMemorianSpawn } from "./worker/spawn"
import type { MemorianSandbox, MemorianSpawnArgs, MemorianTranscriptTurn } from "./worker/spawn"

const QUICK_CATEGORY = "quick"
/** The gate advises a turn that already ended; anything slower than this is worthless. */
const DEFAULT_DEADLINE_MS = 5 * 60_000
const TERMINATION_GRACE_MS = 2_000

export interface MemorianGateRunnerOptions {
  readonly identityPaths: MemoryIdentityPaths
  readonly loadConfig: () => SenpiOmoConfigResult
  readonly resolveModelRegistry: () => SenpiModelRegistryPort<SenpiModelPort> | undefined
  readonly env: NodeJS.ProcessEnv
  readonly deadlineMs?: number
  readonly sandbox?: MemorianSandbox
  /** QA stubbing seam, mirroring the facts runner: the pair replaces the resolved senpi launcher. */
  readonly senpiCommand?: string
  readonly senpiPrefixArgs?: readonly string[]
  readonly logger?: ComponentLogger
}

export interface MemorianGateLaunchInput {
  readonly sessionId: string
  readonly candidates: readonly RecallCandidate[]
  /** Paths already surfaced this session; the parent re-checks them after the child answers. */
  readonly surfaced: ReadonlySet<string>
  readonly maxItems: number
  readonly transcript: readonly MemorianTranscriptTurn[]
}

export type MemorianGateLaunchResult =
  /** Another gate run holds the latch; this trigger is dropped. */
  | { readonly status: "active" }
  /** No candidates, or the quick category could not resolve. */
  | { readonly status: "skipped" }
  /** The child ran and said nothing the parent accepted. */
  | { readonly status: "empty" }
  /** The child crashed or outran its deadline. */
  | { readonly status: "failed" }
  | { readonly status: "nudged"; readonly nudges: readonly RecallNudge[] }

export class MemorianGateRunner {
  private activeLaunch: Promise<MemorianGateLaunchResult> | undefined

  constructor(private readonly options: MemorianGateRunnerOptions) {}

  /**
   * Fire one gate run. Never throws: the caller is a settle handler, and a failed advisor must
   * leave the turn exactly as it found it.
   */
  async launch(input: MemorianGateLaunchInput): Promise<MemorianGateLaunchResult> {
    if (this.activeLaunch !== undefined) return { status: "active" }
    const operation = this.launchOnce(input).catch((error: unknown) => {
      this.options.logger?.warn("memorian gate launch failed", { error: describe(error) })
      return { status: "failed" } as const
    })
    this.activeLaunch = operation
    try {
      return await operation
    } finally {
      if (this.activeLaunch === operation) this.activeLaunch = undefined
    }
  }

  private async launchOnce(input: MemorianGateLaunchInput): Promise<MemorianGateLaunchResult> {
    if (input.candidates.length === 0 || input.maxItems <= 0) return { status: "skipped" }
    const loaded = this.options.loadConfig()
    const resolution = resolveReflectionModel(QUICK_CATEGORY, loaded.config, this.options.resolveModelRegistry())
    if (resolution.kind === "category_unavailable") {
      // Same decision as the facts extractor: the gate is quick-pinned and never falls back to a
      // pricier category, because an advisory read must not cost more than the turn it advises.
      this.options.logger?.warn("memorian gate quick category unavailable", { cause: resolution.cause })
      return { status: "skipped" }
    }

    const runDir = join(this.options.identityPaths.recall, "runs", randomUUID())
    await mkdir(runDir, { recursive: true, mode: 0o700 })
    try {
      const spawnArgs = await prepareMemorianSpawn({
        runDir,
        candidates: input.candidates,
        surfaced: [...input.surfaced],
        maxItems: input.maxItems,
        transcript: input.transcript,
        model: resolution.model,
        ...(resolution.thinking === undefined ? {} : { thinking: resolution.thinking }),
        hardDeadlineAt: Date.now() + (this.options.deadlineMs ?? DEFAULT_DEADLINE_MS),
        env: this.options.env,
        ...(this.options.senpiCommand === undefined ? {} : { senpiCommand: this.options.senpiCommand }),
        ...(this.options.senpiPrefixArgs === undefined ? {} : { senpiPrefixArgs: this.options.senpiPrefixArgs }),
      })
      const prepared = await (this.options.sandbox ?? passthrough)(spawnArgs)
      const completed = await runMemorianChild(prepared)
      if (!completed) return { status: "failed" }
      const nudges = validateNudges(parseNudgeLines(await readNudges(prepared.paths.nudges)), {
        candidates: new Set(input.candidates.map((candidate) => candidate.path)),
        surfaced: input.surfaced,
        maxItems: input.maxItems,
      })
      if (nudges.length === 0) return { status: "empty" }
      await new PendingNudges(this.options.identityPaths.recallPending).write(input.sessionId, nudges)
      return { status: "nudged", nudges }
    } finally {
      // Scratch only: the NDJSON has been read, so nothing here survives the run.
      await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * Run the detached child under an absolute deadline. Resolves false for any non-clean end (crash,
 * non-zero exit, deadline, spawn failure); the caller turns that into a silent skip.
 */
async function runMemorianChild(spawnArgs: MemorianSpawnArgs): Promise<boolean> {
  const child = spawn(spawnArgs.command, [...spawnArgs.args], {
    cwd: spawnArgs.cwd,
    env: spawnArgs.env,
    detached: spawnArgs.detached,
    stdio: "ignore",
    windowsHide: true,
  })
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(grace)
      resolve(value)
    }
    let grace: ReturnType<typeof setTimeout> | undefined
    const deadline = setTimeout(() => {
      kill(child, "SIGTERM")
      grace = setTimeout(() => {
        kill(child, "SIGKILL")
        settle(false)
      }, TERMINATION_GRACE_MS)
      grace.unref?.()
    }, Math.max(0, spawnArgs.hardDeadlineAt - Date.now()))
    deadline.unref?.()
    child.once("error", () => settle(false))
    child.once("close", (code) => settle(code === 0))
  })
}

function kill(child: { readonly pid?: number, kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  try {
    // The child is detached, so it leads its own process group: signal the GROUP or a senpi that
    // spawned helpers would leave them behind.
    if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

async function readNudges(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    // A silent judge writes no file at all; that is the documented default, not an error.
    return ""
  }
}

function passthrough(spawnArgs: MemorianSpawnArgs): MemorianSpawnArgs {
  return spawnArgs
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
