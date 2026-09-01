import { describe, expect, it } from "bun:test"
import type { RecallCandidate } from "./select"
import { renderNudgeBlock, renderNudgeMessage, renderRecallMessage } from "./render"

function candidate(path: string, description: string, excerpt: string): RecallCandidate {
  return { path, description, excerpt, score: 12 }
}

describe("renderRecallMessage", () => {
  it("#given no candidates #when the message is rendered #then the result is empty", () => {
    // given / when
    const message = renderRecallMessage([])
    // then
    expect(message).toBe("")
  })

  it("#given one candidate #when the message is rendered #then the exact block shape is produced", () => {
    // given
    const candidates = [candidate("reference/a.md", "Deploy", "the ingress gateway is flaky")]

    // when
    const message = renderRecallMessage(candidates)

    // then
    expect(message).toBe(
      '<recalled-memory source="[[reference/a.md]]">\n' +
        "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.\n" +
        "Deploy\n" +
        '"the ingress gateway is flaky"\n' +
        "</recalled-memory>",
    )
  })

  it("#given several candidates #when the message is rendered #then one sourced block per candidate keeps order", () => {
    // given
    const candidates = [
      candidate("notes/b.md", "Kubernetes notes", "first"),
      candidate("people/alice.md", "Alice the backend lead", "second"),
    ]

    // when
    const message = renderRecallMessage(candidates)

    // then
    expect(message).toBe(
      '<recalled-memory source="[[notes/b.md]]">\n' +
        "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.\n" +
        "Kubernetes notes\n" +
        '"first"\n' +
        "</recalled-memory>\n" +
      '<recalled-memory source="[[people/alice.md]]">\n' +
        "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.\n" +
        "Alice the backend lead\n" +
        '"second"\n' +
        "</recalled-memory>",
    )
  })

  it("#given a rendered message #when the shape is inspected #then no trailing newline is appended", () => {
    // given
    const candidates = [candidate("reference/a.md", "Deploy", "excerpt")]

    // when
    const message = renderRecallMessage(candidates)

    // then
    expect(message.endsWith("\n")).toBe(false)
  })
})

describe("renderNudgeBlock", () => {
  it("#given a judged nudge #when the block is rendered #then the hint replaces the description and excerpt inside the sourced framing", () => {
    // given
    const nudge = { path: "reference/a.md", hint: "The deploy gate requires a green smoke run." }

    // when
    const block = renderNudgeBlock(nudge)

    // then
    expect(block).toBe(
      '<recalled-memory source="[[reference/a.md]]">\n' +
        "A stored memory surfaced. It is a hint, not current state — verify before relying on it; read the source path for full context.\n" +
        "The deploy gate requires a green smoke run.\n" +
        "</recalled-memory>",
    )
  })
})

describe("renderNudgeMessage", () => {
  it("#given no nudges #when the message is rendered #then the result is empty so callers inject nothing", () => {
    // given / when / then
    expect(renderNudgeMessage([])).toBe("")
  })

  it("#given several nudges #when the message is rendered #then one sourced block per nudge keeps the judge's order", () => {
    // given
    const nudges = [
      { path: "notes/b.md", hint: "first fact" },
      { path: "people/alice.md", hint: "second fact" },
    ]

    // when
    const message = renderNudgeMessage(nudges)

    // then
    expect(message).toBe(`${renderNudgeBlock(nudges[0]!)}\n${renderNudgeBlock(nudges[1]!)}`)
    expect(message.endsWith("\n")).toBe(false)
  })
})
