/**
 * The decisions behind AI auto-grouping, kept free of browser calls so they
 * can be tested as plain functions. The service around them does the querying
 * and the moving.
 */

import type { Browser } from "wxt/browser"
import type { AiGroupSuggestion, TabGroupColor } from "../types"
import { extractDomain } from "./DomainUtils"

export interface CandidateTab {
  tabId: number
  title: string
  url: string
}

export interface ExistingGroup {
  id: number
  title: string
}

export type GroupAction =
  | { type: "join"; groupId: number; title: string; tabIds: number[] }
  | { type: "create"; title: string; color: TabGroupColor; tabIds: number[] }

export interface PlanOptions {
  /** Groups in the window a suggestion may put tabs into, matched by title */
  joinableGroups: readonly ExistingGroup[]
  /** Titles a suggestion must never produce: rule names, "System", excluded groups */
  reservedTitles: readonly string[]
  /** A group that does not exist yet needs at least this many tabs */
  minimumTabsForNewGroup: number
}

export interface PickOptions {
  /** Run even when every candidate has been seen before ("Group by Topic Now") */
  force: boolean
  /** How many topic groups already exist; a lone tab can still join one */
  existingGroupCount: number
  /** Upper bound on tabs sent to the model */
  cap: number
}

export interface Pick {
  shouldRun: boolean
  tabs: CandidateTab[]
}

/**
 * Identity of a tab for "already evaluated" purposes. A tab that navigates or
 * changes its title is a new question for the model.
 */
export function tabKey(tab: CandidateTab): string {
  return `${tab.tabId}|${tab.url}|${tab.title}`
}

/**
 * Whether a tab is something the model could sensibly place: a real page with
 * a title, not pinned, not still loading.
 */
export function isEligibleTab(tab: Browser.tabs.Tab): boolean {
  if (tab.id === undefined || tab.pinned || !tab.url) return false
  if (tab.status === "loading") return false
  if (tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) {
    return false
  }
  if (extractDomain(tab.url, false) === "system") return false
  return !!tab.title?.trim()
}

/**
 * Chooses which candidates go to the model, if any.
 *
 * A pass is only worth its inference time when something has changed since the
 * last one, so it needs at least one tab it has not judged before — unless
 * forced. Tabs judged earlier still ride along as context, most recent first,
 * so a new tab can be grouped with an old one; they just cannot trigger a pass
 * on their own.
 */
export function pickCandidates(
  candidates: readonly CandidateTab[],
  evaluatedKeys: ReadonlySet<string>,
  options: PickOptions
): Pick {
  const fresh = candidates.filter(tab => !evaluatedKeys.has(tabKey(tab)))
  const seen = candidates.filter(tab => evaluatedKeys.has(tabKey(tab)))

  if (!options.force && fresh.length === 0) return { shouldRun: false, tabs: [] }
  if (candidates.length < 2 && options.existingGroupCount === 0) {
    return { shouldRun: false, tabs: [] }
  }

  const tabs = [...fresh, ...seen.reverse()].slice(0, options.cap)
  return { shouldRun: true, tabs }
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase()
}

/**
 * Turns the model's suggestions into group operations.
 *
 * A suggestion whose name matches a group already in the window joins it, so
 * a tab lands in "Trip Planning" rather than a second "Trip planning". A name
 * that belongs to a rule or to a group the user excluded is refused outright:
 * those groups have owners. Anything else becomes a new group, provided
 * enough tabs share it — a group of one is no grouping at all, and the tab is
 * better off where the domain pass put it.
 */
export function planGroupActions(
  suggestions: readonly AiGroupSuggestion[],
  options: PlanOptions
): GroupAction[] {
  const reserved = new Set(options.reservedTitles.map(normalizeTitle))
  const joinable = new Map(
    options.joinableGroups.map(group => [normalizeTitle(group.title), group])
  )
  const actions: GroupAction[] = []
  const creates = new Map<string, Extract<GroupAction, { type: "create" }>>()
  const claimed = new Set<number>()

  for (const suggestion of suggestions) {
    const title = suggestion.groupName.trim()
    if (!title) continue
    const key = normalizeTitle(title)
    if (reserved.has(key)) continue

    const tabIds = suggestion.tabs.map(tab => tab.tabId).filter(tabId => !claimed.has(tabId))
    if (tabIds.length === 0) continue

    const existing = joinable.get(key)
    if (existing) {
      actions.push({ type: "join", groupId: existing.id, title: existing.title, tabIds })
      for (const tabId of tabIds) claimed.add(tabId)
      continue
    }

    const pending = creates.get(key)
    if (pending) {
      pending.tabIds.push(...tabIds)
      for (const tabId of tabIds) claimed.add(tabId)
      continue
    }

    if (tabIds.length < options.minimumTabsForNewGroup) continue

    const action: Extract<GroupAction, { type: "create" }> = {
      type: "create",
      title,
      color: suggestion.color,
      tabIds
    }
    creates.set(key, action)
    actions.push(action)
    for (const tabId of tabIds) claimed.add(tabId)
  }

  return actions
}
