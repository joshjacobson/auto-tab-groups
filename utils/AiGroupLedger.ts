/**
 * Titles of the groups AI auto-grouping has created.
 *
 * A topic name is the only thing that tells such a group apart from one the
 * user built by hand, so the titles are kept — in storage, since the service
 * worker restarts at will — and consulted wherever the domain pass would
 * otherwise treat the group as a stranger's, or, when a topic name happens to
 * coincide with a domain name, as its own.
 */

import { aiGroupTitles as aiGroupTitlesStorage } from "./storage"

class AiGroupLedger {
  private titles = new Set<string>()
  private loaded = false

  /** Reads the ledger from storage once per service worker instance. */
  async load(): Promise<void> {
    if (this.loaded) return
    const stored = await aiGroupTitlesStorage.getValue()
    this.titles = new Set(stored)
    this.loaded = true
  }

  has(title: string | undefined): boolean {
    return !!title && this.titles.has(title)
  }

  isEmpty(): boolean {
    return this.titles.size === 0
  }

  values(): string[] {
    return [...this.titles]
  }

  async add(title: string): Promise<void> {
    if (!title || this.titles.has(title)) return
    this.titles.add(title)
    await this.persist()
  }

  async remove(title: string): Promise<void> {
    if (!this.titles.delete(title)) return
    await this.persist()
  }

  /**
   * Forgets titles no group carries any more, so a stale entry cannot shield a
   * group the user later builds by hand under the same name.
   */
  async prune(liveTitles: Iterable<string>): Promise<void> {
    const live = new Set(liveTitles)
    const stale = [...this.titles].filter(title => !live.has(title))
    if (stale.length === 0) return
    for (const title of stale) this.titles.delete(title)
    await this.persist()
  }

  /** Test seam: replaces the ledger without touching storage. */
  reset(titles: readonly string[] = []): void {
    this.titles = new Set(titles)
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await aiGroupTitlesStorage.setValue([...this.titles])
  }
}

export const aiGroupLedger = new AiGroupLedger()
