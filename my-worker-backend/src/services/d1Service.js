export class D1Service {
  constructor(db) {
    this.db = db;
  }

  async getAllWorkStatus() {
    const { results } = await this.db.prepare("SELECT * FROM work_status").all();
    return results;
  }

  async getUserWorkStatus(userId) {
    return await this.db.prepare("SELECT * FROM work_status WHERE userId = ?")
      .bind(userId)
      .first();
  }

  async upsertWorkStatus(data, nowIso) {
    const isWorking = (data.isWorking === true || data.isWorking === 1 || data.isWorking === 'true' || data.isWorking === '1') ? 1 : 0;
    const preBreakTask = data.preBreakTask ? (typeof data.preBreakTask === 'string' ? data.preBreakTask : JSON.stringify(data.preBreakTask)) : null;

    return await this.db.prepare(`
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
      isWorking,
      data.currentTask,
      data.startTime,
      preBreakTask,
      data.currentGoal || null,
      data.currentGoalId || null,
      data.wordOfTheDay || null,
      nowIso,
      'client'
    ).run();
  }

  async forceStopUser(userId, nowIso) {
    return await this.db.prepare(`
      UPDATE work_status
      SET isWorking = 0, currentTask = NULL, startTime = NULL, preBreakTask = NULL, currentGoal = NULL, currentGoalId = NULL, updatedAt = ?, lastUpdatedBy = 'admin'
      WHERE userId = ?
    `).bind(nowIso, userId).run();
  }

  async upsertReservation(data) {
    return await this.db.prepare(
      "INSERT OR REPLACE INTO reservations (id, userId, userName, action, scheduledTime, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(data.id, data.userId, data.userName, data.action, data.scheduledTime, 'reserved').run();
  }

  async getUserReservations(userId) {
    const { results } = await this.db.prepare(
      "SELECT * FROM reservations WHERE userId = ? AND status = 'reserved'"
    ).bind(userId).all();
    return results;
  }

  async deleteReservation(id) {
    return await this.db.prepare("DELETE FROM reservations WHERE id = ?").bind(id).run();
  }

  async getSetting(key) {
    return await this.db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  }

  async upsertSetting(key, value, updatedAt) {
    return await this.db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)"
    ).bind(key, value, updatedAt).run();
  }
}
