// Recall message renderer: builds the late-hidden recall block injected as a
// hint message. The shape is a fixed contract consumed by the harness-side
// recall wiring: one sourced block per candidate, so a budget pass can keep or
// drop WHOLE candidates instead of slicing a shared envelope mid-sentence.
// Empty candidates render to an empty string so callers inject nothing.

import type { RecallNudge } from "./gate"
import type { RecallCandidate } from "./select"

export const RECALL_HINT_HEADER =
  "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context."

/** One self-contained block per candidate; blocks join with a single newline. */
export function renderRecallCandidate(candidate: RecallCandidate): string {
  return [
    `<recalled-memory source="[[${candidate.path}]]">`,
    RECALL_HINT_HEADER,
    candidate.description,
    `"${candidate.excerpt}"`,
    "</recalled-memory>",
  ].join("\n")
}

export function renderRecallMessage(candidates: readonly RecallCandidate[]): string {
  if (candidates.length === 0) return ""
  return candidates.map(renderRecallCandidate).join("\n")
}

/**
 * A gate-judged nudge in the same sourced framing as a lexical candidate: the judge's one-sentence
 * hint takes the place of the description and excerpt, because it already states WHY this memory
 * matters to the next turn. The header stays so the agent reads it as a hint, not as current state,
 * and the source path is what it opens for the full detail the hint had to leave out.
 */
export function renderNudgeBlock(nudge: RecallNudge): string {
  return [
    `<recalled-memory source="[[${nudge.path}]]">`,
    RECALL_HINT_HEADER,
    nudge.hint,
    "</recalled-memory>",
  ].join("\n")
}

export function renderNudgeMessage(nudges: readonly RecallNudge[]): string {
  if (nudges.length === 0) return ""
  return nudges.map(renderNudgeBlock).join("\n")
}
