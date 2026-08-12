import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultScheduleTrigger,
  scheduleFormFromTrigger,
  scheduleTriggerFromForm,
  scheduleWeekdaysFromCronField,
} from "./workflowSchedule.ts";

test("new schedules default to daily at 09:00 UTC", () => {
  assert.deepEqual(defaultScheduleTrigger(), {
    on: "schedule",
    cron: "0 9 * * *",
  });
});

test("recognizes common interval schedules", () => {
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "15m" }).frequency,
    "every_15_minutes",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "30m" }).frequency,
    "every_30_minutes",
  );
  assert.equal(
    scheduleFormFromTrigger({ on: "schedule", interval: "1h" }).frequency,
    "hourly",
  );
});

test("round-trips the structured cron schedules", () => {
  for (const cron of [
    "30 14 * * *",
    "30 14 * * 1-5",
    "30 14 * * 1,3,5",
    "30 14 * * 4",
    "30 14 23 * *",
  ]) {
    const form = scheduleFormFromTrigger({ on: "schedule", cron });
    assert.deepEqual(scheduleTriggerFromForm(form), { on: "schedule", cron });
  }
});

test("expands numeric weekday lists and ranges for the weekly picker", () => {
  assert.deepEqual(scheduleWeekdaysFromCronField("1-5"), [
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
  assert.deepEqual(scheduleWeekdaysFromCronField("1,3,5"), ["1", "3", "5"]);
  assert.deepEqual(scheduleWeekdaysFromCronField("MON-FRI"), []);
});

test("preserves advanced cron expressions in the custom field", () => {
  const cron = "0 */2 * * 1,3,5";
  const form = scheduleFormFromTrigger({ on: "schedule", cron });

  assert.equal(form.frequency, "custom_cron");
  assert.equal(form.customCron, cron);
  assert.deepEqual(scheduleTriggerFromForm(form), { on: "schedule", cron });
});

test("preserves legacy non-preset intervals", () => {
  const form = scheduleFormFromTrigger({ on: "schedule", interval: "2h" });

  assert.equal(form.frequency, "custom_interval");
  assert.equal(form.customInterval, "2h");
  assert.deepEqual(scheduleTriggerFromForm(form), {
    on: "schedule",
    interval: "2h",
  });
});

test("switching schedule modes never emits cron and interval together", () => {
  const form = scheduleFormFromTrigger({ on: "schedule", interval: "30m" });
  const custom = scheduleTriggerFromForm({
    ...form,
    customCron: "0 8 * * 6",
    frequency: "custom_cron",
  });

  assert.deepEqual(custom, { on: "schedule", cron: "0 8 * * 6" });
  assert.equal("interval" in custom, false);
});
