import { textureUrl } from './minecraft-skin.js';
import type { TextureJob, TextureProvider } from './head-texture-queue.js';

type QueueResponse = {
  success?: boolean;
  job?: { id: string; status: string; result?: string };
  skin?: { texture?: { url?: { skin?: string } } };
  rateLimit?: { next?: { absolute?: number; relative?: number }; limit?: { remaining?: number; reset?: number; minute?: { remaining?: number; reset?: number }; hour?: { remaining?: number; reset?: number } } };
};
const failure = (message: string, status = 0, retryAt = 0, retryAfterMs?: number) => Object.assign(new Error(message), { status, retryAt, retryAfterMs });

export function mineSkinProvider(key: string, name: string, version: string): TextureProvider {
  const accepted = new Map<string, { id: string; result?: string }>();
  const provider: TextureProvider = { name, disableOnAuthError: true, accepted: job => accepted.has(job.key), upload };
  async function request(route: string, job: TextureJob, signal: AbortSignal, body?: FormData): Promise<QueueResponse> {
    let response: Response;
    try {
      response = await fetch(`https://api.mineskin.org/v2${route}`, {
        method: body ? 'POST' : 'GET', body, redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': `Pangch-Display-Editor/${version}`, Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
      });
    } catch { throw failure('MineSkin 요청에 연결하지 못했습니다.'); }
    const value: unknown = await response.json().catch(() => ({}));
    const data: QueueResponse = value && typeof value === 'object' ? value : {};
    const now = Date.now();
    const retry = response.headers.get('retry-after');
    const parsedRetryAt = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : 0;
    const retryAfterMs = retry && Number.isFinite(parsedRetryAt) ? Math.max(0, parsedRetryAt - now) : undefined;
    const limits = [data.rateLimit?.limit, data.rateLimit?.limit?.minute, data.rateLimit?.limit?.hour];
    const retryAt = Math.max(
      Number.isFinite(parsedRetryAt) ? parsedRetryAt : 0,
      Number(data.rateLimit?.next?.absolute) || 0,
      now + (Number(data.rateLimit?.next?.relative) || 0),
      ...limits.map(limit => limit?.remaining === 0 ? (Number(limit.reset) || 0) * 1000 : 0),
      response.status === 429 ? (Number(response.headers.get('x-ratelimit-reset') ?? response.headers.get('x-rate-limit-reset')) || 0) * 1000 : 0
    );
    provider.retryAt = Math.max(provider.retryAt ?? 0, retryAt);
    // API bodies and fetch errors can echo credentials; expose only a fixed message.
    if (data.job?.status === 'failed' && response.status !== 401 && response.status !== 403) {
      accepted.delete(job.key);
      throw failure('MineSkin 작업 생성에 실패했습니다. 자동 재시도합니다.', 0, retryAt, retryAfterMs);
    }
    if (!response.ok || data.success === false) throw failure(
      response.status === 401 || response.status === 403 ? 'MineSkin 인증 키를 확인해 주세요.' : `MineSkin 요청 실패 (HTTP ${response.status})`,
      response.ok ? 400 : response.status, retryAt, retryAfterMs
    );
    return data;
  }
  async function upload(job: TextureJob, signal: AbortSignal): Promise<string> {
    let queued = accepted.get(job.key);
    let data: QueueResponse;
    if (!queued) {
      const body = new FormData();
      body.set('variant', 'classic'); body.set('visibility', 'unlisted');
      body.set('file', new Blob([new Uint8Array(job.png)], { type: 'image/png' }), 'skin.png');
      data = await request('/queue', job, signal, body);
      if (data.job?.id) {
        if (typeof data.job.id !== 'string' || data.job.id.length > 256) throw failure('MineSkin 작업 ID가 올바르지 않습니다.', 400);
        queued = { id: data.job.id }; accepted.set(job.key, queued);
      }
    } else if (queued.result) data = await request(`/skins/${encodeURIComponent(queued.result)}`, job, signal);
    else data = await request(`/queue/${encodeURIComponent(queued.id)}`, job, signal);
    if (data.skin?.texture?.url?.skin) {
      try { return textureUrl(data.skin.texture.url.skin); }
      catch { throw failure('MineSkin 텍스처 URL이 올바르지 않습니다.', 400); }
    }
    if (queued && data.job?.result) {
      if (typeof data.job.result !== 'string' || data.job.result.length > 256) throw failure('MineSkin 결과 ID가 올바르지 않습니다.', 400);
      queued.result = data.job.result;
      data = await request(`/skins/${encodeURIComponent(queued.result)}`, job, signal);
      try { return textureUrl(data.skin?.texture?.url?.skin!); }
      catch { throw failure('MineSkin 결과 텍스처가 올바르지 않습니다.', 400); }
    }
    if (!queued) throw failure('MineSkin 접수 응답이 올바르지 않습니다.', 400);
    // Poll through the shared scheduler, keeping this accepted job on its worker.
    throw Object.assign(failure('MineSkin 작업 완료 대기', 429, Math.max(Date.now() + 2000, provider.retryAt ?? 0)), { polling: true });
  }
  return provider;
}
