import { CronExpressionParser } from "cron-parser";
import { DateTime, IANAZone } from "luxon";
import type { Schedule } from "./contracts";

export class InvalidAutomationScheduleError extends Error {
  readonly code = "AUTOMATION_SCHEDULE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAutomationScheduleError";
  }
}

function assertTimezone(timezone: string): void {
  if (!IANAZone.isValidZone(timezone)) {
    throw new InvalidAutomationScheduleError(
      `Timezone '${timezone}' is not a valid IANA timezone.`,
    );
  }
}

export function validateSchedule(schedule: Schedule): void {
  assertTimezone(schedule.timezone);
  if (schedule.kind === "cron") {
    try {
      CronExpressionParser.parse(schedule.expression, {
        currentDate: new Date(),
        tz: schedule.timezone,
      }).next();
    } catch (error) {
      throw new InvalidAutomationScheduleError(
        `Invalid Cron expression: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return;
  }
  const anchor = DateTime.fromISO(schedule.anchorAt, { setZone: true });
  if (!anchor.isValid) {
    throw new InvalidAutomationScheduleError("anchorAt must be a valid instant.");
  }
  if (schedule.frequency === "daily" && !schedule.timeOfDay) {
    throw new InvalidAutomationScheduleError(
      "A daily interval schedule requires timeOfDay.",
    );
  }
}

export function nextScheduleOccurrence(
  schedule: Schedule,
  after: Date,
): Date {
  validateSchedule(schedule);
  if (schedule.kind === "cron") {
    return CronExpressionParser.parse(schedule.expression, {
      currentDate: after,
      tz: schedule.timezone,
    })
      .next()
      .toDate();
  }

  const zone = schedule.timezone;
  const afterLocal = DateTime.fromJSDate(after, { zone });
  const anchor = DateTime.fromISO(schedule.anchorAt, { setZone: true }).setZone(
    zone,
  );

  if (schedule.frequency === "hourly") {
    const elapsedHours = Math.max(
      0,
      Math.floor(afterLocal.diff(anchor, "hours").hours),
    );
    let steps = Math.floor(elapsedHours / schedule.every) + 1;
    let candidate = anchor.plus({ hours: steps * schedule.every });
    while (candidate.toMillis() <= after.getTime()) {
      steps += 1;
      candidate = anchor.plus({ hours: steps * schedule.every });
    }
    return candidate.toJSDate();
  }

  const time = schedule.timeOfDay!;
  const anchorDay = anchor.startOf("day");
  const afterDay = afterLocal.startOf("day");
  const elapsedDays = Math.max(
    0,
    Math.floor(afterDay.diff(anchorDay, "days").days),
  );
  let steps = Math.floor(elapsedDays / schedule.every);
  let candidate = anchorDay
    .plus({ days: steps * schedule.every })
    .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  if (candidate.toMillis() <= after.getTime()) {
    candidate = candidate
      .plus({ days: schedule.every })
      .set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  }
  return candidate.toJSDate();
}

export function describeSchedule(schedule: Schedule): string {
  validateSchedule(schedule);
  if (schedule.kind === "cron") {
    return `Cron ${schedule.expression} (${schedule.timezone})`;
  }
  if (schedule.frequency === "hourly") {
    return `Every ${schedule.every} ${
      schedule.every === 1 ? "hour" : "hours"
    } (${schedule.timezone})`;
  }
  const { hour, minute } = schedule.timeOfDay!;
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}`;
  return `Every ${schedule.every} ${
    schedule.every === 1 ? "day" : "days"
  } at ${clock} (${schedule.timezone})`;
}
