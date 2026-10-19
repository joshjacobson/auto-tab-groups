import { describe, expect, it } from "vitest"
import type { AiGroupSuggestion } from "../types"
import {
  type CandidateTab,
  isEligibleTab,
  pickCandidates,
  planGroupActions,
  tabKey
} from "../utils/AiAutoGroup"

/**
 * The decisions behind AI auto-grouping, as plain functions: which tabs are
 * worth showing the model, whether a pass is worth running at all, and what
 * to do with what the model says.
 */
describe("AiAutoGroup", () => {
  const tab = (
    tabId: number,
    title: string,
    url = `https://example.com/${tabId}`
  ): CandidateTab => ({
    tabId,
    title,
    url
  })

  const suggestion = (
    groupName: string,
    tabs: CandidateTab[],
    color: AiGroupSuggestion["color"] = "blue"
  ): AiGroupSuggestion => ({ groupName, color, tabs })

  describe("tabKey", () => {
    it("changes when the tab navigates or is retitled", () => {
      const base = tab(1, "Draft")
      expect(tabKey(base)).toBe(tabKey(tab(1, "Draft")))
      expect(tabKey(base)).not.toBe(tabKey(tab(1, "Final")))
      expect(tabKey(base)).not.toBe(tabKey(tab(1, "Draft", "https://example.com/other")))
    })
  })

  describe("isEligibleTab", () => {
    const page = {
      id: 1,
      url: "https://example.com/page",
      title: "A page",
      pinned: false,
      status: "complete"
    }

    it("accepts a loaded, titled, unpinned page", () => {
      expect(isEligibleTab(page as never)).toBe(true)
    })

    it("rejects pinned tabs", () => {
      expect(isEligibleTab({ ...page, pinned: true } as never)).toBe(false)
    })

    it("rejects tabs that are still loading", () => {
      expect(isEligibleTab({ ...page, status: "loading" } as never)).toBe(false)
    })

    it("rejects tabs without a title", () => {
      expect(isEligibleTab({ ...page, title: "  " } as never)).toBe(false)
      expect(isEligibleTab({ ...page, title: undefined } as never)).toBe(false)
    })

    it("rejects system and extension pages", () => {
      expect(isEligibleTab({ ...page, url: "chrome://extensions" } as never)).toBe(false)
      expect(isEligibleTab({ ...page, url: "about:blank" } as never)).toBe(false)
      expect(isEligibleTab({ ...page, url: "chrome-extension://abc/popup.html" } as never)).toBe(
        false
      )
    })

    it("rejects tabs without an id or url", () => {
      expect(isEligibleTab({ ...page, id: undefined } as never)).toBe(false)
      expect(isEligibleTab({ ...page, url: undefined } as never)).toBe(false)
    })
  })

  describe("pickCandidates", () => {
    const options = { force: false, existingGroupCount: 0, cap: 40 }

    it("does not run when every candidate has been judged before", () => {
      const tabs = [tab(1, "A"), tab(2, "B")]
      const seen = new Set(tabs.map(tabKey))
      expect(pickCandidates(tabs, seen, options).shouldRun).toBe(false)
    })

    it("runs when forced even if nothing is new", () => {
      const tabs = [tab(1, "A"), tab(2, "B")]
      const seen = new Set(tabs.map(tabKey))
      const pick = pickCandidates(tabs, seen, { ...options, force: true })
      expect(pick.shouldRun).toBe(true)
      expect(pick.tabs).toHaveLength(2)
    })

    it("does not run on a single tab with nowhere to put it", () => {
      expect(pickCandidates([tab(1, "A")], new Set(), options).shouldRun).toBe(false)
    })

    it("runs on a single tab when a topic group exists for it to join", () => {
      const pick = pickCandidates([tab(1, "A")], new Set(), {
        ...options,
        existingGroupCount: 1
      })
      expect(pick.shouldRun).toBe(true)
    })

    it("puts new tabs first and previously judged tabs after, most recent first", () => {
      const old1 = tab(1, "Old 1")
      const old2 = tab(2, "Old 2")
      const fresh = tab(3, "New")
      const pick = pickCandidates(
        [old1, old2, fresh],
        new Set([tabKey(old1), tabKey(old2)]),
        options
      )
      expect(pick.tabs.map(t => t.tabId)).toEqual([3, 2, 1])
    })

    it("caps the number of tabs sent to the model", () => {
      const tabs = Array.from({ length: 10 }, (_, i) => tab(i + 1, `Tab ${i + 1}`))
      const pick = pickCandidates(tabs, new Set(), { ...options, cap: 4 })
      expect(pick.tabs).toHaveLength(4)
    })
  })

  describe("planGroupActions", () => {
    const options = { joinableGroups: [], reservedTitles: [], minimumTabsForNewGroup: 2 }

    it("creates a group for two or more tabs that share a topic", () => {
      const actions = planGroupActions(
        [suggestion("Annual Review", [tab(1, "Review draft"), tab(2, "Review notes")], "purple")],
        options
      )
      expect(actions).toEqual([
        { type: "create", title: "Annual Review", color: "purple", tabIds: [1, 2] }
      ])
    })

    it("leaves a lone tab where it is rather than make a group of one", () => {
      const actions = planGroupActions([suggestion("Solo", [tab(1, "Alone")])], options)
      expect(actions).toEqual([])
    })

    it("joins an existing group whose title matches, ignoring case, even for a lone tab", () => {
      const actions = planGroupActions([suggestion("trip planning", [tab(7, "Flights")])], {
        ...options,
        joinableGroups: [{ id: 12, title: "Trip Planning" }]
      })
      expect(actions).toEqual([{ type: "join", groupId: 12, title: "Trip Planning", tabIds: [7] }])
    })

    it("refuses titles that belong to rules or excluded groups", () => {
      const actions = planGroupActions(
        [
          suggestion("Work", [tab(1, "A"), tab(2, "B")]),
          suggestion("system", [tab(3, "C"), tab(4, "D")])
        ],
        { ...options, reservedTitles: ["Work", "System"] }
      )
      expect(actions).toEqual([])
    })

    it("merges two suggestions with the same name into one new group", () => {
      const actions = planGroupActions(
        [
          suggestion("Cooking", [tab(1, "Pasta"), tab(2, "Risotto")]),
          suggestion("cooking", [tab(3, "Bread"), tab(4, "Soup")])
        ],
        options
      )
      expect(actions).toHaveLength(1)
      expect(actions[0]).toMatchObject({ type: "create", title: "Cooking", tabIds: [1, 2, 3, 4] })
    })

    it("never puts one tab in two groups", () => {
      const shared = tab(1, "Shared")
      const actions = planGroupActions(
        [suggestion("First", [shared, tab(2, "B")]), suggestion("Second", [shared, tab(3, "C")])],
        options
      )
      expect(actions).toEqual([{ type: "create", title: "First", color: "blue", tabIds: [1, 2] }])
    })

    it("skips suggestions with a blank name", () => {
      const actions = planGroupActions([suggestion("   ", [tab(1, "A"), tab(2, "B")])], options)
      expect(actions).toEqual([])
    })
  })
})
