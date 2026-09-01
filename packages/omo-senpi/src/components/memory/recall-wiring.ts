// Memorian recall wiring (plan .omo/plans/memorian-m3-gate.md todo 1).
//
// Recall owns its OWN before_agent_start handler, NOT an extra field on the memory prompt
// handler's result: senpi's ExtensionRunner.emitBeforeAgentStart pushes every handler's
// `result.message` into a combined `messages[]` array, so two handlers of the same extension each
// contribute one message. That separation is the invariant that keeps recall away from
// systemPrompt.
//
// The lexical auto-injection path is GONE: nothing is injected from a plain corpus match. Candidate
// collection now runs at SETTLE time (the turn is complete there, so the current-prompt seam
// disappears) and feeds the memorian gate child, whose validated nudges are what a later turn
// injects. Every step stays fail-open: an unreadable memory repo or a corrupt corpus drops the
// collection and logs, and the turn proceeds untouched.

import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import {
  GitMemoryRepo,
  RecallCorpusCache,
  RecallLedger,
  planRecallQueries,
  selectRecallCandidates,
  type RecallCandidate,
} from "@oh-my-opencode/memory-core"

import type { ComponentLogger } from "../../extension/types"
import type { MemoryExtensionAPI } from "./capabilities"
import type { MemoryIdentityContext } from "./context"
import { MEMORY_NOTICE_CUSTOM_TYPE } from "./prompt"
import { renderRecallEntry } from "./recall-notice"
import { resolveMemorySettings } from "./identity-runtime"

export interface ResolvedMemoryRecallSettings {
  readonly enabled: boolean
  readonly max_items: number
  readonly budget_tokens: number
  readonly excerpt_chars: number
  readonly min_score?: number
  readonly exclude: readonly string[]
}

/** Base recall block under the bound agent's layer override, mirroring the nudge/reflection pattern. */
export function resolveAgentRecallSettings(
  settings: OmoMemorySettings | undefined,
  agentId: string,
): ResolvedMemoryRecallSettings {
  const resolved = resolveMemorySettings(settings)
  return { ...resolved.recall, ...resolved.agents[agentId]?.recall }
}

export const RECALL_CUSTOM_TYPE = "omo-memorian:recall"

/** Newest conversation texts feeding the query planner; older turns are not what the user is on. */
const RECALL_TEXT_WINDOW = 6

// Memory-owned hidden channels. Their content is derived FROM memory, so feeding them back into
// the query planner would make recall search for the hint it just injected.
const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([RECALL_CUSTOM_TYPE, MEMORY_NOTICE_CUSTOM_TYPE])

export interface MemoryRecallWiringOptions {
  readonly resolveContext: (sessionId: string) => MemoryIdentityContext | undefined
  /** Full memory settings; the bound agent's recall override is applied internally. */
  readonly resolveSettings: () => OmoMemorySettings
  readonly env: Record<string, string | undefined>
  readonly createRepo?: (context: MemoryIdentityContext) => GitMemoryRepo
  readonly corpusCache?: RecallCorpusCache
  readonly ledgerFor?: (context: MemoryIdentityContext) => RecallLedger
  readonly logger?: ComponentLogger
}

/** Everything the memorian gate child needs about one settled turn's lexical candidates. */
export interface CollectedRecallCandidates {
  readonly sessionId: string
  readonly context: MemoryIdentityContext
  readonly candidates: readonly RecallCandidate[]
}

export interface MemoryRecallWiring {
  register(pi: MemoryExtensionAPI): void
  /** Settle-time seam: lexical candidates for the completed turn, or undefined when there are none. */
  collectCandidates(eventCtx: unknown): Promise<CollectedRecallCandidates | undefined>
}

// A memory worker child must never receive recall hints: it reasons ABOUT memory, and an injected
// hint would both pollute its transcript and re-enter memory on the next extraction pass.
const CHILD_SENTINELS = ["SENPI_MEMORY_REFLECTION", "SENPI_MEMORY_FACTS"] as const

export function createMemoryRecallWiring(options: MemoryRecallWiringOptions): MemoryRecallWiring {
  const corpusCache = options.corpusCache ?? new RecallCorpusCache()
  const createRepo = options.createRepo ?? defaultCreateRepo
  const ledgerFor = options.ledgerFor ?? ((context) => new RecallLedger(context.identityPaths.recallLedger))

  async function collect(eventCtx: unknown): Promise<CollectedRecallCandidates | undefined> {
    if (CHILD_SENTINELS.some((sentinel) => options.env[sentinel] === "1")) return undefined
    // agent_settled carries no session fields, so the session is read from the event context the
    // same way the before_agent_start handler reads it.
    const session = readSession(eventCtx)
    if (session === undefined) return undefined
    const context = options.resolveContext(session.id)
    if (context === undefined) return undefined

    const recall = resolveAgentRecallSettings(options.resolveSettings(), context.identity)
    if (recall.enabled === false) return undefined

    // USER-role texts only: candidates are keyed on user intent, and assistant prose (which often
    // paraphrases memory back at the user) would skew matching.
    const texts = userTexts(session.entries)
    if (texts.length === 0) return undefined
    const queries = planRecallQueries(texts)
    if (queries.length === 0) return undefined

    const repo = createRepo(context)
    const corpus = await corpusCache.load(repo)
    if (corpus.documents.length === 0) return undefined

    const ledger = ledgerFor(context)
    const candidates = selectRecallCandidates(corpus.documents, queries, {
      maxItems: recall.max_items,
      excerptChars: recall.excerpt_chars,
      surfaced: await ledger.surfacedPaths(session.id),
    })
    if (candidates.length === 0) return undefined
    return { sessionId: session.id, context, candidates }
  }

  return {
    // The injection half of the channel is the gate's, not a lexical match's: the renderer stays so
    // the visible trace keeps working, and the message handler returns with the nudge handoff
    // (plan todo 8).
    register(pi): void {
      pi.registerEntryRenderer(RECALL_CUSTOM_TYPE, renderRecallEntry)
    },
    async collectCandidates(eventCtx): Promise<CollectedRecallCandidates | undefined> {
      try {
        return await collect(eventCtx)
      } catch (error) {
        // Read-only advice: any failure drops the collection and leaves the turn untouched.
        options.logger?.warn("omo-senpi memory recall candidate collection skipped", { error: describe(error) })
        return undefined
      }
    },
  }
}

interface RecallSession {
  readonly id: string
  readonly entries: readonly unknown[]
}

function readSession(eventCtx: unknown): RecallSession | undefined {
  if (!isRecord(eventCtx)) return undefined
  const manager = eventCtx.sessionManager
  if (!isRecord(manager)) return undefined
  const getSessionId = manager.getSessionId
  const getBranch = manager.getBranch
  if (typeof getSessionId !== "function" || typeof getBranch !== "function") return undefined
  const id = Reflect.apply(getSessionId, manager, [])
  const entries = Reflect.apply(getBranch, manager, [])
  if (typeof id !== "string" || id.length === 0 || !Array.isArray(entries)) return undefined
  return { id, entries }
}

/**
 * Newest-first USER texts for the planner. Memory-owned hidden custom messages are skipped: senpi
 * persists an injected recall block as a `custom_message` branch entry, so an unfiltered window
 * would rediscover the previous hint instead of the live conversation.
 */
function userTexts(entries: readonly unknown[]): string[] {
  const texts: string[] = []
  for (let index = entries.length - 1; index >= 0 && texts.length < RECALL_TEXT_WINDOW; index -= 1) {
    const text = userText(entries[index])
    if (text !== undefined) texts.push(text)
  }
  return texts
}

function userText(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined
  if (entry.type === "custom_message" || entry.type === "custom") return undefined
  if (entry.type !== "message") return undefined
  const message = entry.message
  if (!isRecord(message)) return undefined
  if (message.role !== "user") return undefined
  if (typeof message.customType === "string" && EXCLUDED_CUSTOM_TYPES.has(message.customType)) return undefined
  const text = textOf(message.content)
  return text.trim().length === 0 ? undefined : text
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue
    if (typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n")
}

function defaultCreateRepo(context: MemoryIdentityContext): GitMemoryRepo {
  return new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
