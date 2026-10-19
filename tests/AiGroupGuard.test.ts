import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { aiService } from "../services/ai/AiService"
import { tabGroupService } from "../services/TabGroupService"
import { tabGroupState } from "../services/TabGroupState"
import { DEFAULT_STATE } from "../types/storage"
import { aiGroupLedger } from "../utils/AiGroupLedger"
import { mockBrowser } from "./setup"

/**
 * A group that AI auto-grouping made is named by topic, so domain grouping
 * would file its tabs straight back out by site. While the feature is on,
 * handleTabUpdate must leave such a tab where it is.
 */
describe("AI topic groups and the domain pass", () => {
  const TOPIC_GROUP_ID = 42

  beforeEach(() => {
    vi.clearAllMocks()
    tabGroupState.updateFromStorage(DEFAULT_STATE)
    tabGroupState.autoGroupingEnabled = true
    aiGroupLedger.reset(["Trip Planning"])

    mockBrowser.tabGroups.get.mockResolvedValue({ id: TOPIC_GROUP_ID, title: "Trip Planning" })
    mockBrowser.tabGroups.query.mockResolvedValue([])
    const tab = {
      id: 1,
      url: "https://flights.example.com/",
      title: "Flights",
      pinned: false,
      windowId: 1,
      groupId: TOPIC_GROUP_ID
    }
    mockBrowser.tabs.get.mockResolvedValue(tab)
    mockBrowser.tabs.query.mockResolvedValue([tab])
    mockBrowser.tabs.group.mockResolvedValue(100)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    aiGroupLedger.reset()
  })

  it("leaves a tab in a topic group alone while auto-grouping is on", async () => {
    vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(true)

    const moved = await tabGroupService.handleTabUpdate(1)

    expect(moved).toBe(false)
    expect(mockBrowser.tabs.group).not.toHaveBeenCalled()
    expect(mockBrowser.tabs.ungroup).not.toHaveBeenCalled()
  })

  it("treats the same group as any other once auto-grouping is off", async () => {
    vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(false)

    await tabGroupService.handleTabUpdate(1)

    expect(mockBrowser.tabs.group).toHaveBeenCalled()
  })

  it("does not shield a group whose title the ledger has forgotten", async () => {
    vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(true)
    aiGroupLedger.reset([])

    await tabGroupService.handleTabUpdate(1)

    expect(mockBrowser.tabs.group).toHaveBeenCalled()
  })

  it("recognises a topic group behind a sort-index prefix", async () => {
    vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(true)
    tabGroupState.indexGroupTitles = true
    mockBrowser.tabGroups.get.mockResolvedValue({ id: TOPIC_GROUP_ID, title: "2. Trip Planning" })

    const moved = await tabGroupService.handleTabUpdate(1)

    expect(moved).toBe(false)
    expect(mockBrowser.tabs.group).not.toHaveBeenCalled()
  })
})
