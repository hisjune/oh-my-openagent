// Memorian gate wiring (plan .omo/plans/memorian-m3-gate.md todo 8): the settle-side half of the
// gate. It owns no events of its own - the memory component's existing agent_settled handler and
// the reflection trigger's session_compact seam call in - because the gate must observe exactly the
// turns those handlers already agreed were complete.
//
// Nothing here is awaited by the host. A settle returns the instant the work is queued: the gate is
// advisory, and a turn must never pay for the advice about the turn that just ended.

import { PendingNudges, type RecallCandidate } from "@oh-my-opencode/memory-core"
import type { SenpiModelPort, SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"

import type { ComponentLogger } from "../../extension/types"
import type { MemoryIdentityContext } from "./context"
import type { CollectedRecallCandidates, RecallSessionSnapshot, RecallTranscriptTurn } from "./recall-wiring"

/** The runner seam. Tests and the QA driver substitute a stub; production passes the real runner. */
export interface MemorianGatePort {
  launch(input: {
    readonly sessionId: string
    readonly candidates: readonly RecallCandidate[]
    readonly surfaced: ReadonlySet<string>
    readonly maxItems: number
    readonly transcript: readonly RecallTranscriptTurn[]
    /** Captured at settle, before the host disposed the ctx the registry lives on. */
    readonly modelRegistry?: SenpiModelRegistryPort<SenpiModelPort> | undefined
  }): Promise<unknown>
}

export interface MemorianGateWiringOptions {
  /** Settle-time lexical collection; undefined already means disabled, sentinel, or no match. */
  readonly collectCandidates: (eventCtx: unknown) => Promise<CollectedRecallCandidates | undefined>
  /** Synchronous ctx read, called before the launch detaches. */
  readonly snapshotSession?: (eventCtx: unknown) => RecallSessionSnapshot | undefined
  /** Collection over the captured snapshot; consumes no ctx. */
  readonly collectCandidatesFromSnapshot?: (
    snapshot: RecallSessionSnapshot,
  ) => Promise<CollectedRecallCandidates | undefined>
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  readonly runnerFor: (context: MemoryIdentityContext) => MemorianGatePort
  /**
   * Reads the model registry off the live senpi ctx. Called SYNCHRONOUSLY inside onSettled, because
   * the host disposes the ctx the moment the handler returns and every later read throws.
   */
  readonly resolveModelRegistry?: (eventCtx: unknown) => SenpiModelRegistryPort<SenpiModelPort> | undefined
  readonly pendingFor?: (context: MemoryIdentityContext) => Pick<PendingNudges, "take">
  readonly logger?: ComponentLogger
}

export interface MemorianGateWiring {
  /** Fire-and-forget gate launch for a settled turn. Returns immediately. */
  onSettled(eventCtx: unknown): void
  /** Accepted compaction: the pending nudges judged a transcript that no longer exists. */
  onCompactionAccepted(sessionId: string): void
  /** Resolves once every launch started so far has finished; tests await this instead of sleeping. */
  whenIdle(): Promise<void>
}

export function createMemorianGateWiring(options: MemorianGateWiringOptions): MemorianGateWiring {
  const pendingFor = options.pendingFor
    ?? ((context: MemoryIdentityContext) => new PendingNudges(context.identityPaths.recallPending))
  const inFlight = new Set<Promise<void>>()

  function track(task: () => Promise<void>): void {
    const promise = task()
      .catch((error: unknown) => {
        // The gate is advisory in both directions: a failed launch leaves the next turn exactly as
        // it would have been without memory.
        options.logger?.warn("omo-senpi memorian gate failed", { error: describe(error) })
      })
      .finally(() => {
        inFlight.delete(promise)
      })
    inFlight.add(promise)
  }

  return {
    onSettled(eventCtx: unknown): void {
      // Snapshot every ctx-derived input BEFORE detaching. The launch below is fire-and-forget by
      // contract, and the host runs AgentSession dispose -> _extensionRunner.invalidate() as soon as
      // this handler returns; any ctx read from the detached task then throws the stale-ctx error and
      // the gate silently never spawns. Everything the async part consumes is a plain value.
      let modelRegistry: SenpiModelRegistryPort<SenpiModelPort> | undefined
      try {
        modelRegistry = options.resolveModelRegistry?.(eventCtx)
      } catch (error) {
        // Fail-open: an unreadable registry only means the runner resolves the category itself.
        options.logger?.warn("omo-senpi memorian gate registry snapshot skipped", { error: describe(error) })
      }
      const session = options.snapshotSession?.(eventCtx)
      const collectFromSnapshot = options.collectCandidatesFromSnapshot
      track(async () => {
        const collected = session !== undefined && collectFromSnapshot !== undefined
          ? await collectFromSnapshot(session)
          : await options.collectCandidates(eventCtx)
        if (collected === undefined) return
        await options.runnerFor(collected.context).launch({
          sessionId: collected.sessionId,
          candidates: collected.candidates,
          surfaced: collected.surfaced,
          maxItems: collected.maxItems,
          transcript: collected.transcript,
          ...(modelRegistry === undefined ? {} : { modelRegistry }),
        })
      })
    },

    onCompactionAccepted(sessionId: string): void {
      const context = options.resolveContext(sessionId)
      if (context === undefined) return
      track(async () => {
        // take() is read-and-delete, so consuming and discarding IS the drop. A pending payload
        // that outlived its transcript would advise the next turn about a conversation the
        // compaction has already rewritten.
        await pendingFor(context).take(sessionId)
      })
    },

    async whenIdle(): Promise<void> {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
