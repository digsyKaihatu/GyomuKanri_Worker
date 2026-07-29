export function getJSTDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000);
}

export function getJSTISOString(date = new Date()) {
  const jst = getJSTDate(date);
  return jst.toISOString().replace('Z', '+09:00');
}

export function getJSTDateString(date = new Date()) {
  const jst = getJSTDate(date);
  return jst.toISOString().split('T')[0];
}

export function buildJSTDateTimeISO(dateStr, timeStr) {
  const formattedTime = timeStr.padStart(5, '0');
  return `${dateStr}T${formattedTime}:00+09:00`;
}
