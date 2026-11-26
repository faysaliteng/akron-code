/** Calendar schedules used alongside the existing minute interval. */

export function nextRun(schedule, fromMs = Date.now()) {
  if (!schedule?.enabled) return null;
  const repeat = schedule.repeatType || "interval";
  if (repeat === "interval") return null;
  const from = new Date(fromMs);
  const [hour, minute] = String(schedule.specificTime || "09:00").split(":").map((part) => Number(part) || 0);
  if (repeat === "once") {
    if (!schedule.specificDate) return null;
    const [year, month, day] = schedule.specificDate.split("-").map((part) => Number(part));
    const when = new Date(year, (month || 1) - 1, day || 1, hour, minute, 0, 0);
    return when.getTime() > fromMs ? when.getTime() : null;
  }
  for (let offset = 0; offset < 370; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hour, minute, 0, 0);
    if (candidate.getTime() <= fromMs) continue;
    if (repeat === "daily") return candidate.getTime();
    if (repeat === "weekly" && candidate.getDay() === Number(schedule.dayOfWeek ?? 1)) return candidate.getTime();
    if (repeat === "monthly" && candidate.getDate() === Number(schedule.dayOfMonth || 1)) return candidate.getTime();
    if (repeat === "annually") {
      const [month, day] = String(schedule.monthAndDay || "01-01").split("-").map((part) => Number(part));
      if (candidate.getMonth() === month - 1 && candidate.getDate() === day) return candidate.getTime();
    }
  }
  return null;
}

export function describeSchedule(schedule) {
  const repeat = schedule?.repeatType || "interval";
  if (repeat === "interval") {
    const mins = Number(schedule?.everyMinutes) || 60;
    return `every ${mins}m`;
  }
  const time = schedule.specificTime || "09:00";
  if (repeat === "once") return `once ${schedule.specificDate || ""} ${time}`.trim();
  if (repeat === "daily") return `daily at ${time}`;
  if (repeat === "weekly") {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${names[Number(schedule.dayOfWeek) || 0]} at ${time}`;
  }
  if (repeat === "monthly") return `day ${schedule.dayOfMonth || 1} at ${time}`;
  if (repeat === "annually") return `${schedule.monthAndDay || "01-01"} at ${time}`;
  return repeat;
}
