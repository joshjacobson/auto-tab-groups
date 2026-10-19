import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * NOTE: vi.mock module interception does not work under Bun's runtime.
 * These tests use vi.spyOn on the actual singleton instances instead.
 */

import { AI_AUTO_GROUP_DEBOUNCE_MS, aiAutoGroupService } from "../services/ai/AiAutoGroupService"
import { aiService } from "../services/ai/AiService"
import { rulesService } from "../services/RulesService"
import { tabGroupService } from "../services/TabGroupService"
import { tabGroupState } from "../services/TabGroupState"
import { tabSortService } from "../services/TabSortService"
import { DEFAULT_STATE } from "../types/storage"
import { aiGroupLedger } from "../utils/AiGroupLedger"
import { aiGroupTitles } from "../utils/storage"
import { mockBrowser } from "./setup"

// biome-ignore lint/suspicious/noExplicitAny: vi.spyOn returns heterogeneous mock types
type Spy = MockInstance<(...args: any[]) => any>

interface FakeTab {
  id: number
  title: string
  url: string
  windowId: number
  groupId: number
  pinned?: boolean
  status?: string
}

interface FakeGroup {
  id: number
  title: string
  windowId: number
  color?: string
}

const WINDOW = 1

/**
 * The window every test starts from:
 *   group 10 "Google Docs" — built by domain grouping (own)
 *   group 11 "Reading"     — excluded by the user (protected)
 *   group 12 "Trip Planning" — made by an earlier pass (in the ledger)
 */
function fakeTabs(): FakeTab[] {
  return [
    {
      id: 1,
      title: "Annual review draft - Docs",
      url: "https://docs.example.com/a",
      windowId: WINDOW,
      groupId: 10
    },
    {
      id: 2,
      title: "Annual review notes - Docs",
      url: "https://docs.example.com/b",
      windowId: WINDOW,
      groupId: 10
    },
    {
      id: 3,
      title: "Long read",
      url: "https://reading.example.com/",
      windowId: WINDOW,
      groupId: 11
    },
    {
      id: 4,
      title: "Hotel booking",
      url: "https://hotels.example.com/",
      windowId: WINDOW,
      groupId: 12
    },
    {
      id: 5,
      title: "Flights to Lisbon",
      url: "https://flights.example.com/",
      windowId: WINDOW,
      groupId: -1
    },
    {
      id: 6,
      title: "Pinned dashboard",
      url: "https://dash.example.com/",
      windowId: WINDOW,
      groupId: -1,
      pinned: true
    },
    { id: 7, title: "New Tab", url: "chrome://newtab/", windowId: WINDOW, groupId: -1 }
  ]
}

function fakeGroups(): FakeGroup[] {
  return [
    { id: 10, title: "Google Docs", windowId: WINDOW },
    { id: 11, title: "Reading", windowId: WINDOW },
    { id: 12, title: "Trip Planning", windowId: WINDOW }
  ]
}

describe("AiAutoGroupService", () => {
  let tabs: FakeTab[]
  let groups: FakeGroup[]
  let spyComplete: Spy
  let spyIsOwnGroup: Spy
  let spyLoadModel: Spy
  let spyModelStatus: Spy

  beforeEach(() => {
    vi.clearAllMocks()
    tabs = fakeTabs()
    groups = fakeGroups()

    tabGroupState.updateFromStorage({ ...DEFAULT_STATE, protectedGroupTitles: ["Reading"] })
    aiGroupLedger.reset(["Trip Planning"])
    aiAutoGroupService.forgetEvaluated()
    aiAutoGroupService.cancelAll()

    vi.spyOn(aiGroupTitles, "setValue").mockResolvedValue(undefined)
    vi.spyOn(aiService, "isEnabled").mockReturnValue(true)
    vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(true)
    spyModelStatus = vi
      .spyOn(aiService, "getModelStatus")
      .mockReturnValue({ status: "ready", progress: 100, modelId: "m", error: null })
    spyLoadModel = vi.spyOn(aiService, "loadModel").mockResolvedValue(undefined)
    vi.spyOn(aiService, "checkWebGpuSupport").mockResolvedValue({ available: true, reason: null })
    spyComplete = vi.spyOn(aiService, "complete").mockResolvedValue({
      content: JSON.stringify({
        groups: [
          { groupName: "Annual Review", tabIndices: [1, 2], color: "purple" },
          { groupName: "trip planning", tabIndices: [3], color: "green" }
        ]
      }),
      finishReason: "stop"
    })

    // Only the domain group counts as the extension's own
    spyIsOwnGroup = vi
      .spyOn(tabGroupService, "isOwnGroup")
      .mockImplementation(async group => group.title === "Google Docs")
    vi.spyOn(rulesService, "findMatchingRule").mockResolvedValue(null)
    vi.spyOn(rulesService, "findBlacklistMatch").mockResolvedValue(null)
    vi.spyOn(tabSortService, "applySorting").mockImplementation((async () => true) as never)

    mockBrowser.tabs.query.mockImplementation(async (query: { windowId?: number }) =>
      query.windowId === undefined ? tabs : tabs.filter(t => t.windowId === query.windowId)
    )
    mockBrowser.tabs.get.mockImplementation(async (id: number) => {
      const found = tabs.find(t => t.id === id)
      if (!found) throw new Error("No tab")
      return found
    })
    mockBrowser.tabGroups.query.mockImplementation(async (query: { windowId?: number }) =>
      query.windowId === undefined ? groups : groups.filter(g => g.windowId === query.windowId)
    )
    mockBrowser.tabs.group.mockResolvedValue(100)
    mockBrowser.tabGroups.update.mockResolvedValue({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe("run", () => {
    it("moves the domain-grouped and ungrouped tabs, leaves the rest alone", async () => {
      const result = await aiAutoGroupService.run(WINDOW)

      expect(result).toEqual({ ran: true, groupsCreated: 1, groupsJoined: 1, tabsMoved: 3 })

      // The model was shown only tabs 1, 2 and 5 — not the excluded, pinned,
      // system or already-topic-grouped ones — plus the existing topic group
      const [request] = spyComplete.mock.calls[0]
      const userMessage = request.messages[1].content as string
      expect(userMessage).toContain('Existing groups: "Trip Planning"')
      expect(userMessage).toContain('1. [docs.example.com] "Annual review draft - Docs"')
      expect(userMessage).toContain('3. [flights.example.com] "Flights to Lisbon"')
      expect(userMessage).not.toContain("Long read")
      expect(userMessage).not.toContain("Hotel booking")
      expect(userMessage).not.toContain("Pinned dashboard")
      expect(userMessage).not.toContain("New Tab")

      // "Annual Review" is new: a group is created, titled and remembered
      expect(mockBrowser.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] })
      expect(mockBrowser.tabGroups.update).toHaveBeenCalledWith(100, {
        title: "Annual Review",
        color: "purple"
      })
      expect(aiGroupLedger.has("Annual Review")).toBe(true)

      // "trip planning" already exists: the flight tab joins it
      expect(mockBrowser.tabs.group).toHaveBeenCalledWith({ tabIds: [5], groupId: 12 })
      expect(spyIsOwnGroup).toHaveBeenCalled()
    })

    it("does not ask the model again while nothing has changed", async () => {
      await aiAutoGroupService.run(WINDOW)
      spyComplete.mockClear()

      const second = await aiAutoGroupService.run(WINDOW)

      expect(second.ran).toBe(false)
      expect(second.reason).toBe("nothing-new")
      expect(spyComplete).not.toHaveBeenCalled()
    })

    it("asks again when forced, as 'Group by Topic Now' does", async () => {
      await aiAutoGroupService.run(WINDOW)
      spyComplete.mockClear()

      const forced = await aiAutoGroupService.run(WINDOW, true)

      expect(forced.ran).toBe(true)
      expect(spyComplete).toHaveBeenCalledTimes(1)
    })

    it("refuses a name that belongs to a rule", async () => {
      tabGroupState.updateFromStorage({
        ...DEFAULT_STATE,
        customRules: {
          r1: {
            id: "r1",
            name: "Annual Review",
            domains: ["hr.example.com"],
            color: "red",
            enabled: true,
            priority: 1,
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        }
      })

      const result = await aiAutoGroupService.run(WINDOW)

      expect(result.groupsCreated).toBe(0)
      expect(mockBrowser.tabs.group).not.toHaveBeenCalledWith({ tabIds: [1, 2] })
    })

    it("skips tabs that closed between the question and the answer", async () => {
      mockBrowser.tabs.get.mockImplementation(async (id: number) => {
        if (id === 2) throw new Error("No tab with id 2")
        const found = tabs.find(t => t.id === id)
        if (!found) throw new Error("No tab")
        return found
      })

      const result = await aiAutoGroupService.run(WINDOW)

      // "Annual Review" is down to one open tab, so no group of one is made
      expect(result.groupsCreated).toBe(0)
      expect(result.groupsJoined).toBe(1)
    })

    it("does nothing when the AI section is off", async () => {
      vi.spyOn(aiService, "isEnabled").mockReturnValue(false)

      const result = await aiAutoGroupService.run(WINDOW, true)

      expect(result).toMatchObject({ ran: false, reason: "ai-disabled" })
      expect(spyComplete).not.toHaveBeenCalled()
    })

    it("does nothing when auto-grouping is off, unless forced", async () => {
      vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(false)

      expect(await aiAutoGroupService.run(WINDOW)).toMatchObject({ reason: "disabled" })
      expect(spyComplete).not.toHaveBeenCalled()

      expect((await aiAutoGroupService.run(WINDOW, true)).ran).toBe(true)
    })

    it("reloads an idle model before running", async () => {
      spyModelStatus.mockReturnValue({ status: "idle", progress: 0, modelId: "m", error: null })

      const result = await aiAutoGroupService.run(WINDOW)

      expect(spyLoadModel).toHaveBeenCalledTimes(1)
      expect(result.ran).toBe(true)
    })

    it("waits for a model that is still loading", async () => {
      spyModelStatus.mockReturnValue({ status: "loading", progress: 40, modelId: "m", error: null })

      const result = await aiAutoGroupService.run(WINDOW)

      expect(result).toMatchObject({ ran: false, reason: "model-loading" })
      expect(spyLoadModel).not.toHaveBeenCalled()
      expect(spyComplete).not.toHaveBeenCalled()
    })

    it("gives up without WebGPU", async () => {
      spyModelStatus.mockReturnValue({ status: "idle", progress: 0, modelId: "m", error: null })
      vi.spyOn(aiService, "checkWebGpuSupport").mockResolvedValue({
        available: false,
        reason: "No adapter"
      })

      const result = await aiAutoGroupService.run(WINDOW)

      expect(result).toMatchObject({ ran: false, reason: "model-unavailable" })
      expect(spyLoadModel).not.toHaveBeenCalled()
    })

    it("reports unparseable model output without moving anything", async () => {
      spyComplete.mockResolvedValue({ content: "I cannot help with that", finishReason: "stop" })

      const result = await aiAutoGroupService.run(WINDOW)

      expect(result).toMatchObject({ ran: false, reason: "error" })
      expect(mockBrowser.tabs.group).not.toHaveBeenCalled()
    })

    it("forgets ledger titles no group carries any more", async () => {
      aiGroupLedger.reset(["Trip Planning", "Gone"])

      await aiAutoGroupService.run(WINDOW)

      expect(aiGroupLedger.has("Gone")).toBe(false)
      expect(aiGroupLedger.has("Trip Planning")).toBe(true)
    })
  })

  describe("schedule", () => {
    it("runs once after a burst of tab events", async () => {
      vi.useFakeTimers()
      const spyRun = vi.spyOn(aiAutoGroupService, "run").mockResolvedValue({
        ran: true,
        groupsCreated: 0,
        groupsJoined: 0,
        tabsMoved: 0
      })

      aiAutoGroupService.schedule(WINDOW)
      aiAutoGroupService.schedule(WINDOW)
      aiAutoGroupService.schedule(WINDOW)

      await vi.advanceTimersByTimeAsync(AI_AUTO_GROUP_DEBOUNCE_MS - 1)
      expect(spyRun).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(spyRun).toHaveBeenCalledTimes(1)
      expect(spyRun).toHaveBeenCalledWith(WINDOW)
    })

    it("keeps windows apart", async () => {
      vi.useFakeTimers()
      const spyRun = vi.spyOn(aiAutoGroupService, "run").mockResolvedValue({
        ran: true,
        groupsCreated: 0,
        groupsJoined: 0,
        tabsMoved: 0
      })

      aiAutoGroupService.schedule(1)
      aiAutoGroupService.schedule(2)
      await vi.advanceTimersByTimeAsync(AI_AUTO_GROUP_DEBOUNCE_MS)

      expect(spyRun).toHaveBeenCalledTimes(2)
    })

    it("schedules nothing while the feature is off", async () => {
      vi.useFakeTimers()
      vi.spyOn(aiService, "isAutoGroupEnabled").mockReturnValue(false)
      const spyRun = vi.spyOn(aiAutoGroupService, "run")

      aiAutoGroupService.schedule(WINDOW)
      await vi.advanceTimersByTimeAsync(AI_AUTO_GROUP_DEBOUNCE_MS * 2)

      expect(spyRun).not.toHaveBeenCalled()
    })

    it("ignores windows it cannot name", () => {
      vi.useFakeTimers()
      const spyRun = vi.spyOn(aiAutoGroupService, "run")

      aiAutoGroupService.schedule(undefined)
      aiAutoGroupService.schedule(-1)
      vi.advanceTimersByTime(AI_AUTO_GROUP_DEBOUNCE_MS * 2)

      expect(spyRun).not.toHaveBeenCalled()
    })
  })
})
