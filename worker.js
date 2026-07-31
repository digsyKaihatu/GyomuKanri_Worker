/**
 * 業務管理システム: Cloudflare Worker 統合バックエンド (JST完全対応 & Read数最少化・CDN最適化版)
 * 機能: D1ステータス管理, 予約自動実行, Firebaseログ連携, ステータス完全同期, CDNキャッシュ管理
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// 🌟 CDNキャッシュキーのバージョン一元管理 (フロントエンド側と統一)
const CACHE_VERSION = "v=20260729";

// --- 👇 日本時間 (JST: UTC+9) ヘルパー関数 👇 ---
function getJSTDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

// 日本時間表記のISO文字列を作成 ("2026-07-24T14:11:00+09:00")
function getJSTISOString(date = new Date()) {
  const jst = getJSTDate(date);
  return jst.toISOString().replace('Z', '+09:00');
}

// 日本時間の日付文字列を作成 ("2026-07-24")
function getJSTDateString(date = new Date()) {
  const jst = getJSTDate(date);
  return jst.toISOString().split('T')[0];
}

/**
 * 特定日付の CDN (Edge) キャッシュを破棄するヘルパー
 */
async function purgeDailySummaryCache(requestUrl, dateStr) {
  try {
    const cache = caches.default;
    const url = new URL(requestUrl);
    // 🌟 CACHE_VERSION を使って正確なキーで破棄
    const purgeTargetUrl = `${url.origin}/get-daily-summary?date=${dateStr}&${CACHE_VERSION}`;
    await cache.delete(new Request(purgeTargetUrl));
  } catch (err) {
    console.error(`Failed to purge CDN cache for ${dateStr}:`, err);
  }
}

// 指定時間待機するためのヘルパー
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  /**
   * 1. HTTPリクエスト処理 (フロントエンドからのAPI呼び出し)
   */
  async fetch(request, env, ctx) {
    // CORS プリフライトリクエストの処理
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);

      if (!env.DB) {
        throw new Error("D1 データベース接続(env.DB)が確立されていません。wrangler.tomlを確認してください。");
      }

      // --- エンドポイント: 特定の日付のログを再集計して保存する ---
      if (url.pathname === "/reaggregate-date" && request.method === "POST") {
        let { date } = await request.json();
        if (!date) {
          return new Response(JSON.stringify({ success: false, error: "Missing date parameter" }), { status: 400, headers: corsHeaders });
        }
        date = date.replace(/^[?&]?date=/, '').trim();

        if (!env.FIREBASE_SERVICE_ACCOUNT) {
          return new Response(JSON.stringify({
            success: false,
            error: "FIREBASE_SERVICE_ACCOUNT が Worker に存在しません。シークレット設定を確認してください。"
          }), { status: 500, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;

        const result = await aggregateAndSaveDate(date, projectId, token);

        // 🌟 再集計時に CDN キャッシュを確実に消去
        await purgeDailySummaryCache(request.url, date);

        return new Response(JSON.stringify({ success: true, date, logsCount: result.logsCount }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント1: 全ユーザーのステータス一覧を取得 ---
      if (url.pathname === "/get-all-status") {
        const { results } = await env.DB.prepare("SELECT * FROM work_status").all();
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント2: 特定ユーザーのステータスを詳細取得 ---
      if (url.pathname === "/get-user-status" || url.pathname === "/get-my-status" || url.pathname === "/get-status") {
        const userId = url.searchParams.get("userId");
        const result = await env.DB.prepare("SELECT * FROM work_status WHERE userId = ?")
          .bind(userId).first();
        return new Response(JSON.stringify(result || {}), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント3: 予約データの新規作成または更新 ---
      if (url.pathname === "/save-reservation" && request.method === "POST") {
        const data = await request.json();
        await env.DB.prepare(
          "INSERT OR REPLACE INTO reservations (id, userId, userName, action, scheduledTime, status) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(data.id, data.userId, data.userName, data.action, data.scheduledTime, 'reserved').run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- エンドポイント4: ユーザー自身の有効な予約一覧を取得 ---
      if (url.pathname === "/get-user-reservations") {
        const userId = url.searchParams.get("userId");
        const { results } = await env.DB.prepare(
          "SELECT * FROM reservations WHERE userId = ? AND status = 'reserved'"
        ).bind(userId).all();
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント5: 予約の取り消し ---
      if (url.pathname === "/delete-reservation" && request.method === "POST") {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM reservations WHERE id = ?").bind(id).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- エンドポイント6: フロントエンドからの手動ステータス同期 ---
      if ((url.pathname === "/update-status" || url.pathname === "/start-work") && request.method === "POST") {
        const data = await request.json();

        const currentGoal = data.currentGoal || null;
        const currentGoalId = data.currentGoalId || null;
        const wordOfTheDay = data.wordOfTheDay || null;

        const nowIso = getJSTISOString();
        const preBreakTask = data.preBreakTask ? (typeof data.preBreakTask === 'string' ? data.preBreakTask : JSON.stringify(data.preBreakTask)) : null;

        await env.DB.prepare(`
          INSERT INTO work_status (userId, userName, isWorking, currentTask, startTime, preBreakTask, currentGoal, currentGoalId, wordOfTheDay, updatedAt, lastUpdatedBy)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(userId) DO UPDATE SET
            userName=excluded.userName,
            isWorking=excluded.isWorking,
            currentTask=excluded.currentTask,
            startTime=excluded.startTime,
            preBreakTask=excluded.preBreakTask,
            currentGoal=excluded.currentGoal,
            currentGoalId=excluded.currentGoalId,
            wordOfTheDay=excluded.wordOfTheDay, 
            updatedAt=excluded.updatedAt,
            lastUpdatedBy=excluded.lastUpdatedBy
        `).bind(
            data.userId,
            data.userName,
            (data.isWorking === true || data.isWorking === 1 || data.isWorking === 'true' || data.isWorking === '1') ? 1 : 0,
            data.currentTask,
            data.startTime,
            preBreakTask,
            currentGoal,
            currentGoalId,
            wordOfTheDay, 
            nowIso,
            'client'
        ).run();

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- エンドポイント: メッセージ送信 ---
      if (url.pathname === "/send-message" && request.method === "POST") {
        try {
          const reqJson = await request.json();
          const targetUserIds = Array.isArray(reqJson.targetUserId) ? reqJson.targetUserId : [reqJson.targetUserId];
          const { title, messageBody } = reqJson;

          const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
          const accessToken = await getAccessToken(serviceAccount);
          const projectId = serviceAccount.project_id;

          let successCount = 0;

          for (const uid of targetUserIds) {
            const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/user_profiles/${uid}`;
            const fsResp = await fetch(fsUrl, {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (!fsResp.ok) continue;

            const fsData = await fsResp.json();
            const tokens = fsData.fields?.fcmTokens?.arrayValue?.values?.map(v => v.stringValue) || [];

            for (const token of tokens) {
              const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
              const messagePayload = {
                message: {
                  token: token,
                  notification: {
                    title: title || "管理者からのメッセージ",
                    body: messageBody || ""
                  },
                  data: {
                    source: 'worker' 
                  }
                }
              };

              await fetch(fcmUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(messagePayload)
              });
              successCount++;
            }
          }

          return new Response(JSON.stringify({ success: true, sent: successCount }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });

        } catch (e) {
          console.error("Send Message Error:", e);
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }
      
      // --- エンドポイント7: 管理者による強制停止 ---
      if (url.pathname === "/force-stop" && request.method === "POST") {
        const { userId } = await request.json();
        const nowIso = getJSTISOString();
        await env.DB.prepare(`
          UPDATE work_status
          SET isWorking = 0,
              currentTask = NULL,
              startTime = NULL,
              preBreakTask = NULL,
              currentGoal = NULL,
              currentGoalId = NULL,
              updatedAt = ?,
              lastUpdatedBy = 'admin'
          WHERE userId = ?
        `).bind(nowIso, userId).run();
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- 追加エンドポイント: 戸村さんステータスの取得 ---
      if (url.pathname === "/get-tomura-status") {
        const result = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tomura_status'").first();
        return new Response(result ? result.value : JSON.stringify({ status: "声掛けOK", location: "出社" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- 追加エンドポイント: 戸村さんステータスの更新 ---
      if (url.pathname === "/update-tomura-status" && request.method === "POST") {
        const data = await request.json();
        const todayStr = getJSTDateString();
        const value = JSON.stringify({ ...data, date: todayStr });

        await env.DB.prepare(
          "INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES ('tomura_status', ?, ?)"
        ).bind(value, getJSTISOString()).run();

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // --- エンドポイント: 申請の承認処理 (1 Read ピンポイント更新版) ---
      if (url.pathname === "/approve-request" && request.method === "POST") {
        const { requestId, requestData, adminId, adminName } = await request.json();
        if (!requestId || !requestData) {
          return new Response(JSON.stringify({ success: false, error: "Missing requestId or requestData" }), { status: 400, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;
        const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
        const resourceRoot = `projects/${projectId}/databases/(default)/documents`;

        const reqType = requestData.type || "";
        const requestDate = requestData.requestDate || "";
        const userId = requestData.userId || "";
        const userName = requestData.userName || "";
        const targetLogId = requestData.targetLogId || (requestData.data && requestData.data.targetLogId) || null;

        const d = requestData.data || {};
        const dParsed = {
          task: d.task || d.taskName || "",
          goalId: d.goalId || null,
          goalTitle: d.goalTitle || null,
          count: parseInt(d.count || "0", 10),
          beforeCount: parseInt(d.beforeCount || d.oldContribution || "0", 10),
          startTime: d.startTime || "",
          endTime: d.endTime || "",
          afterStartTime: d.afterStartTime || "",
          afterEndTime: d.afterEndTime || "",
          checkoutTime: d.checkoutTime || "",
          memo: d.memo || ""
        };

        const writes = [];
        // 💡 サマリー差分更新用データの追跡配列
        const updatedLogsForSummary = [];
        const deletedLogIdsForSummary = [];

        const buildDateTimeISO = (dateStr, timeStr) => {
          const formattedTime = timeStr.padStart(5, '0');
          return `${dateStr}T${formattedTime}:00+09:00`;
        };

        let goalDiff = 0;
        let goalTaskName = "";
        let goalTargetId = "";

        // 2. 申請タイプに応じた変更命令の組み立て
        if (reqType === "add") {
          const newLogId = "log_" + requestId;
          const targetStartTime = dParsed.afterStartTime || dParsed.startTime;
          const targetEndTime = dParsed.afterEndTime || dParsed.endTime;
          const startISO = buildDateTimeISO(requestDate, targetStartTime);
          const endISO = buildDateTimeISO(requestDate, targetEndTime);
          const duration = Math.max(0, (new Date(endISO).getTime() - new Date(startISO).getTime()) / 1000);

          const logFields = {
            userId: { stringValue: userId },
            userName: { stringValue: userName },
            date: { stringValue: requestDate },
            startTime: { timestampValue: startISO },
            endTime: { timestampValue: endISO },
            duration: { integerValue: String(duration) },
            task: { stringValue: dParsed.task },
            count: { integerValue: String(dParsed.count) },
            contribution: { integerValue: String(dParsed.count) },
            memo: { stringValue: dParsed.memo ? `${dParsed.memo} [追加申請承認済]` : "[追加申請承認済]" },
            type: { stringValue: "work" }
          };
          if (dParsed.goalId) logFields.goalId = { stringValue: dParsed.goalId };
          if (dParsed.goalTitle) logFields.goalTitle = { stringValue: dParsed.goalTitle };

          writes.push({
            update: { name: `${resourceRoot}/work_logs/${newLogId}`, fields: logFields }
          });

          // 💡 サマリー用差分追加
          updatedLogsForSummary.push({
            id: newLogId,
            userId, userName, date: requestDate,
            startTime: startISO, endTime: endISO, duration,
            task: dParsed.task, count: dParsed.count, contribution: dParsed.count,
            memo: dParsed.memo ? `${dParsed.memo} [追加申請承認済]` : "[追加申請承認済]",
            type: "work", goalId: dParsed.goalId || "", goalTitle: dParsed.goalTitle || ""
          });

          if (dParsed.goalId && dParsed.count > 0) {
            goalDiff = dParsed.count; goalTaskName = dParsed.task; goalTargetId = dParsed.goalId;
          }
        }
        else if (reqType === "time_correct" || reqType === "update") {
          if (!targetLogId) throw new Error("対象の元ログIDが見つかりません。");
          const startISO = buildDateTimeISO(requestDate, dParsed.afterStartTime);
          const endISO = buildDateTimeISO(requestDate, dParsed.afterEndTime);
          const duration = Math.max(0, (new Date(endISO).getTime() - new Date(startISO).getTime()) / 1000);

          writes.push({
            update: {
              name: `${resourceRoot}/work_logs/${targetLogId}`,
              fields: {
                task: { stringValue: dParsed.task },
                goalId: dParsed.goalId ? { stringValue: dParsed.goalId } : { nullValue: null },
                goalTitle: dParsed.goalTitle ? { stringValue: dParsed.goalTitle } : { nullValue: null },
                startTime: { timestampValue: startISO },
                endTime: { timestampValue: endISO },
                duration: { integerValue: String(duration) },
                memo: { stringValue: dParsed.memo ? `${dParsed.memo} [時間訂正承認済]` : "[時間訂正承認済]" }
              }
            },
            updateMask: { fieldPaths: ["task", "goalId", "goalTitle", "startTime", "endTime", "duration", "memo"] }
          });

          // 💡 サマリー用差分更新
          updatedLogsForSummary.push({
            id: targetLogId,
            task: dParsed.task, goalId: dParsed.goalId || "", goalTitle: dParsed.goalTitle || "",
            startTime: startISO, endTime: endISO, duration,
            memo: dParsed.memo ? `${dParsed.memo} [時間訂正承認済]` : "[時間訂正承認済]"
          });
        }
        else if (reqType === "count_correct") {
          if (!targetLogId) throw new Error("対象の元ログIDが見つかりません。");

          let diff = 0;
          if (d.beforeCount !== undefined || d.oldContribution !== undefined) {
            diff = dParsed.count - dParsed.beforeCount;
          } else {
            const logRes = await fetch(`${baseUrl}/work_logs/${targetLogId}`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!logRes.ok) throw new Error("修正対象の元ログが見つかりません。");
            const logDoc = await logRes.json();
            const oldLogFields = logDoc.fields;
            const oldContribution = parseInt(oldLogFields.contribution?.integerValue || oldLogFields.count?.integerValue || "0", 10);
            diff = dParsed.count - oldContribution;
          }

          writes.push({
            update: {
              name: `${resourceRoot}/work_logs/${targetLogId}`,
              fields: {
                count: { integerValue: String(dParsed.count) },
                contribution: { integerValue: String(dParsed.count) },
                memo: { stringValue: dParsed.memo ? `${dParsed.memo} [件数修正承認済]` : "[件数修正承認済]" }
              }
            },
            updateMask: { fieldPaths: ["count", "contribution", "memo"] }
          });

          // 💡 サマリー用差分更新
          updatedLogsForSummary.push({
            id: targetLogId,
            count: dParsed.count, contribution: dParsed.count,
            memo: dParsed.memo ? `${dParsed.memo} [件数修正承認済]` : "[件数修正承認済]"
          });

          if (dParsed.goalId && diff !== 0) {
            goalDiff = diff; goalTaskName = dParsed.task; goalTargetId = dParsed.goalId;
          }
        }
        else if (reqType === "forget_checkout") {
          const queryBody = {
            structuredQuery: {
              from: [{ collectionId: "work_logs" }],
              where: {
                compositeFilter: {
                  op: "AND",
                  filters: [
                    { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: userId } } },
                    { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: requestDate } } }
                  ]
                }
              }
            }
          };

          const qRes = await fetch(`${baseUrl}:runQuery`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(queryBody)
          });
          const qResults = await qRes.json();
          const targetCheckoutTime = dParsed.afterEndTime || dParsed.checkoutTime;
          const checkoutTimeISO = buildDateTimeISO(requestDate, targetCheckoutTime);
          const checkoutTimeMs = new Date(checkoutTimeISO).getTime();

          const logsForDay = [];
          for (const item of qResults) {
            if (item.document && item.document.fields) {
              const f = item.document.fields;
              const id = item.document.name.split('/').pop();
              const sTime = f.startTime?.timestampValue || "";
              logsForDay.push({ id, startTimeMs: new Date(sTime).getTime(), fields: f });
            }
          }

          if (logsForDay.length === 0) throw new Error("該当日に勤務ログが存在しません。");
          logsForDay.sort((a, b) => b.startTimeMs - a.startTimeMs);

          const lastLogToUpdate = logsForDay.find(log => log.startTimeMs < checkoutTimeMs);
          if (!lastLogToUpdate) throw new Error("申告退勤時刻より前に開始されたログがありません。");

          const newDuration = Math.max(0, Math.floor((checkoutTimeMs - lastLogToUpdate.startTimeMs) / 1000));

          writes.push({
            update: {
              name: `${resourceRoot}/work_logs/${lastLogToUpdate.id}`,
              fields: {
                endTime: { timestampValue: checkoutTimeISO },
                duration: { integerValue: String(newDuration) },
                memo: { stringValue: dParsed.memo ? `${dParsed.memo} [退勤忘れ修正承認済]` : "[退勤忘れ修正承認済]" }
              }
            },
            updateMask: { fieldPaths: ["endTime", "duration", "memo"] }
          });

          // 💡 サマリー用差分更新
          updatedLogsForSummary.push({
            id: lastLogToUpdate.id,
            endTime: checkoutTimeISO, duration: newDuration,
            memo: dParsed.memo ? `${dParsed.memo} [退勤忘れ修正承認済]` : "[退勤忘れ修正承認済]"
          });

          for (const log of logsForDay) {
            if (log.startTimeMs > lastLogToUpdate.startTimeMs) {
              writes.push({ delete: `${resourceRoot}/work_logs/${log.id}` });
              deletedLogIdsForSummary.push(log.id); // 💡 サマリー用削除ID追跡
            }
          }

          writes.push({
            update: {
              name: `${resourceRoot}/work_status/${userId}`,
              fields: { needsCheckoutCorrection: { booleanValue: false } }
            },
            updateMask: { fieldPaths: ["needsCheckoutCorrection"] }
          });
        }

        // 3. 工数進捗マスター(settings/tasks)の同期
        if (goalDiff !== 0 && goalTaskName && goalTargetId) {
          const tasksRes = await fetch(`${baseUrl}/settings/tasks`, { headers: { 'Authorization': `Bearer ${token}` } });
          if (tasksRes.ok) {
            const tasksDoc = await tasksRes.json();
            const listValues = tasksDoc.fields?.list?.arrayValue?.values || [];

            for (const taskVal of listValues) {
              const tFields = taskVal.mapValue?.fields || {};
              if (tFields.name?.stringValue === goalTaskName) {
                const goalsList = tFields.goals?.arrayValue?.values || [];
                for (const goalVal of goalsList) {
                  const gFields = goalVal.mapValue?.fields || {};
                  if (gFields.id?.stringValue === goalTargetId || gFields.title?.stringValue === goalTargetId) {
                    const currentVal = parseInt(gFields.current?.integerValue || "0", 10);
                    gFields.current = { integerValue: String(Math.max(0, currentVal + goalDiff)) };
                  }
                }
              }
            }
            writes.push({
              update: { name: `${resourceRoot}/settings/tasks`, fields: { list: { arrayValue: { values: listValues } } } }
            });
          }
        }

        // 4. 申請自身のステータスを "approved" に変更
        writes.push({
          update: {
            name: `${resourceRoot}/work_log_requests/${requestId}`,
            fields: {
              status: { stringValue: "approved" },
              approverId: { stringValue: adminId },
              approverName: { stringValue: adminName },
              approvedAt: { stringValue: getJSTISOString() }
            }
          },
          updateMask: { fieldPaths: ["status", "approverId", "approverName", "approvedAt"] }
        });

        // 5. コミット送信 (Write 実行)
        const commitRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes })
        });
        if (!commitRes.ok) throw new Error(`一括コミットに失敗しました: ${await commitRes.text()}`);

        // 6. 💡 【Read 1 化】 過去日の場合、1 Read でピンポイント更新し CDN キャッシュを消去
        const todayStr = getJSTDateString();
        if (requestDate < todayStr) {
          await updateDailySummaryInPlace(requestDate, updatedLogsForSummary, deletedLogIdsForSummary, projectId, token);
          await purgeDailySummaryCache(request.url, requestDate);
        }

        return new Response(JSON.stringify({ success: true, message: "Successfully approved." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント: 申請の却下処理 ---
      if (url.pathname === "/reject-request" && request.method === "POST") {
        const { requestId, adminId, adminName, rejectReason } = await request.json();
        if (!requestId) {
          return new Response(JSON.stringify({ success: false, error: "Missing requestId" }), { status: 400, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;

        const body = {
          fields: {
            status: { stringValue: "rejected" },
            approverId: { stringValue: adminId },
            approverName: { stringValue: adminName },
            approvedAt: { stringValue: getJSTISOString() },
            rejectReason: { stringValue: rejectReason || "" }
          }
        };

        const res = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/work_log_requests/${requestId}?updateMask.fieldPaths=status&updateMask.fieldPaths=approverId&updateMask.fieldPaths=approverName&updateMask.fieldPaths=approvedAt&updateMask.fieldPaths=rejectReason`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error(`却下処理に失敗しました: ${await res.text()}`);

        return new Response(JSON.stringify({ success: true, message: "Request rejected successfully" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- エンドポイント: daily_summary の取得 (🌟 CDN キャッシュ統合版) ---
      if (url.pathname === "/get-daily-summary") {
        let date = url.searchParams.get("date");
        if (!date) {
          return new Response(JSON.stringify({ success: false, error: "Missing date parameter" }), { 
            status: 400, 
            headers: corsHeaders 
          });
        }
        date = date.replace(/^[?&]?date=/, '').trim();

        // 🌟 キャッシュキーの URL に統一バージョンパラメータ (CACHE_VERSION) を付与
        const cleanUrl = `${url.origin}/get-daily-summary?date=${date}&${CACHE_VERSION}`;
        const cacheKey = new Request(cleanUrl);
        const cache = caches.default;
        
        let response = await cache.match(cacheKey);
        if (response) {
          return response; // ⚡ 正しいキャッシュがあればそれを即時返却
        }

        // 2. Firestore から取得
        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;

        const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/daily_summaries/${date}`;
        let fsResp = await fetch(fsUrl, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        let fsData = fsResp.ok ? await fsResp.json() : null;
        let logsJsonStr = fsData?.fields?.logsJson?.stringValue || "[]";
        let logs = [];
        try {
          logs = JSON.parse(logsJsonStr);
        } catch (e) {
          logs = [];
        }

        // 🌟 404だけでなく、過去日なのにログが0件保存されている場合も work_logs から自動再集計
        if (fsResp.status === 404 || !Array.isArray(logs) || logs.length === 0) {
          try {
             const aggResult = await aggregateAndSaveDate(date, projectId, token);
            if (aggResult.logsCount > 0) {
              fsResp = await fetch(fsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
              if (fsResp.ok) {
                fsData = await fsResp.json();
                logsJsonStr = fsData.fields?.logsJson?.stringValue || "[]";
                logs = JSON.parse(logsJsonStr);
              }
            }
          } catch (autoErr) {
            console.error(`Auto aggregation failed for ${date}:`, autoErr);
          }
        }

        // ログが存在する場合のみ1年間CDNキャッシュに保持。空(0件)の場合はキャッシュさせない
        const hasLogs = Array.isArray(logs) && logs.length > 0;
        const cacheHeader = hasLogs 
          ? "public, max-age=0, s-maxage=31536000, must-revalidate"
          : "no-cache, no-store, must-revalidate";

        const jsonResponse = new Response(JSON.stringify({ success: true, date, logs }), {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": cacheHeader,
          }
        });

        // ログが存在するときのみ CDN エッジに保存
        if (hasLogs) {
          ctx.waitUntil(cache.put(cacheKey, jsonResponse.clone()));
        }

        return jsonResponse;
      }

      // --- エンドポイント: 画像プロキシ & CDN エッジキャッシュ ---
      if (url.pathname === "/proxy-image") {
        let targetUrl = url.searchParams.get("url");
        if (!targetUrl) {
          return new Response("Missing url parameter", { status: 400, headers: corsHeaders });
        }

        targetUrl = targetUrl.replace(/&amp;/g, '&');

        const cacheKey = new Request(request.url, request);
        const cache = caches.default;
        let response = await cache.match(cacheKey);

        if (response) {
          return response;
        }

        try {
          const imgResp = await fetch(targetUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            }
          });

          if (!imgResp.ok) {
            return new Response(`Failed to fetch image: ${imgResp.status}`, { status: imgResp.status, headers: corsHeaders });
          }

          const contentType = imgResp.headers.get("Content-Type") || "image/jpeg";

          response = new Response(imgResp.body, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=31536000, s-maxage=31536000",
            }
          });

          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;

        } catch (e) {
          return new Response(`Image proxy error: ${e.message}`, { status: 500, headers: corsHeaders });
        }
      }

      // --- 1. ブラウザからの画像アップロード & CDN 永久保存 ---
      if (url.pathname === "/upload-image" && request.method === "POST") {
        try {
          const contentType = request.headers.get("Content-Type") || "image/png";
          const imageBuffer = await request.arrayBuffer();

          if (!imageBuffer || imageBuffer.byteLength === 0) {
            return new Response(JSON.stringify({ success: false, error: "Empty image data" }), { 
              status: 400, 
              headers: corsHeaders 
            });
          }

          const ext = contentType.split("/")[1] || "png";
          const imageId = `img_${crypto.randomUUID()}.${ext}`;
          const cdnUrl = `${url.origin}/cdn-image/${imageId}`;

          const cacheKey = new Request(cdnUrl);
          const cache = caches.default;

          const imageResponse = new Response(imageBuffer, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=31536000, s-maxage=31536000",
            }
          });

          ctx.waitUntil(cache.put(cacheKey, imageResponse.clone()));

          return new Response(JSON.stringify({ success: true, cdnUrl, imageId }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });

        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { 
            status: 500, 
            headers: corsHeaders 
          });
        }
      }

      // --- 追加エンドポイント: 一括承認処理 (Read/Write 最小化版) ---
      if (url.pathname === "/bulk-approve-requests" && request.method === "POST") {
        const { requests, adminId, adminName } = await request.json();
        if (!Array.isArray(requests) || requests.length === 0) {
          return new Response(JSON.stringify({ success: false, error: "No requests provided" }), { status: 400, headers: corsHeaders });
        }

        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;
        const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
        const resourceRoot = `projects/${projectId}/databases/(default)/documents`;

        const writes = [];
        const summaryMap = {}; // 日付ごとの差分更新用
        const goalDiffMap = {}; // 目標進捗の一括計算用

        const buildDateTimeISO = (dateStr, timeStr) => {
          const formattedTime = timeStr.padStart(5, '0');
          return `${dateStr}T${formattedTime}:00+09:00`;
        };

        for (const item of requests) {
          const { requestId, requestData } = item;
          const reqType = requestData.type || "";
          const requestDate = requestData.requestDate || "";
          const userId = requestData.userId || "";
          const userName = requestData.userName || "";
          const targetLogId = requestData.targetLogId || requestData.data?.targetLogId || null;

          if (!summaryMap[requestDate]) {
            summaryMap[requestDate] = { updatedLogs: [], deletedIds: [] };
          }

          const d = requestData.data || {};
          const dParsed = {
            task: d.task || d.taskName || "",
            goalId: d.goalId || null,
            goalTitle: d.goalTitle || null,
            count: parseInt(d.count || "0", 10),
            beforeCount: parseInt(d.beforeCount || d.oldContribution || "0", 10),
            startTime: d.startTime || "",
            endTime: d.endTime || "",
            afterStartTime: d.afterStartTime || "",
            afterEndTime: d.afterEndTime || "",
            checkoutTime: d.checkoutTime || "",
            memo: d.memo || ""
          };

          // 1. 新規追加申請
          if (reqType === "add") {
            const newLogId = "log_" + requestId;
            const targetStartTime = dParsed.afterStartTime || dParsed.startTime;
            const targetEndTime = dParsed.afterEndTime || dParsed.endTime;
            const startISO = buildDateTimeISO(requestDate, targetStartTime);
            const endISO = buildDateTimeISO(requestDate, targetEndTime);
            const duration = Math.max(0, (new Date(endISO).getTime() - new Date(startISO).getTime()) / 1000);

            const logFields = {
              userId: { stringValue: userId },
              userName: { stringValue: userName },
              date: { stringValue: requestDate },
              startTime: { timestampValue: startISO },
              endTime: { timestampValue: endISO },
              duration: { integerValue: String(duration) },
              task: { stringValue: dParsed.task },
              count: { integerValue: String(dParsed.count) },
              contribution: { integerValue: String(dParsed.count) },
              memo: { stringValue: dParsed.memo ? `${dParsed.memo} [追加申請承認済]` : "[追加申請承認済]" },
              type: { stringValue: "work" }
            };
            if (dParsed.goalId) logFields.goalId = { stringValue: dParsed.goalId };
            if (dParsed.goalTitle) logFields.goalTitle = { stringValue: dParsed.goalTitle };

            writes.push({ update: { name: `${resourceRoot}/work_logs/${newLogId}`, fields: logFields } });
            summaryMap[requestDate].updatedLogs.push({
              id: newLogId, userId, userName, date: requestDate, startTime: startISO, endTime: endISO,
              duration, task: dParsed.task, count: dParsed.count, contribution: dParsed.count,
              memo: logFields.memo.stringValue, type: "work", goalId: dParsed.goalId || "", goalTitle: dParsed.goalTitle || ""
            });

            if (dParsed.goalId && dParsed.count > 0) {
              const key = `${dParsed.task}_${dParsed.goalId}`;
              goalDiffMap[key] = (goalDiffMap[key] || 0) + dParsed.count;
            }
          } 
          // 2. 時間訂正・更新申請
          else if (reqType === "time_correct" || reqType === "update") {
            if (!targetLogId) continue;
            const startISO = buildDateTimeISO(requestDate, dParsed.afterStartTime);
            const endISO = buildDateTimeISO(requestDate, dParsed.afterEndTime);
            const duration = Math.max(0, (new Date(endISO).getTime() - new Date(startISO).getTime()) / 1000);

            writes.push({
              update: {
                name: `${resourceRoot}/work_logs/${targetLogId}`,
                fields: {
                  task: { stringValue: dParsed.task },
                  goalId: dParsed.goalId ? { stringValue: dParsed.goalId } : { nullValue: null },
                  goalTitle: dParsed.goalTitle ? { stringValue: dParsed.goalTitle } : { nullValue: null },
                  startTime: { timestampValue: startISO },
                  endTime: { timestampValue: endISO },
                  duration: { integerValue: String(duration) },
                  memo: { stringValue: dParsed.memo ? `${dParsed.memo} [時間訂正承認済]` : "[時間訂正承認済]" }
                }
              },
              updateMask: { fieldPaths: ["task", "goalId", "goalTitle", "startTime", "endTime", "duration", "memo"] }
            });

            summaryMap[requestDate].updatedLogs.push({
              id: targetLogId, task: dParsed.task, goalId: dParsed.goalId || "", goalTitle: dParsed.goalTitle || "",
              startTime: startISO, endTime: endISO, duration, memo: dParsed.memo ? `${dParsed.memo} [時間訂正承認済]` : "[時間訂正承認済]"
            });
          }
          // 3. 件数修正申請
          else if (reqType === "count_correct") {
            if (!targetLogId) continue;
            const diff = dParsed.count - dParsed.beforeCount;

            writes.push({
              update: {
                name: `${resourceRoot}/work_logs/${targetLogId}`,
                fields: {
                  count: { integerValue: String(dParsed.count) },
                  contribution: { integerValue: String(dParsed.count) },
                  memo: { stringValue: dParsed.memo ? `${dParsed.memo} [件数修正承認済]` : "[件数修正承認済]" }
                }
              },
              updateMask: { fieldPaths: ["count", "contribution", "memo"] }
            });

            summaryMap[requestDate].updatedLogs.push({
              id: targetLogId, count: dParsed.count, contribution: dParsed.count,
              memo: dParsed.memo ? `${dParsed.memo} [件数修正承認済]` : "[件数修正承認済]"
            });

            if (dParsed.goalId && diff !== 0) {
              const key = `${dParsed.task}_${dParsed.goalId}`;
              goalDiffMap[key] = (goalDiffMap[key] || 0) + diff;
            }
          }
          // 4. 🌟 退勤忘れ補正申請 (修正適用部分)
          else if (reqType === "forget_checkout") {
            const targetCheckoutTime = dParsed.afterEndTime || dParsed.checkoutTime;
            const checkoutTimeISO = buildDateTimeISO(requestDate, targetCheckoutTime);
            const checkoutTimeMs = new Date(checkoutTimeISO).getTime();

            let actualTargetLogId = targetLogId;
            let startISO = null;

            // 💡 targetLogId が null の場合、該当日の勤務ログを取得して対象ログを特定する
            if (!actualTargetLogId) {
              const queryBody = {
                structuredQuery: {
                  from: [{ collectionId: "work_logs" }],
                  where: {
                    compositeFilter: {
                      op: "AND",
                      filters: [
                        { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: userId } } },
                        { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: requestDate } } }
                      ]
                    }
                  }
                }
              };

              const qRes = await fetch(`${baseUrl}:runQuery`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(queryBody)
              });
              const qResults = await qRes.json();

              const logsForDay = [];
              for (const item of qResults) {
                if (item.document && item.document.fields) {
                  const f = item.document.fields;
                  const id = item.document.name.split('/').pop();
                  const sTime = f.startTime?.timestampValue || "";
                  logsForDay.push({ id, startTimeMs: new Date(sTime).getTime(), startTimeISO: sTime });
                }
              }

              if (logsForDay.length > 0) {
                logsForDay.sort((a, b) => b.startTimeMs - a.startTimeMs);
                const targetLog = logsForDay.find(log => log.startTimeMs < checkoutTimeMs);
                if (targetLog) {
                  actualTargetLogId = targetLog.id;
                  startISO = targetLog.startTimeISO;
                }
              }
            }

            if (!actualTargetLogId) continue;

            let durationVal = 0;
            if (startISO) {
              durationVal = Math.max(0, Math.floor((checkoutTimeMs - new Date(startISO).getTime()) / 1000));
            }

            const updateFields = {
              endTime: { timestampValue: checkoutTimeISO },
              memo: { stringValue: dParsed.memo ? `${dParsed.memo} [退勤忘れ修正承認済]` : "[退勤忘れ修正承認済]" }
            };
            const fieldPaths = ["endTime", "memo"];

            if (durationVal > 0) {
              updateFields.duration = { integerValue: String(durationVal) };
              fieldPaths.push("duration");
            }

            writes.push({
              update: {
                name: `${resourceRoot}/work_logs/${actualTargetLogId}`,
                fields: updateFields
              },
              updateMask: { fieldPaths }
            });

            writes.push({
              update: {
                name: `${resourceRoot}/work_status/${userId}`,
                fields: { needsCheckoutCorrection: { booleanValue: false } }
              },
              updateMask: { fieldPaths: ["needsCheckoutCorrection"] }
            });

            summaryMap[requestDate].updatedLogs.push({
              id: actualTargetLogId,
              endTime: checkoutTimeISO,
              ...(durationVal > 0 ? { duration: durationVal } : {}),
              memo: dParsed.memo ? `${dParsed.memo} [退勤忘れ修正承認済]` : "[退勤忘れ修正承認済]"
            });
          }

          // 申請ステータスを approved に更新
          writes.push({
            update: {
              name: `${resourceRoot}/work_log_requests/${requestId}`,
              fields: {
                status: { stringValue: "approved" },
                approverId: { stringValue: adminId },
                approverName: { stringValue: adminName },
                approvedAt: { stringValue: getJSTISOString() }
              }
            },
            updateMask: { fieldPaths: ["status", "approverId", "approverName", "approvedAt"] }
          });
        }

        // 工数目標マスター(settings/tasks)の一括同期
        if (Object.keys(goalDiffMap).length > 0) {
          const tasksRes = await fetch(`${baseUrl}/settings/tasks`, { headers: { 'Authorization': `Bearer ${token}` } });
          if (tasksRes.ok) {
            const tasksDoc = await tasksRes.json();
            const listValues = tasksDoc.fields?.list?.arrayValue?.values || [];

            for (const [key, diffVal] of Object.entries(goalDiffMap)) {
              const [taskName, goalTargetId] = key.split('_');
              for (const taskVal of listValues) {
                const tFields = taskVal.mapValue?.fields || {};
                if (tFields.name?.stringValue === taskName) {
                  const goalsList = tFields.goals?.arrayValue?.values || [];
                  for (const goalVal of goalsList) {
                    const gFields = goalVal.mapValue?.fields || {};
                    if (gFields.id?.stringValue === goalTargetId || gFields.title?.stringValue === goalTargetId) {
                      const currentVal = parseInt(gFields.current?.integerValue || "0", 10);
                      gFields.current = { integerValue: String(Math.max(0, currentVal + diffVal)) };
                    }
                  }
                }
              }
            }
            writes.push({
              update: { name: `${resourceRoot}/settings/tasks`, fields: { list: { arrayValue: { values: listValues } } } }
            });
          }
        }

        // Firestore 一括コミット送信 (1 Write リクエスト)
        const commitRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes })
        });

        if (!commitRes.ok) throw new Error(`一括コミットに失敗しました: ${await commitRes.text()}`);

        // サマリー更新 & CDNキャッシュ破棄 (日付ごとに1回だけ実行)
        const todayStr = getJSTDateString();
        for (const [dateStr, sData] of Object.entries(summaryMap)) {
          if (dateStr < todayStr) {
            await updateDailySummaryInPlace(dateStr, sData.updatedLogs, sData.deletedIds, projectId, token);
            await purgeDailySummaryCache(request.url, dateStr);
          }
        }

        return new Response(JSON.stringify({ success: true, count: requests.length }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // --- 2. CDN に保存された画像の配信 ---
      if (url.pathname.startsWith("/cdn-image/")) {
        const cacheKey = new Request(request.url);
        const cache = caches.default;
        const response = await cache.match(cacheKey);

        if (response) {
          return response;
        }

        return new Response("Image not found or cache expired", { status: 404, headers: corsHeaders });
      }

      // --- 404 Not Found ---
      return new Response("End Point Not Found", { status: 404, headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  },

  /**
   * 2. 定期実行 (Cronによる予約の自動処理)
   */
  async scheduled(event, env, ctx) {
    const now = new Date();

    // --- 夜間バッチ処理のチェック (日本時間 00:05 に実行) ---
    const jstTime = getJSTDate(now);
    const hh = String(jstTime.getUTCHours()).padStart(2, '0');
    const mm = String(jstTime.getUTCMinutes()).padStart(2, '0');

    if (hh === "00" && mm === "05") {
      try {
        const yesterday = new Date(jstTime.getTime() - 24 * 60 * 60 * 1000);
        const yyyy = yesterday.getUTCFullYear();
        const m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
        const d = String(yesterday.getUTCDate()).padStart(2, '0');
        const yesterdayStr = `${yyyy}-${m}-${d}`;

        console.log(`Starting nightly batch for date: ${yesterdayStr}`);
        
        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
        const token = await getAccessToken(serviceAccount);
        const projectId = serviceAccount.project_id;

        await aggregateAndSaveDate(yesterdayStr, projectId, token);
        await purgeDailySummaryCache(event.request?.url || "https://muddy-night-4bd4.sora-yamashita.workers.dev/get-daily-summary", yesterdayStr);
        console.log(`Successfully completed nightly batch for ${yesterdayStr}`);
      } catch (batchErr) {
        console.error("Nightly Batch Error:", batchErr.message);
      }
    }
    
    // 1分後までの予約を検索対象とする
    const lookAheadIso = new Date(now.getTime() + 60 * 1000).toISOString();

    try {
      const { results: pendingReservations } = await env.DB.prepare(
        "SELECT * FROM reservations WHERE status = 'reserved' AND scheduledTime <= ?"
      ).bind(lookAheadIso).all();

      if (pendingReservations.length === 0) return;

      const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
      const token = await getAccessToken(serviceAccount);
      const projectId = serviceAccount.project_id;

      for (const res of pendingReservations) {
        const currentStatus = await env.DB.prepare("SELECT * FROM work_status WHERE userId = ?")
          .bind(res.userId).first();

        const scheduledTimeMs = new Date(res.scheduledTime).getTime();
        const nowMs = new Date().getTime();
        const diffMinutes = (nowMs - scheduledTimeMs) / (1000 * 60);

        const getNextDayIso = (origScheduledTime) => {
          const origDate = new Date(origScheduledTime);
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
          console.log(`Reservation ${res.id} is ${diffMinutes} minutes old. Skipping past reservation.`);
          await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
            .bind(getNextDayIso(res.scheduledTime), res.id).run();
          continue; 
        }

        const isCurrentlyWorking = currentStatus && (
          currentStatus.isWorking === 1 || 
          currentStatus.isWorking === true ||
          currentStatus.isWorking === '1' ||
          currentStatus.isWorking === 'true'
        );

        if (res.action === "break" && !isCurrentlyWorking) {
          await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
            .bind(getNextDayIso(res.scheduledTime), res.id).run();
          continue; 
        }

        await env.DB.prepare("UPDATE reservations SET scheduledTime = ? WHERE id = ?")
          .bind(getNextDayIso(res.scheduledTime), res.id).run();
      }
    } catch (e) {
      console.error("Critical Worker Error:", e.message);
    }
  }
};

/**
 * 認証: Google OAuth2 アクセストークンの取得
 */
async function getAccessToken(serviceAccount) {
  const pem = serviceAccount.private_key.replace(/\\n/g, '\n');
  const clientEmail = serviceAccount.client_email;
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = btoaUrl(JSON.stringify(header));
  const encodedClaim = btoaUrl(JSON.stringify(claim));
  const binaryKey = str2ab(pem);

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaim}`)
  );

  const jwt = `${encodedHeader}.${encodedClaim}.${btoaUrl(String.fromCharCode(...new Uint8Array(signature)))}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const data = await tokenResp.json();

  if (!tokenResp.ok) {
    throw new Error(`Failed to obtain Google OAuth access token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

function btoaUrl(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function str2ab(pem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.substring(pem.indexOf(pemHeader) + pemHeader.length, pem.indexOf(pemFooter)).replace(/\s/g, '');
  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * 特定の日付のwork_logsを取得・集計し、daily_summariesにJSON文字列で保存する関数
 */
async function aggregateAndSaveDate(dateStr, projectId, token) {
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: "work_logs" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "date" },
          op: "EQUAL",
          value: { stringValue: dateStr }
        }
      }
    }
  };

  const fsQueryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const response = await fetch(fsQueryUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody)
  });

  if (!response.ok) {
    throw new Error(`Firestore query failed: ${await response.text()}`);
  }

  const queryResults = await response.json();
  const parsedLogs = [];

  for (const item of queryResults) {
    if (item.document && item.document.fields) {
      const fields = item.document.fields;
      const docId = item.document.name.split('/').pop();

      const countVal = parseInt(fields.count?.integerValue || fields.contribution?.integerValue || "0", 10);
      const contributionVal = parseInt(fields.contribution?.integerValue || fields.count?.integerValue || "0", 10);

      parsedLogs.push({
        id: docId,
        userId: fields.userId?.stringValue || "",
        userName: fields.userName?.stringValue || "",
        task: fields.task?.stringValue || "",
        startTime: fields.startTime?.timestampValue || "",
        endTime: fields.endTime?.timestampValue || "",
        duration: parseInt(fields.duration?.integerValue || "0", 10),
        count: countVal,
        contribution: contributionVal,
        date: fields.date?.stringValue || "",
        memo: fields.memo?.stringValue || "",
        goalId: fields.goalId?.stringValue || "",
        goalTitle: fields.goalTitle?.stringValue || "",
        goalDeadline: fields.goalDeadline?.stringValue || "",
        type: fields.type?.stringValue || ""
      });
    }
  }

  const saveBody = {
    fields: {
      date: { stringValue: dateStr },
      logsJson: { stringValue: JSON.stringify(parsedLogs) },
      updatedAt: { timestampValue: getJSTISOString() }
    }
  };

  const fsSaveUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/daily_summaries/${dateStr}`;
  const saveResponse = await fetch(fsSaveUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(saveBody)
  });

  if (!saveResponse.ok) {
    throw new Error(`Failed to save summary to Firestore: ${await saveResponse.text()}`);
  }
  return { logsCount: parsedLogs.length };
}

/**
 * 💡 ピンポイント更新用ヘルパー (Read数: たった1回)
 * 全件検索を行わず、daily_summaries/{dateStr} の1件だけを取得してメモリ上で差分更新・削除を行う
 */
async function updateDailySummaryInPlace(dateStr, updatedLogsList, deletedLogIds = [], projectId, token) {
  const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/daily_summaries/${dateStr}`;
  
  // 1. daily_summaries 1件だけを直接取得 (1 Read)
  const res = await fetch(fsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    // ドキュメントが存在しない(404)場合は、次回アクセス時に自動再集計されるため何もしなくてOK
    return;
  }

  const doc = await res.json();
  let logs = [];
  try {
    logs = JSON.parse(doc.fields?.logsJson?.stringValue || "[]");
  } catch (e) {
    logs = [];
  }

  // 2. 退勤忘れ等で削除されたログを除外
  if (deletedLogIds.length > 0) {
    const deleteSet = new Set(deletedLogIds);
    logs = logs.filter(l => !deleteSet.has(l.id));
  }

  // 3. 承認された差分ログを反映（既存ログは上書き更新、新規ログは追加）
  for (const updatedLog of updatedLogsList) {
    const idx = logs.findIndex(l => l.id === updatedLog.id);
    if (idx !== -1) {
      logs[idx] = { ...logs[idx], ...updatedLog };
    } else {
      logs.push(updatedLog);
    }
  }

  // 4. daily_summaries を上書き保存 (1 Write)
  const saveBody = {
    fields: {
      date: { stringValue: dateStr },
      logsJson: { stringValue: JSON.stringify(logs) },
      updatedAt: { timestampValue: getJSTISOString() }
    }
  };

  await fetch(fsUrl, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(saveBody)
  });
}
