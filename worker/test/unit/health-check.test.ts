import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_AFTER_SECONDS, planDeviceAlerts } from "../../src/lib/device-health";
import {
  MAX_DEVICES_PER_RUN,
  runDeviceHealthCheck,
  selectAlertCandidates,
  toHealthInput,
} from "../../src/lib/health-check";
import type { Env } from "../../src/types";

/**
 * Runs the real health check against the real schema: every migration in
 * src/db/migrations applied to an in-memory SQLite (node:sqlite), behind a
 * minimal D1-shaped adapter. This is what keeps the candidate query's SQL
 * honest against planDeviceAlerts, and shows the run stays bounded at fleet
 * scale.
 */

const MIGRATIONS_DIR = join(__dirname, "../../src/db/migrations");
const H = 3600;
const DAY = 86400;
const NOW = 1_800_000_000;

type Param = string | number | null;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param));

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  let d1Calls = 0;
  const statement = (sql: string, args: Param[] = []) => ({
    sql,
    args,
    bind: (...bound: unknown[]) => statement(sql, bound.map(norm)),
    async all() {
      d1Calls++;
      return { results: db.prepare(sql).all(...args) };
    },
    async first() {
      d1Calls++;
      return db.prepare(sql).get(...args) ?? null;
    },
    async run() {
      d1Calls++;
      return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
    },
  });
  const DB = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: ReturnType<typeof statement>[]) {
      d1Calls++;
      db.exec("BEGIN");
      for (const s of stmts) db.prepare(s.sql).run(...s.args);
      db.exec("COMMIT");
      return [];
    },
  };
  // No KV binding at all: the check must not need it.
  const env = { DB } as unknown as Env;
  return { env, db, d1Calls: () => d1Calls };
}

interface SeedDevice {
  mac: string;
  user: string;
  lastSeen: number;
  volts?: number | null;
  offlineAlertedAt?: number | null;
  lowAlertedAt?: number | null;
  nextReminderAt?: number | null;
  muted?: boolean;
}

function seed(db: DatabaseSync, devices: SeedDevice[], webhookOwners: string[] = []) {
  db.exec("BEGIN");
  const users = new Set(devices.map((d) => d.user));
  const insUser = db.prepare("INSERT INTO users (id, created_at) VALUES (?, 0)");
  for (const u of users) insUser.run(u);
  const insDev = db.prepare(
    `INSERT INTO devices (mac, user_id, label, created_at, last_seen_at, last_battery_voltage, secret,
                          offline_alerted_at, low_battery_alerted_at, next_reminder_at, alerts_muted)
     VALUES (?, ?, ?, 0, ?, ?, 'secret', ?, ?, ?, ?)`
  );
  for (const d of devices) {
    insDev.run(d.mac, d.user, "Frame " + d.mac, d.lastSeen, d.volts ?? 3.9, d.offlineAlertedAt ?? null,
      d.lowAlertedAt ?? null, d.nextReminderAt ?? null, d.muted ? 1 : 0);
  }
  const insHook = db.prepare(
    "INSERT INTO notification_webhooks (id, user_id, url, format, signing_secret, created_at) VALUES (?, ?, ?, 'json', 'aa', 0)"
  );
  for (const u of webhookOwners) insHook.run("hook-" + u, u, "https://hooks.example/" + u);
  db.exec("COMMIT");
}

const mac = (i: number) => i.toString(16).padStart(12, "0");

/** 6,000 frames, 4 per owner, every owner with a webhook; all healthy and
 *  seen within the last hour unless `override` says otherwise. */
function fleet(override: (i: number) => Partial<SeedDevice> = () => ({})): { devices: SeedDevice[]; owners: string[] } {
  const devices: SeedDevice[] = [];
  for (let i = 0; i < 6000; i++) {
    devices.push({ mac: mac(i), user: "u" + Math.floor(i / 4), lastSeen: NOW - (i % 60) * 60, ...override(i) });
  }
  return { devices, owners: [...new Set(devices.map((d) => d.user))] };
}

let fetchCalls: Request[];
beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    fetchCalls.push(req);
    return new Response("ok");
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selectAlertCandidates", () => {
  // Deterministic pseudo-random fleet covering every state combination.
  function randomDevices(n: number): SeedDevice[] {
    let x = 12345;
    const rand = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    return Array.from({ length: n }, (_, i) => {
      const lastSeen = NOW - Math.floor(rand() * 60 * DAY);
      return {
        mac: mac(i),
        user: "u" + (i % 50),
        lastSeen: pick([lastSeen, NOW - OFFLINE_AFTER_SECONDS, NOW - OFFLINE_AFTER_SECONDS - 1, NOW - 2 * OFFLINE_AFTER_SECONDS]),
        volts: pick([null, 0, 3.3, 3.49, 3.5, 3.6, 3.69, 3.7, 4.25]),
        offlineAlertedAt: pick([null, null, NOW - 10 * DAY]),
        lowAlertedAt: pick([null, null, NOW - DAY]),
        nextReminderAt: pick([null, NOW - H, NOW, NOW + DAY]),
        muted: rand() < 0.1,
      };
    });
  }

  for (const suppress of [null, NOW - 2 * OFFLINE_AFTER_SECONDS]) {
    it(`returns exactly the devices planDeviceAlerts would alert on (suppression ${suppress ? "on" : "off"})`, async () => {
      const { env, db } = makeEnv();
      const devices = randomDevices(3000);
      seed(db, devices);
      const rows = await selectAlertCandidates(env, NOW, { suppressNewOfflineSince: suppress, limit: 100_000 });
      const expected = devices
        .filter((d) => !d.muted)
        .filter((d) => {
          const input = toHealthInput({
            mac: d.mac, user_id: d.user, label: null, last_seen_at: d.lastSeen,
            last_battery_voltage: d.volts ?? null, offline_alerted_at: d.offlineAlertedAt ?? null,
            low_battery_alerted_at: d.lowAlertedAt ?? null, next_reminder_at: d.nextReminderAt ?? null,
          });
          return planDeviceAlerts(input, NOW, { suppressNewOfflineSince: suppress }).alerts.length > 0;
        })
        .map((d) => d.mac)
        .sort();
      expect(expected.length).toBeGreaterThan(100);
      expect(rows.map((r) => r.mac).sort()).toEqual(expected);
    });
  }
});

describe("runDeviceHealthCheck at 6,000 frames", () => {
  it("handles a normal day (3% offline) in a fixed handful of D1 calls, then goes quiet", async () => {
    const { env, db, d1Calls } = makeEnv();
    const { devices, owners } = fleet((i) => (i % 33 === 0 ? { lastSeen: NOW - 26 * H } : {}));
    seed(db, devices, owners);
    const offline = devices.filter((d) => d.lastSeen < NOW - OFFLINE_AFTER_SECONDS);

    const first = await runDeviceHealthCheck(env, NOW);
    expect(first).toMatchObject({ outage: false, capped: false, alerts: offline.length, failed: 0 });
    expect(fetchCalls.length).toBe(new Set(offline.map((d) => d.user)).size);
    // outage aggregate + candidates + state batch + webhooks + results batch
    expect(d1Calls()).toBe(5);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM notification_webhooks WHERE last_status = 200").get()
    ).toEqual({ n: fetchCalls.length });

    fetchCalls = [];
    const second = await runDeviceHealthCheck(env, NOW + H);
    expect(second.candidates).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  it("costs nothing per abandoned frame: 3,000 long-dead frames with reminders pending select zero rows", async () => {
    const { env, db } = makeEnv();
    const { devices, owners } = fleet((i) =>
      i % 2 === 0 ? { lastSeen: NOW - 90 * DAY, offlineAlertedAt: NOW - 89 * DAY, nextReminderAt: NOW + 10 * DAY } : {}
    );
    seed(db, devices, owners);
    const summary = await runDeviceHealthCheck(env, NOW);
    expect(summary.candidates).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  it("holds alerts when a third of the fleet goes silent together, then drains them at the cap once it's clearly real", async () => {
    const { env, db } = makeEnv();
    const { devices, owners } = fleet((i) => (i % 3 === 0 ? { lastSeen: NOW - 25 * H } : {}));
    seed(db, devices, owners);

    const held = await runDeviceHealthCheck(env, NOW);
    expect(held.outage).toBe(true);
    expect(held.alerts).toBe(0);
    expect(fetchCalls).toEqual([]);

    // A day later the rest of the fleet is still checking in but these 2,000
    // never came back: no longer a fresh spike, so they alert — 200 per run.
    const later = NOW + DAY;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE last_seen_at >= ?").run(later - 600, NOW - 2 * H);
    let alerted = 0;
    let runs = 0;
    for (; runs < 20; runs++) {
      const s = await runDeviceHealthCheck(env, later + runs * H);
      expect(s.outage).toBe(false);
      expect(s.candidates).toBeLessThanOrEqual(MAX_DEVICES_PER_RUN);
      alerted += s.alerts;
      if (!s.capped) break;
    }
    expect(alerted).toBe(2000);
    expect(runs).toBe(10);
  });

  it("sends nothing if the silent frames come back before the hold lifts", async () => {
    const { env, db } = makeEnv();
    const { devices, owners } = fleet((i) => (i % 3 === 0 ? { lastSeen: NOW - 25 * H } : {}));
    seed(db, devices, owners);
    expect((await runDeviceHealthCheck(env, NOW)).outage).toBe(true);
    db.prepare("UPDATE devices SET last_seen_at = ?").run(NOW + 2 * H);
    const after = await runDeviceHealthCheck(env, NOW + 3 * H);
    expect(after).toMatchObject({ outage: false, candidates: 0 });
    expect(fetchCalls).toEqual([]);
  });

  it("sends a weekly reminder from next_reminder_at and clears it on recovery", async () => {
    const { env, db } = makeEnv();
    seed(db, [{ mac: mac(1), user: "u1", lastSeen: NOW - 2 * DAY }], ["u1"]);
    await runDeviceHealthCheck(env, NOW);
    const after = () => db.prepare("SELECT offline_alerted_at, next_reminder_at FROM devices").get();
    expect(after()).toEqual({ offline_alerted_at: NOW, next_reminder_at: NOW + 7 * DAY });

    expect((await runDeviceHealthCheck(env, NOW + 6 * DAY)).alerts).toBe(0);
    const reminder = await runDeviceHealthCheck(env, NOW + 7 * DAY);
    expect(reminder.alerts).toBe(1);
    expect(JSON.parse(await fetchCalls.at(-1)!.text()).alerts[0].kind).toBe("still_offline");

    db.prepare("UPDATE devices SET last_seen_at = ?").run(NOW + 8 * DAY);
    await runDeviceHealthCheck(env, NOW + 8 * DAY + 60);
    expect(after()).toEqual({ offline_alerted_at: null, next_reminder_at: null });
  });
});
