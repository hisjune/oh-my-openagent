import { describe, expect, it } from "bun:test"
import * as memoryCore from "../index"
import {
  RecallCorpusCache,
  RecallLedger,
  loadRecallCorpus,
  planRecallQueries,
  renderRecallMessage,
  sanitizeSessionFilename,
  selectRecallCandidates,
} from "../index"

describe("recall package surface", () => {
  it("#given the package barrel #when the recall surface is imported #then every recall unit is exported", () => {
    // given / when / then
    expect(typeof loadRecallCorpus).toBe("function")
    expect(typeof RecallCorpusCache).toBe("function")
    expect(typeof planRecallQueries).toBe("function")
    expect(typeof selectRecallCandidates).toBe("function")
    expect(typeof renderRecallMessage).toBe("function")
    expect(typeof RecallLedger).toBe("function")
    expect(typeof sanitizeSessionFilename).toBe("function")
  })

  it("#given the package barrel #when the recall surface is imported #then the receipts audit trail is gone", () => {
    // given / when / then
    expect(memoryCore).not.toHaveProperty("appendRecallReceipt")
  })
})
