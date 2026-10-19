/**
 * Files new tabs into topic groups without being asked.
 *
 * Domain grouping runs the moment a tab lands; it is quick and it is wrong
 * about topics by design. This pass runs a few seconds behind it, once the
 * tab has a title, and moves the tab where its subject says it belongs. It
 * reuses the suggestion machinery ("Suggest Groups") end to end — prompt,
 * parser, apply — and adds the two things an unattended pass needs: a sense
 * of what has already been judged, so a quiet window costs nothing, and a
 * record of the groups it made, so the domain pass leaves them alone.
 */

import type { Browser } from "wxt/browser"
import {
  type CandidateTab,
  type ExistingGroup,
  type GroupAction,
  isEligibleTab,
  pickCandidates,
  planGroupActions,
  tabKey
} from "../../utils/AiAutoGroup"
import { aiGroupLedger } from "../../utils/AiGroupLedger"
import { parseAiSuggestionResponse } from "../../utils/AiResponseParser"
import { tabAutoGroupPrompt } from "../../utils/PromptTemplates"
import { withTabEditRetry } from "../../utils/withTabEditRetry"
import { rulesService } from "../RulesService"
import { tabGroupService } from "../TabGroupService"
import { tabGroupState } from "../TabGroupState"
import { stripIndexPrefix, tabSortService } from "../TabSortService"
import { aiService } from "./AiService"

/** How long a window has to stay quiet after a tab event before a pass runs */
export const AI_AUTO_GROUP_DEBOUNCE_MS = 6000
/** Wait this long before trying again while a model is still loading */
const MODEL_LOADING_RETRY_MS = 15000
/** Upper bound on tabs sent to the model in one pass */
const MAX_CANDIDATES = 40
/** Upper bound on existing topic groups named in the prompt */
const MAX_EXISTING_GROUPS = 20
/**
 * Chrome ends an idle service worker after 30 seconds. Inference and model
 * loading make no extension API calls, so the worker looks idle while it is
 * busiest; a cheap call on an interval keeps it alive until the pass is done.
 */
const KEEPALIVE_INTERVAL_MS = 20000

export type AiAutoGroupSkipReason =
  | "disabled"
  | "ai-disabled"
  | "busy"
  | "model-loading"
  | "model-error"
  | "model-unavailable"
  | "nothing-new"
  | "error"

export interface AiAutoGroupChanges {
  groupsCreated: number
  groupsJoined: number
  tabsMoved: number
}

export interface AiAutoGroupRunResult extends AiAutoGroupChanges {
  ran: boolean
  reason?: AiAutoGroupSkipReason
  error?: string
}

type GroupKind = "system" | "protected" | "ai" | "own" | "foreign"

interface Collected {
  candidates: CandidateTab[]
  aiGroups: ExistingGroup[]
  joinableGroups: ExistingGroup[]
  reservedTitles: string[]
}

const NO_CHANGES: AiAutoGroupChanges = { groupsCreated: 0, groupsJoined: 0, tabsMoved: 0 }

function startKeepAlive(): () => void {
  const ping = () => {
    try {
      browser.runtime.getPlatformInfo?.()?.catch?.(() => {})
    } catch {
      // Nothing to do: the call only exists to reset the idle timer
    }
  }
  const id = setInterval(ping, KEEPALIVE_INTERVAL_MS)
  return () => clearInterval(id)
}

class AiAutoGroupService {
  private timers = new Map<number, ReturnType<typeof setTimeout>>()
  private running = false
  private rerunWindows = new Set<number>()
  /** Tabs (by identity, see tabKey) a pass has already shown the model */
  private evaluated = new Set<string>()
  lastRun: { at: number; windowId: number; result: AiAutoGroupRunResult } | null = null

  isEnabled(): boolean {
    return aiService.isEnabled() && aiService.isAutoGroupEnabled()
  }

  /**
   * Queues a pass for a window. Tab events come in bursts — a page load fires
   * several — so each one restarts the clock rather than adding a pass.
   */
  schedule(windowId: number | undefined, delayMs = AI_AUTO_GROUP_DEBOUNCE_MS): void {
    if (windowId === undefined || windowId < 0) return
    if (!this.isEnabled()) return

    const pending = this.timers.get(windowId)
    if (pending) clearTimeout(pending)

    this.timers.set(
      windowId,
      setTimeout(() => {
        this.timers.delete(windowId)
        this.run(windowId).catch(error => {
          console.error(`[AiAutoGroup] Pass for window ${windowId} failed:`, error)
        })
      }, delayMs)
    )
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.rerunWindows.clear()
  }

  /** Forgets which tabs have been judged, so the next pass looks at everything */
  forgetEvaluated(): void {
    this.evaluated.clear()
  }

  /**
   * Runs one pass over a window. `force` is the "Group by Topic Now" button:
   * it ignores the enabled toggle and the already-evaluated memory, but not a
   * disabled AI section or a missing model.
   */
  async run(windowId: number, force = false): Promise<AiAutoGroupRunResult> {
    const skip = (reason: AiAutoGroupSkipReason, error?: string): AiAutoGroupRunResult => {
      const result: AiAutoGroupRunResult = { ran: false, reason, ...NO_CHANGES, error }
      this.lastRun = { at: Date.now(), windowId, result }
      return result
    }

    if (!aiService.isEnabled()) return skip("ai-disabled")
    if (!force && !aiService.isAutoGroupEnabled()) return skip("disabled")
    if (this.running) {
      this.rerunWindows.add(windowId)
      return skip("busy")
    }

    this.running = true
    const stopKeepAlive = startKeepAlive()
    try {
      const readiness = await this.ensureModelReady()
      if (readiness !== "ready") {
        if (readiness === "model-loading" && !force) this.schedule(windowId, MODEL_LOADING_RETRY_MS)
        return skip(readiness)
      }

      const collected = await this.collect(windowId)
      const pick = pickCandidates(collected.candidates, this.evaluated, {
        force,
        existingGroupCount: collected.aiGroups.length,
        cap: MAX_CANDIDATES
      })
      if (!pick.shouldRun) return skip("nothing-new")

      const existingTitles = collected.aiGroups
        .map(group => group.title)
        .slice(0, MAX_EXISTING_GROUPS)
      console.log(
        `[AiAutoGroup] Window ${windowId}: asking about ${pick.tabs.length} tab(s),`,
        `${existingTitles.length} existing topic group(s)`
      )

      const completion = await aiService.complete({
        messages: tabAutoGroupPrompt(pick.tabs, existingTitles),
        temperature: 0.2,
        maxTokens: 768,
        responseFormat: "json"
      })
      for (const tab of pick.tabs) this.evaluated.add(tabKey(tab))

      const parsed = parseAiSuggestionResponse(completion.content, pick.tabs)
      if (!parsed.success) {
        console.warn("[AiAutoGroup] Could not parse model output:", parsed.error)
        return skip("error", parsed.error)
      }

      const actions = planGroupActions(parsed.suggestions, {
        joinableGroups: collected.joinableGroups,
        reservedTitles: collected.reservedTitles,
        minimumTabsForNewGroup: 2
      })
      const changes = await this.apply(actions)
      const result: AiAutoGroupRunResult = { ran: true, ...changes }
      this.lastRun = { at: Date.now(), windowId, result }
      console.log("[AiAutoGroup] Pass complete:", changes)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[AiAutoGroup] Pass failed:", error)
      return skip("error", message)
    } finally {
      stopKeepAlive()
      this.running = false
      // A window that changed while this pass ran gets its own pass now
      for (const pending of this.rerunWindows) this.schedule(pending)
      this.rerunWindows.clear()
    }
  }

  private async ensureModelReady(): Promise<"ready" | AiAutoGroupSkipReason> {
    const { status } = aiService.getModelStatus()
    if (status === "ready") return "ready"
    if (status === "loading") return "model-loading"
    if (status === "error") return "model-error"

    // Idle: the worker has restarted since the model was last loaded. The
    // weights are cached, so bringing it back is a matter of seconds.
    const webGpu = await aiService.checkWebGpuSupport()
    if (!webGpu.available) return "model-unavailable"
    try {
      await aiService.loadModel()
      return "ready"
    } catch (error) {
      console.error("[AiAutoGroup] Could not load model:", error)
      return "model-error"
    }
  }

  /**
   * Sorts a window's tabs into what the model may move and what it must not.
   *
   * Fair game: ungrouped tabs, and tabs in groups the extension built by
   * domain. Off limits: pinned and system tabs; tabs a rule or blacklist
   * claims; groups the user excluded; groups the user or another extension
   * made; and groups an earlier pass made — those only appear in the prompt
   * as somewhere a new tab could go.
   */
  private async collect(windowId: number): Promise<Collected> {
    const [tabs, groupsInWindow, allGroups] = await Promise.all([
      browser.tabs.query({ windowId }),
      browser.tabGroups.query({ windowId }),
      browser.tabGroups.query({})
    ])

    await aiGroupLedger.prune(
      allGroups.map(group => stripIndexPrefix(group.title || "")).filter(Boolean)
    )

    const tabsByGroup = new Map<number, Browser.tabs.Tab[]>()
    for (const tab of tabs) {
      if (tab.groupId === undefined || tab.groupId === -1) continue
      const list = tabsByGroup.get(tab.groupId) ?? []
      list.push(tab)
      tabsByGroup.set(tab.groupId, list)
    }

    const kinds = new Map<number, GroupKind>()
    for (const group of groupsInWindow) {
      kinds.set(group.id, await this.classify(group, tabsByGroup.get(group.id) ?? []))
    }

    const candidates: CandidateTab[] = []
    for (const tab of tabs) {
      if (!isEligibleTab(tab)) continue
      if (tab.groupId !== undefined && tab.groupId !== -1 && kinds.get(tab.groupId) !== "own") {
        continue
      }
      if (await rulesService.findBlacklistMatch(tab.url || "", tab.title)) continue
      if (await rulesService.findMatchingRule(tab.url || "", tab.title)) continue
      candidates.push({ tabId: tab.id!, title: tab.title!.trim(), url: tab.url! })
    }

    const asExisting = (group: Browser.tabGroups.TabGroup): ExistingGroup => ({
      id: group.id,
      title: stripIndexPrefix(group.title || "")
    })
    const aiGroups = groupsInWindow.filter(group => kinds.get(group.id) === "ai").map(asExisting)
    const joinableGroups = groupsInWindow
      .filter(group => {
        const kind = kinds.get(group.id)
        return kind === "ai" || kind === "own"
      })
      .map(asExisting)

    const reservedTitles = [
      "System",
      ...Object.values(tabGroupState.getCustomRulesObject())
        .filter(rule => rule.enabled)
        .map(rule => rule.name),
      ...tabGroupState.protectedGroupTitles
    ]

    return { candidates, aiGroups, joinableGroups, reservedTitles }
  }

  private async classify(
    group: Browser.tabGroups.TabGroup,
    tabsInGroup: Browser.tabs.Tab[]
  ): Promise<GroupKind> {
    const title = stripIndexPrefix(group.title || "")
    if (title === "System") return "system"
    if (tabGroupService.isProtectedTitle(group.title)) return "protected"
    if (aiGroupLedger.has(title)) return "ai"
    if (await tabGroupService.isOwnGroup(group, tabsInGroup)) return "own"
    return "foreign"
  }

  private async apply(actions: GroupAction[]): Promise<AiAutoGroupChanges> {
    let groupsCreated = 0
    let groupsJoined = 0
    let tabsMoved = 0

    for (const action of actions) {
      try {
        const tabIds = await this.stillOpen(
          action.tabIds,
          action.type === "join" ? action.groupId : null
        )
        if (tabIds.length === 0) continue
        if (action.type === "create" && tabIds.length < 2) continue

        if (action.type === "join") {
          await withTabEditRetry(() =>
            browser.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId: action.groupId })
          )
          groupsJoined++
          tabsMoved += tabIds.length
          continue
        }

        const groupId = await withTabEditRetry(() =>
          browser.tabs.group({ tabIds: tabIds as [number, ...number[]] })
        )
        await withTabEditRetry(() =>
          browser.tabGroups.update(groupId, { title: action.title, color: action.color })
        )
        await aiGroupLedger.add(action.title)
        groupsCreated++
        tabsMoved += tabIds.length
      } catch (error) {
        console.warn(`[AiAutoGroup] Could not apply "${action.title}":`, error)
      }
    }

    if (groupsCreated + groupsJoined > 0) {
      await tabSortService.applySorting()
    }
    return { groupsCreated, groupsJoined, tabsMoved }
  }

  /** Drops tabs that closed since the model saw them, and ones already in the target group */
  private async stillOpen(tabIds: number[], targetGroupId: number | null): Promise<number[]> {
    const open: number[] = []
    for (const tabId of tabIds) {
      try {
        const tab = await browser.tabs.get(tabId)
        if (targetGroupId !== null && tab.groupId === targetGroupId) continue
        open.push(tabId)
      } catch {
        // Closed in the meantime
      }
    }
    return open
  }
}

export const aiAutoGroupService = new AiAutoGroupService()
