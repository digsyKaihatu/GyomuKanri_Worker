import { CORS_HEADERS, CACHE_VERSION } from './config/constants.js';
import { getJSTDate, getJSTISOString, getJSTDateString } from './utils/dateHelper.js';
import { jsonResponse, errorResponse } from './utils/responseHelper.js';
import { getAccessToken } from './utils/cryptoHelper.js';
import { D1Service } from './services/d1Service.js';
import { purgeDailySummaryCache } from './services/cacheService.js';
import { sendFcmMessage, aggregateAndSaveDate } from './services/firebaseService.js';

export default {
  /**
   * 1. HTTP API リクエスト処理
   */
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (!env.DB) {
        throw new Error("D1 データベース接続 (env.DB) がバインドされていません。wrangler.jsonc を確認してください。");
      }

      const url = new URL(request.url);
      const d1 = new D1Service(env.DB);

      // --- 全ユーザーのステータス取得 ---
      if (url.pathname === "/get-all-status") {
        const results = await d1.getAllWorkStatus();
        return jsonResponse(results);
      }

      // --- 特定ユーザーのステータス取得 ---
      if (["/get-user-status", "/get-my-status", "/get-status"].includes(url.pathname)) {
        const userId = url.searchParams.get("userId");
        const result = await d1.getUserWorkStatus(userId);
        return jsonResponse(result || {});
      }

      // --- ステータス更新 ---
      if (["/update-status", "/start-work"].includes(url.pathname) && request.method === "POST") {
        const body = await request.json();
        await d1.upsertWorkStatus(body, getJSTISOString());
        return jsonResponse({ success: true });
      }

      // --- 強制停止 ---
      if (url.pathname === "/force-stop" && request.method === "POST") {
        const { userId } = await request.json();
        await d1.forceStopUser(userId, getJSTISOString());
        return jsonResponse({ success: true });
      }

      // --- 予約関連エンドポイント ---
      if (url.pathname === "/save-reservation" && request.method === "POST") {
        const body = await request.json();
        await d1.upsertReservation(body);
        return jsonResponse({ success: true });
      }

      if (url.pathname === "/get-user-reservations") {
        const userId = url.searchParams.get("userId");
        const results = await d1.getUserReservations(userId);
        return jsonResponse(results);
      }

      if (url.pathname === "/delete-reservation" && request.method === "POST") {
        const { id } = await request.json();
        await d1.deleteReservation(id);
        return jsonResponse({ success: true });
      }

      // --- 戸村さんステータス関連 ---
      if (url.pathname === "/get-tomura-status") {
        const setting = await d1.getSetting('tomura_status');
        const defaultVal = JSON.stringify({ status: "声掛けOK", location: "出社" });
        return jsonResponse(setting ? JSON.parse(setting.value) : JSON.parse(defaultVal));
      }

      if (url.pathname === "/update-tomura-status" && request.method === "POST") {
        const body = await request.json();
        const value = JSON.stringify({ ...body, date: getJSTDateString() });
        await d1.upsertSetting('tomura_status', value, getJSTISOString());
        return jsonResponse({ success: true });
      }

      // --- FCM メッセージ送信 ---
      if (url.pathname === "/send-message" && request.method === "POST") {
        const reqJson = await request.json();
        const targetUserIds = Array.isArray(reqJson.targetUserId) ? reqJson.targetUserId : [reqJson.targetUserId];
        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        
        const count = await sendFcmMessage(serviceAccount.project_id, token, targetUserIds, reqJson.title, reqJson.messageBody);
        return jsonResponse({ success: true, sent: count });
      }

      // --- 日付指定再集計 ---
      if (url.pathname === "/reaggregate-date" && request.method === "POST") {
        let { date } = await request.json();
        if (!date) return errorResponse("Missing date parameter", 400);
        date = date.replace(/^[?&]?date=/, '').trim();

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const result = await aggregateAndSaveDate(date, serviceAccount.project_id, token);

        await purgeDailySummaryCache(request.url, date);
        return jsonResponse({ success: true, date, logsCount: result.logsCount });
      }

      // --- 日次サマリー取得 (CDN Cache + Firestore フォールバック) ---
      if (url.pathname === "/get-daily-summary") {
        let date = url.searchParams.get("date");
        if (!date) return errorResponse("Missing date parameter", 400);
        date = date.replace(/^[?&]?date=/, '').trim();

        const cleanUrl = `${url.origin}/get-daily-summary?date=${date}&${CACHE_VERSION}`;
        const cacheKey = new Request(cleanUrl);
        const cache = caches.default;

        let cachedResp = await cache.match(cacheKey);
        if (cachedResp) return cachedResp;

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;

        const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/daily_summaries/${date}`;
        let fsResp = await fetch(fsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        let fsData = fsResp.ok ? await fsResp.json() : null;

        let logs = [];
        try {
          logs = JSON.parse(fsData?.fields?.logsJson?.stringValue || "[]");
        } catch (e) {
          logs = [];
        }

        if (fsResp.status === 404 || !Array.isArray(logs) || logs.length === 0) {
          try {
            const aggResult = await aggregateAndSaveDate(date, projectId, token);
            if (aggResult.logsCount > 0) {
              fsResp = await fetch(fsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
              if (fsResp.ok) {
                fsData = await fsResp.json();
                logs = JSON.parse(fsData.fields?.logsJson?.stringValue || "[]");
              }
            }
          } catch (err) {
            console.error(`Auto aggregation failed for ${date}:`, err);
          }
        }

        const hasLogs = Array.isArray(logs) && logs.length > 0;
        const cacheHeader = hasLogs
          ? "public, max-age=0, s-maxage=31536000, must-revalidate"
          : "no-cache, no-store, must-revalidate";

        const response = jsonResponse({ success: true, date, logs }, 200, { "Cache-Control": cacheHeader });
        if (hasLogs) ctx.waitUntil(cache.put(cacheKey, response.clone()));

        return response;
      }

      // --- Cloudflare R2 画像ストレージ関連 ---
      if (url.pathname === "/upload-image" && request.method === "POST") {
        if (!env.IMAGE_BUCKET) return errorResponse("R2 IMAGE_BUCKET が設定されていません", 500);

        const contentType = request.headers.get("Content-Type") || "image/png";
        const imageBuffer = await request.arrayBuffer();

        if (!imageBuffer || imageBuffer.byteLength === 0) return errorResponse("Empty image data", 400);

        const ext = contentType.split("/")[1] || "png";
        const imageId = `img_${crypto.randomUUID()}.${ext}`;

        await env.IMAGE_BUCKET.put(imageId, imageBuffer, {
          httpMetadata: { contentType }
        });

        const cdnUrl = `${url.origin}/cdn-image/${imageId}`;
        return jsonResponse({ success: true, cdnUrl, imageId });
      }

      if (url.pathname.startsWith("/cdn-image/")) {
        if (!env.IMAGE_BUCKET) return errorResponse("R2 IMAGE_BUCKET が設定されていません", 500);

        const imageId = url.pathname.replace("/cdn-image/", "");
        const object = await env.IMAGE_BUCKET.get(imageId);

        if (!object) return new Response("Image not found", { status: 404, headers: CORS_HEADERS });

        const headers = new Headers(CORS_HEADERS);
        object.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000");

        return new Response(object.body, { headers });
      }

      // --- 外部画像プロキシ ---
      if (url.pathname === "/proxy-image") {
        let targetUrl = url.searchParams.get("url");
        if (!targetUrl) return errorResponse("Missing url parameter", 400);
        targetUrl = targetUrl.replace(/&amp;/g, '&');

        const cacheKey = new Request(request.url, request);
        const cache = caches.default;
        let cached = await cache.match(cacheKey);
        if (cached) return cached;

        const imgResp = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!imgResp.ok) return errorResponse(`Failed to fetch image: ${imgResp.status}`, imgResp.status);

        const proxyResponse = new Response(imgResp.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": imgResp.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=31536000, s-maxage=31536000",
          }
        });

        ctx.waitUntil(cache.put(cacheKey, proxyResponse.clone()));
        return proxyResponse;
      }

      return new Response("End Point Not Found", { status: 404, headers: CORS_HEADERS });

    } catch (err) {
      return errorResponse(`${err.message} \n ${err.stack}`, 500);
    }
  },

  /**
   * 2. 定期実行 (Cron Scheduled Task)
   */
  async scheduled(event, env, ctx) {
    const now = new Date();
    const jstTime = getJSTDate(now);
    const hh = String(jstTime.getUTCHours()).padStart(2, '0');
    const mm = String(jstTime.getUTCMinutes()).padStart(2, '0');

    // 夜間バッチ処理 (日本時間 00:05 実行)
    if (hh === "00" && mm === "05") {
      try {
        const yesterday = new Date(jstTime.getTime() - 24 * 60 * 60 * 1000);
        const yyyy = yesterday.getUTCFullYear();
        const m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
        const d = String(yesterday.getUTCDate()).padStart(2, '0');
        const yesterdayStr = `${yyyy}-${m}-${d}`;

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);

        await aggregateAndSaveDate(yesterdayStr, serviceAccount.project_id, token);
        await purgeDailySummaryCache(event.request?.url || "https://muddy-night-4bd4.sora-yamashita.workers.dev/get-daily-summary", yesterdayStr);
      } catch (err) {
        console.error("Nightly Batch Error:", err.message);
      }
    }

    // 予約実行のチェック
    const lookAheadIso = new Date(now.getTime() + 60 * 1000).toISOString();
    try {
      const { results: pendingReservations } = await env.DB.prepare(
        "SELECT * FROM reservations WHERE status = 'reserved' AND scheduledTime <= ?"
      ).bind(lookAheadIso).all();

      if (pendingReservations.length === 0) return;

      const d1 = new D1Service(env.DB);
      for (const res of pendingReservations) {
        const currentStatus = await d1.getUserWorkStatus(res.userId);
        const diffMinutes = (now.getTime() - new Date(res.scheduledTime).getTime()) / (1000 * 60);

        const getNextDayIso = (origTime) => {
          const origDate = new Date(origTime);
          return new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            origDate.getUTCHours(),
            origDate.getUTCMinutes(),
            origDate.getUTCSeconds()
          )).toISOString();
        };

        if (diffMinutes > 10) {
          await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
            .bind(getNextDayIso(res.scheduledTime), res.id).run();
          continue;
        }

        const isCurrentlyWorking = currentStatus && [1, true, '1', 'true'].includes(currentStatus.isWorking);
        if (res.action === "break" && !isCurrentlyWorking) {
          await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
            .bind(getNextDayIso(res.scheduledTime), res.id).run();
          continue;
        }

        await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
          .bind(getNextDayIso(res.scheduledTime), res.id).run();
      }
    } catch (err) {
      console.error("Cron Reservation Error:", err.message);
    }
  }
};
