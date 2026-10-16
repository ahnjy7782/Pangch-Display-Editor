type RequestEntry = { uuid: string; at: number };
type AccountTiming = { requests: RequestEntry[]; jobMs: number; blockedUntil: number; overhead: number };
export type ScheduledAccount = { uuid: string; retryAt?: number };
const windowMs = 60000;
// shortcut: 10/account and 20/shared requests per minute are live measurements; revise these starting budgets if the API changes.
const accountLimit = 10;
const sharedLimit = 20;

export class MinecraftRequestSchedule {
  private accounts = new Map<string, AccountTiming>();
  private requests: RequestEntry[] = [];
  private sharedBlockedUntil = 0;
  private lastRejected?: { uuid: string; at: number };
  constructor(private now = Date.now) {}

  private account(uuid: string): AccountTiming {
    let account = this.accounts.get(uuid);
    if (!account) {
      account = { requests: [], jobMs: 1000, blockedUntil: 0, overhead: 2 };
      this.accounts.set(uuid, account);
    }
    return account;
  }
  private availableAt(requests: RequestEntry[], limit: number, at: number, cost = 1): number {
    const recent = requests.filter(request => request.at > at - windowMs).sort((a, b) => a.at - b.at);
    return recent.length + cost <= limit ? at : recent[recent.length + cost - limit - 1].at + windowMs + 100;
  }
  readyAt(uuid: string, cost = 1): number {
    const at = this.now(), account = this.account(uuid);
    return Math.max(account.blockedUntil, this.sharedBlockedUntil,
      this.availableAt(account.requests, accountLimit, at, cost), this.availableAt(this.requests, sharedLimit, at, cost));
  }
  begin(uuid: string): RequestEntry {
    const at = this.now(), account = this.account(uuid);
    account.requests = account.requests.filter(request => request.at > at - windowMs);
    this.requests = this.requests.filter(request => request.at > at - windowMs);
    const request = { uuid, at };
    account.requests.push(request); this.requests.push(request);
    return request;
  }
  finish(request: RequestEntry, error?: unknown): void {
    const at = this.now(), account = this.account(request.uuid);
    const failure = error as { status?: number; retryAt?: number; request?: string };
    if (failure?.status === 429 || (failure?.request && !failure.request.includes('/minecraft/profile'))) {
      account.requests = account.requests.filter(entry => entry !== request);
      this.requests = this.requests.filter(entry => entry !== request);
    } else request.at = at;
    if (failure?.status === 429 && (!failure.request || failure.request.includes('/minecraft/profile'))) {
      const until = Math.max(at + 2000, failure.retryAt || 0);
      account.blockedUntil = Math.max(account.blockedUntil, until);
      if (this.lastRejected && this.lastRejected.uuid !== request.uuid && at - this.lastRejected.at < 2000) {
        this.sharedBlockedUntil = Math.max(this.sharedBlockedUntil, until);
      }
      this.lastRejected = { uuid: request.uuid, at };
    }
  }
  observeJob(uuid: string, ms: number): void {
    const account = this.account(uuid);
    account.jobMs = account.jobMs * 0.75 + Math.max(1, ms) * 0.25;
  }
  observeBackup(uuid: string, hasSkin: boolean): void { this.account(uuid).overhead = hasSkin ? 2 : 3; }
  private completionAt(requests: RequestEntry[], limit: number, count: number, at: number, ms: number): number {
    const history = requests.map(request => ({ ...request }));
    for (let index = 0; index < count; index++) {
      at = this.availableAt(history, limit, at);
      history.push({ uuid: '', at });
      if (history.length > limit * 2) history.splice(0, history.length - limit);
      at += ms;
    }
    return at;
  }
  plan(available: ScheduledAccount[], jobs: number): Map<string, number> {
    if (!jobs || !available.length) return new Map();
    const now = this.now();
    const ranked = [...available].sort((a, b) =>
      Math.max(a.retryAt || 0, this.readyAt(a.uuid, 2)) + this.account(a.uuid).jobMs * (this.account(a.uuid).overhead + 1) -
      Math.max(b.retryAt || 0, this.readyAt(b.uuid, 2)) - this.account(b.uuid).jobMs * (this.account(b.uuid).overhead + 1));
    let best = new Map<string, number>(), bestAt = Infinity;
    for (let count = 1; count <= Math.min(jobs, ranked.length); count++) {
      const chosen = ranked.slice(0, count);
      const allocations = chosen.map((entry, index) => ({ entry, jobs: Math.floor(jobs / count) + (index < jobs % count ? 1 : 0) }));
      const requestsMs = 1 / chosen.reduce((sum, entry) => sum + 1 / this.account(entry.uuid).jobMs, 0);
      let completedAt = this.completionAt(this.requests, sharedLimit, jobs + chosen.reduce((sum, entry) => sum + this.account(entry.uuid).overhead, 0),
        Math.max(now, this.sharedBlockedUntil), requestsMs);
      for (const allocation of allocations) {
        const account = this.account(allocation.entry.uuid);
        completedAt = Math.max(completedAt, this.completionAt(account.requests, accountLimit, allocation.jobs + account.overhead,
          Math.max(now, account.blockedUntil, allocation.entry.retryAt || 0), account.jobMs));
      }
      // Sub-millisecond rounding must not add accounts and their backup/restore requests.
      if (completedAt < bestAt - 1) {
        bestAt = completedAt;
        best = new Map(allocations.map(allocation => [allocation.entry.uuid, allocation.jobs]));
      }
    }
    return best;
  }
}
