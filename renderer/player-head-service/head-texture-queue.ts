import type { HeadTextureState } from './head-texture-types.js';

export interface TextureJob { key: string; sources: string[]; png: Uint8Array; }
export interface TextureProvider {
  name: string;
  upload(job: TextureJob, signal: AbortSignal): Promise<string>;
  verify?(job: TextureJob, url: string): Promise<void>;
  reconcile?(job: TextureJob): Promise<string | undefined>;
  accepted?(job: TextureJob): boolean;
  backup?(): Promise<void>;
  restore?(): Promise<void>;
  needsRestore?(): boolean;
  finish?(): Promise<void>;
  disableOnAuthError?: boolean;
  changeInterval?: number;
  retryAt?: number;
  nextJobAt?(): number;
  maxJobs?: number;
}
export interface TextureQueueOptions {
  providers: TextureProvider[];
  result(job: TextureJob, url: string): Promise<void>;
  finish?(): Promise<void>;
  status(state: HeadTextureState): void;
  log?(message: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}
type Worker = { provider: TextureProvider; phase: HeadTextureState['phase']; retryAt?: number; error?: string; blocked?: boolean; retries: number; retryMs: number; retryStartedAt?: number; retryCauses: Map<string, number>; rateLimitAttempt: number; completed: number; busy: boolean; applying: number };
type Pending = { job: TextureJob; uncertain: boolean; url?: string; attempt: number; startedAt?: number; applyError?: unknown };
export const retryDelay = (attempt: number, status?: number): number => status === 429
  ? 2000 * 2 ** Math.min(attempt, 2)
  : Math.min(300000, 30000 * 2 ** Math.min(attempt, 4));
export const retryable = (error: unknown): boolean => {
  const status = (error as { status?: number })?.status;
  return !status || status === 401 || status === 408 || status === 429 || status >= 500;
};

export class HeadTextureQueue {
  state: HeadTextureState = { running: false, phase: 'idle', total: 0, completed: 0, failed: 0 };
  private cancelled = false;
  private controller = new AbortController();
  private wakes = new Map<() => void, boolean>();
  private workers: Worker[] = [];
  private task?: Promise<void>;
  private now: () => number;
  private invalidError?: string;
  private generationMs: number[] = [];
  private retryAfterMs: number[] = [];
  private startedAt = 0;
  private generationFinishedAt?: number;
  private finishedAt?: number;
  constructor(private options: TextureQueueOptions) { this.now = options.now ?? Date.now; }

  get completionSummary(): string {
    if (this.generationFinishedAt === undefined) return '생성 처리 미완료';
    return `생성 처리 완료(실패 포함) ${((this.generationFinishedAt - this.startedAt) / 1000).toFixed(3)}초 | 이후 복원·정리 ${(((this.finishedAt ?? this.now()) - this.generationFinishedAt) / 1000).toFixed(3)}초`;
  }

  get timingSummary(): string {
    const format = (samples: number[]) => {
      if (!samples.length) return '측정 없음';
      const minimum = samples.reduce((min, ms) => Math.min(min, ms), Infinity);
      const maximum = samples.reduce((max, ms) => Math.max(max, ms), 0);
      const average = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
      return `최소 ${(minimum / 1000).toFixed(3)}초 · 최대 ${(maximum / 1000).toFixed(3)}초 · 평균 ${(average / 1000).toFixed(3)}초`;
    };
    return `텍스처 생성(성공 ${this.generationMs.length}개, 재시도 포함) | ${format(this.generationMs)} | 서버 Retry-After(${this.retryAfterMs.length}회) | ${format(this.retryAfterMs)}`;
  }

  start(jobs: TextureJob[], cached = 0, invalid = 0): void {
    if (this.state.running) throw new Error('이미 텍스처 생성 또는 스킨 복원이 진행 중입니다.');
    this.cancelled = false;
    this.controller = new AbortController();
    this.generationMs = []; this.retryAfterMs = [];
    this.startedAt = this.now(); this.generationFinishedAt = undefined; this.finishedAt = undefined;
    this.workers = this.options.providers.map(provider => ({ provider, phase: 'uploading', retries: 0, retryMs: 0, retryCauses: new Map(), rateLimitAttempt: 0, completed: 0, busy: false, applying: 0 }));
    this.invalidError = invalid ? `${invalid}개 텍스처는 유효한 64×64/64×32 PNG가 아니므로 원본을 유지합니다.` : undefined;
    this.state = { running: true, phase: 'uploading', total: jobs.length + cached + invalid, completed: cached, failed: invalid };
    this.publish();
    this.task = this.run(jobs);
  }
  cancel(): void { this.cancelled = true; this.controller.abort(); this.notify(); }
  resume(): void { this.notify(true); }
  settled(): Promise<void> { return this.task ?? Promise.resolve(); }
  private recordRetry(worker: Worker, error: unknown, operation: string): void {
    worker.retries++; worker.retryStartedAt ??= this.now();
    const { status, request, retryAfterMs } = (error ?? {}) as { status?: number; request?: string; retryAfterMs?: number };
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs.push(retryAfterMs);
    const cause = [operation, request, status ? `HTTP ${status}` : '응답 오류'].filter(Boolean).join(' / ');
    worker.retryCauses.set(cause, (worker.retryCauses.get(cause) ?? 0) + 1);
  }
  private finishRetry(worker: Worker): void {
    if (worker.retryStartedAt === undefined) return;
    worker.retryMs += this.now() - worker.retryStartedAt;
    worker.retryStartedAt = undefined;
  }
  private nextRetryAt(worker: Worker, error: unknown, attempt: number): number {
    const { status, retryAt, retryAfterMs } = (error ?? {}) as { status?: number; retryAt?: number; retryAfterMs?: number };
    const nextAttempt = status === 429 ? worker.rateLimitAttempt++ : attempt;
    const serverTiming = status === 429 && (Number(retryAt) > this.now() || retryAfterMs !== undefined);
    return Math.max(this.now() + retryDelay(serverTiming ? 0 : nextAttempt, status), Number(retryAt) || 0);
  }
  private notify(includeBlocked = false): void {
    for (const [wake, blocked] of this.wakes) if (includeBlocked || !blocked) wake();
  }
  private publish(): void {
    if (!this.cancelled && this.state.completed + this.state.failed === this.state.total) this.generationFinishedAt ??= this.now();
    const active = this.workers.filter(worker => worker.phase !== 'complete');
    const retries = active.flatMap(worker => worker.retryAt ? [worker.retryAt] : []);
    const phase = active.some(worker => worker.phase === 'restoring') ? 'restoring'
      : active.some(worker => worker.phase === 'applying') ? 'applying'
      : active.some(worker => worker.phase === 'uploading') ? 'uploading' : 'waiting';
    Object.assign(this.state, {
      phase: this.state.running ? phase : this.cancelled ? 'cancelled' : this.state.failed ? 'failed' : 'complete',
      retryAt: this.state.running && retries.length ? Math.min(...retries) : undefined,
      restoreBlocked: active.some(worker => worker.blocked),
      error: [this.invalidError, ...this.workers.map(worker => worker.error ? `${worker.provider.name}: ${worker.error}` : undefined)].filter(Boolean).join(' · ') || undefined
    });
    this.options.status({ ...this.state });
  }
  private async wait(ms?: number, blocked = false): Promise<void> {
    if (ms !== undefined && ms <= 0) return;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => { if (timer) clearTimeout(timer); this.wakes.delete(wake); resolve(); };
      this.wakes.set(wake, blocked);
      if (ms !== undefined) {
        if (this.options.sleep) void this.options.sleep(ms).then(wake);
        else timer = setTimeout(wake, ms);
      }
    });
  }
  private async change<T>(worker: Worker, action: () => Promise<T>): Promise<T> {
    const provider = worker.provider;
    while ((provider.retryAt ?? 0) > this.now()) {
      worker.retryAt = provider.retryAt; this.publish();
      await this.wait(provider.retryAt! - this.now());
    }
    let changeInterval = provider.changeInterval ?? 0;
    try {
      const result = await action();
      worker.rateLimitAttempt = 0;
      return result;
    }
    catch (error) {
      // A rejected mutation uses the retry delay rather than the successful-change interval.
      if ((error as { status?: number })?.status === 429) changeInterval = retryDelay(0, 429);
      throw error;
    }
    finally { provider.retryAt = Math.max(provider.retryAt ?? 0, this.now() + changeInterval); }
  }
  private async restore(worker: Worker): Promise<void> {
    if (!worker.provider.restore) return;
    let attempt = 0;
    for (;;) {
      worker.phase = 'restoring'; worker.blocked = false; this.publish();
      try {
        if (worker.provider.needsRestore?.() === false) await worker.provider.restore();
        else await this.change(worker, () => worker.provider.restore!());
        this.finishRetry(worker);
        if (worker.error?.startsWith('원래 스킨 복원 대기:')) worker.error = undefined;
        worker.retryAt = undefined;
        return;
      } catch (error) {
        worker.error = `원래 스킨 복원 대기: ${error instanceof Error ? error.message : String(error)}`;
        if (!retryable(error)) {
          worker.blocked = true; worker.retryAt = undefined;
          worker.error += ' 백업은 보관됩니다. 해당 계정으로 다시 로그인하거나, 런처에서 원래 스킨을 복원한 뒤 ‘복원 재시도’를 눌러 주세요.';
          this.publish(); await this.wait(undefined, true);
        } else {
          if (!(error as { polling?: boolean })?.polling) this.recordRetry(worker, error, '복원');
          worker.retryAt = Math.max(worker.provider.retryAt ?? 0, this.nextRetryAt(worker, error, attempt++));
          worker.provider.retryAt = worker.retryAt;
          this.publish(); await this.wait(worker.retryAt - this.now());
        }
      }
    }
  }
  private async run(jobs: TextureJob[]): Promise<void> {
    const pending = jobs.map(job => ({ job, uncertain: false, attempt: 0 } as Pending));
    let inFlight = 0;
    const readyAt = (worker: Worker) => Math.max(worker.provider.retryAt ?? 0, worker.provider.nextJobAt?.() ?? 0);
    const release = (current: Pending, requeue = false) => {
      inFlight--;
      if (requeue) pending.push(current);
      this.notify();
    };
    await Promise.all(this.workers.map(async worker => {
      const provider = worker.provider;
      let current: Pending | undefined;
      let backedUp = false;
      const applications = new Set<Promise<void>>();
      try {
        await this.restore(worker);
        while (!this.cancelled) {
          if (!current && !pending.length && !inFlight) break;
          worker.busy = !!current;
          worker.phase = worker.applying ? 'applying' : 'waiting';
          if (worker.applying >= 2) { this.publish(); await this.wait(); continue; }
          const availableAt = (current?.url || (!current && pending[0]?.url)) ? provider.retryAt ?? 0 : readyAt(worker);
          worker.retryAt = availableAt > this.now() ? availableAt : undefined;
          this.publish();
          if (worker.retryAt) { await this.wait(worker.retryAt - this.now()); continue; }
          if (!current) {
            if (pending.length && !pending[0].url && worker.completed + worker.applying >= (provider.maxJobs ?? Infinity)) {
              const otherCapacity = this.workers.some(other => other !== worker && other.phase !== 'complete' &&
                !other.blocked && other.completed + other.applying < (other.provider.maxJobs ?? Infinity) &&
                ((other.busy && other.phase !== 'waiting') || readyAt(other) <= this.now()));
              const fallback = this.workers.find(other => other.phase !== 'complete' && !other.blocked &&
                other.provider.maxJobs === 0 && readyAt(other) <= this.now()) ?? worker;
              if (otherCapacity || fallback !== worker) { await this.wait(); continue; }
              provider.maxJobs = Infinity;
            }
            current = pending.shift();
            if (!current) { this.finishRetry(worker); await this.wait(); continue; }
            current.startedAt ??= this.now();
            inFlight++;
            worker.busy = true;
          }
          worker.phase = 'uploading'; this.publish();
          let attemptedUpload = false;
          let operation = '백업';
          try {
            if ('applyError' in current) {
              operation = '적용';
              const error = current.applyError; delete current.applyError;
              throw error;
            }
            if (!backedUp && !current.url) { await provider.backup?.(); backedUp = true; worker.rateLimitAttempt = 0; }
            // An uncertain Minecraft mutation stays with its account until checked.
            if (current.uncertain && !current.url) {
              operation = '확인';
              current.url = await provider.reconcile!(current.job);
              current.uncertain = false;
              if (!current.url) { release(current, true); current = undefined; continue; }
            }
            if (!current.url) {
              operation = '생성';
              current.uncertain = !!provider.reconcile;
              current.url = await this.change(worker, () => {
                if (this.cancelled) throw new Error('생성이 취소되었습니다.');
                attemptedUpload = true;
                return provider.upload(current!.job, this.controller.signal);
              });
              current.uncertain = false;
            }
            worker.phase = 'applying'; worker.retryAt = undefined; this.publish();
            operation = '적용';
            const application = current;
            const apply = async () => {
              await provider.verify?.(application.job, application.url!);
              await this.options.result(application.job, application.url!);
              this.generationMs.push(this.now() - application.startedAt!);
              this.finishRetry(worker);
              this.state.completed++; worker.completed++;
              if (!worker.retryAt) worker.error = undefined;
              release(application);
            };
            if (provider.verify) {
              // Immutable texture URLs can be verified while this account uploads its next skin.
              worker.applying++;
              const task = apply().catch(error => {
                application.applyError = error;
                release(application, !this.cancelled);
              }).finally(() => {
                worker.applying--; applications.delete(task);
                this.publish(); this.notify();
              });
              applications.add(task);
            } else await apply();
            current = undefined;
          } catch (error) {
            if (this.cancelled) break;
            if (current.uncertain && !current.url && (error as { status?: number })?.status !== 429) {
              attemptedUpload = false;
              try {
                current.url = await provider.reconcile!(current.job);
                current.uncertain = false;
              } catch (reconcileError) { error = reconcileError; operation = '확인'; }
            }
            const status = (error as { status?: number })?.status;
            worker.error = error instanceof Error ? error.message : String(error);
            if (provider.disableOnAuthError && (status === 401 || status === 403)) {
              if (provider.accepted?.(current.job)) { this.state.failed++; release(current); }
              else release(current, true);
              current = undefined; break;
            }
            if (!retryable(error)) {
              this.state.failed++; release(current); current = undefined;
            } else {
              if (!(error as { polling?: boolean })?.polling) {
                this.recordRetry(worker, error, operation);
              }
              const retryAt = (error as { polling?: boolean })?.polling
                ? Math.max(this.now() + 2000, Number((error as { retryAt?: number })?.retryAt) || 0)
                : this.nextRetryAt(worker, error, current.attempt++);
              provider.retryAt = Math.max(provider.retryAt ?? 0, retryAt);
              // A rejected upload is free to move; accepted MineSkin jobs remain pinned.
              if (status === 429 && attemptedUpload) current.uncertain = false;
              if (!current.url && !current.uncertain && !provider.accepted?.(current.job)) {
                release(current, true); current = undefined;
              }
            }
          }
          this.publish();
        }
      } catch (error) {
        worker.error = error instanceof Error ? error.message : String(error);
        if (current) { release(current, true); current = undefined; }
      } finally {
        worker.busy = false;
        if (current) release(current);
        await Promise.all(applications);
        await this.restore(worker);
        try { await provider.finish?.(); }
        catch (error) { worker.error = String(error); }
        this.finishRetry(worker);
        worker.phase = 'complete'; worker.retryAt = undefined;
        this.publish(); this.notify();
      }
    }));
    if (!this.cancelled) this.state.failed += pending.length;
    try { await this.options.finish?.(); }
    catch (error) { this.invalidError = [this.invalidError, `최종 저장 실패: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join(' · '); }
    this.finishedAt = this.now();
    this.state.running = false; this.publish();
    const retries = this.workers.reduce((sum, worker) => sum + worker.retries, 0);
    const details = this.workers.filter(worker => worker.retries).map(worker => {
      const causes = [...worker.retryCauses].map(([cause, count]) => `${cause}: ${count}회`).join(' · ');
      return `${worker.provider.name}: ${worker.retries}회, 총 소요 ${(worker.retryMs / 1000).toFixed(3)}초 (${causes})`;
    });
    this.options.log?.(`재시도 요약 | 총 ${retries}회${details.length ? ` | ${details.join(' · ')}` : ' | 총 소요 0.000초'}`);
  }
}
