import type { QuotaOutlookPool, QuotaOutlookResponse } from '@freellmapi/shared/types.js';
import { getQuotaStateForKeys, type QuotaObservationView } from './provider-quota.js';
import { getQuotaForecast, RATE_OBSERVATION_WINDOW_MINUTES } from './quota-forecast.js';

const WARNING_REMAINING_RATIO = 0.2;
const WARNING_EXHAUSTION_MS = 2 * 60 * 60_000;
const MAX_OBSERVATION_AGE_MS = RATE_OBSERVATION_WINDOW_MINUTES * 60_000;

function remainingRatio(row: QuotaObservationView): number {
  return row.limit != null && row.limit > 0 && row.remaining != null
    ? row.remaining / row.limit : Infinity;
}

function utcMillis(value: string | null): number {
  if (!value) return NaN;
  return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}

/** Dashboard presentation over the existing request forecast. No writes or probes. */
export function getQuotaOutlook(): QuotaOutlookResponse {
  const now = Date.now();
  const rows = getQuotaStateForKeys({ normalizeExpired: false });
  const forecasts = new Map(getQuotaForecast(rows, now).map(row => [row.pool, row]));
  const tightest = new Map<string, QuotaObservationView>();
  for (const row of rows) {
    if (row.metric !== 'requests') continue;
    const previous = tightest.get(row.quotaPoolKey);
    // Match the forecast service's rounded-percentage tie-breaking so the
    // balance and projection always describe the very same observation.
    const score = (value: QuotaObservationView) => Number.isFinite(remainingRatio(value))
      ? Math.max(0, Math.min(100, Math.round(remainingRatio(value) * 100))) : Infinity;
    if (!previous || score(row) < score(previous)) tightest.set(row.quotaPoolKey, row);
  }

  const pools = [...tightest.values()].map((row): QuotaOutlookPool => {
    const forecast = forecasts.get(row.quotaPoolKey);
    const known = row.limit != null && Number.isFinite(row.limit) && row.limit > 0
      && row.remaining != null && Number.isFinite(row.remaining) && row.remaining >= 0
      && row.remaining <= row.limit;
    const observedMs = utcMillis(row.observedAt);
    const resetMs = utcMillis(row.resetAt);
    // Unknown reset times, old observations and low-confidence probes cannot
    // support a reassuring forecast. Raw values remain visible as last reported.
    const fresh = Number.isFinite(observedMs) && observedMs <= now
      && now - observedMs <= MAX_OBSERVATION_AGE_MS
      && Number.isFinite(resetMs) && resetMs > now && row.confidence >= 0.7;
    const rate = known && fresh ? forecast?.rate_per_min ?? null : null;
    const exhaustion = known && fresh ? forecast?.estimated_exhaustion_at ?? null : null;
    let status: QuotaOutlookPool['status'];
    if (!known) status = 'unknown';
    else if (!fresh) status = 'stale';
    else if (row.remaining === 0) status = 'exhausted';
    else if (rate == null || rate <= 0) status = 'insufficient_data';
    else if (exhaustion) status = 'forecast';
    else status = 'resets_first';

    let warning: QuotaOutlookPool['warning'] = null;
    if (known && fresh) {
      if (remainingRatio(row) < WARNING_REMAINING_RATIO) warning = 'low_balance';
      else if (exhaustion && Date.parse(exhaustion) - now <= WARNING_EXHAUSTION_MS) warning = 'exhausting_soon';
    }
    return {
      platform: row.platform,
      pool: row.quotaPoolKey,
      limit: row.limit,
      remaining: row.remaining,
      remainingPct: known ? Math.round(remainingRatio(row) * 100) : null,
      observedAt: row.observedAt,
      resetAt: Number.isFinite(resetMs) ? row.resetAt : null,
      ratePerMin: rate,
      estimatedExhaustionAt: exhaustion,
      status,
      warning,
    };
  });
  pools.sort((a, b) => Number(Boolean(b.warning)) - Number(Boolean(a.warning)) || a.pool.localeCompare(b.pool));
  return { generatedAt: new Date(now).toISOString(), pools };
}
