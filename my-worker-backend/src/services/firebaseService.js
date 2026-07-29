import { getJSTISOString } from '../utils/dateHelper.js';

export async function sendFcmMessage(projectId, token, targetUserIds, title, messageBody) {
  let successCount = 0;

  for (const uid of targetUserIds) {
    const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/user_profiles/${uid}`;
    const fsResp = await fetch(fsUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!fsResp.ok) continue;

    const fsData = await fsResp.json();
    const tokens = fsData.fields?.fcmTokens?.arrayValue?.values?.map(v => v.stringValue) || [];

    for (const fcmToken of tokens) {
      const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
      const messagePayload = {
        message: {
          token: fcmToken,
          notification: { title: title || "管理者からのメッセージ", body: messageBody || "" },
          data: { source: 'worker' }
        }
      };

      await fetch(fcmUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(messagePayload)
      });
      successCount++;
    }
  }

  return successCount;
}

export async function aggregateAndSaveDate(dateStr, projectId, token) {
  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: "work_logs" }],
      where: {
        fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: dateStr } }
      }
    }
  };

  const fsQueryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const response = await fetch(fsQueryUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody)
  });

  if (!response.ok) throw new Error(`Firestore query failed: ${await response.text()}`);

  const queryResults = await response.json();
  const parsedLogs = [];

  for (const item of queryResults) {
    if (item.document && item.document.fields) {
      const fields = item.document.fields;
      const docId = item.document.name.split('/').pop();

      parsedLogs.push({
        id: docId,
        userId: fields.userId?.stringValue || "",
        userName: fields.userName?.stringValue || "",
        task: fields.task?.stringValue || "",
        startTime: fields.startTime?.timestampValue || "",
        endTime: fields.endTime?.timestampValue || "",
        duration: parseInt(fields.duration?.integerValue || "0", 10),
        count: parseInt(fields.count?.integerValue || fields.contribution?.integerValue || "0", 10),
        contribution: parseInt(fields.contribution?.integerValue || fields.count?.integerValue || "0", 10),
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

  if (!saveResponse.ok) throw new Error(`Failed to save summary to Firestore: ${await saveResponse.text()}`);
  return { logsCount: parsedLogs.length };
}
