import { CACHE_VERSION } from '../config/constants.js';

export async function purgeDailySummaryCache(requestUrl, dateStr) {
  try {
    const cache = caches.default;
    const url = new URL(requestUrl);
    const purgeTargetUrl = `${url.origin}/get-daily-summary?date=${dateStr}&${CACHE_VERSION}`;
    await cache.delete(new Request(purgeTargetUrl));
  } catch (err) {
    console.error(`Failed to purge CDN cache for ${dateStr}:`, err);
  }
}
