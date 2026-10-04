import { Hono } from "hono";
import type { Env } from "./types";
import { registerDeviceConfigRoute } from "./routes/device-config";
import { registerHashRoute } from "./routes/hash";
import { registerImagePackedRoute } from "./routes/image-packed";
import { registerCurrentRoute } from "./routes/current";
import { registerFirmwareBinRoute } from "./routes/firmware-bin";
import { registerCrashReportRoute } from "./routes/crash-report";
import { registerAdminDeviceRoutes } from "./routes/admin/devices";
import { registerAdminBucketRoutes } from "./routes/admin/buckets";
import { registerAdminImageRoutes } from "./routes/admin/images";
import { registerAdminScheduleRoutes } from "./routes/admin/schedule";
import { registerAdminAuthRoutes } from "./routes/admin/auth";
import { registerAdminSessionRoutes } from "./routes/admin/sessions";
import { registerAdminFirmwareRoutes, syncLatestFirmwareRelease } from "./routes/admin/firmware";
import { registerAdminCrashReportRoutes } from "./routes/admin/crash-reports";
import { registerAdminNotificationRoutes } from "./routes/admin/notifications";
import { registerEmailLinkRoutes } from "./routes/email-links";
import { runDeviceHealthCheck } from "./lib/health-check";
import { registerAuthPasskeyRoutes } from "./routes/auth-passkey";
import { renderAdminPage } from "./admin-ui";
import { renderLandingPage } from "./landing-ui";
import { renderProvisionPage } from "./provision-ui";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(renderLandingPage()));

// Static shell for the admin single-page app — no secrets server-side, the API
// key lives in the browser's localStorage and is sent per-request to /admin/*.
app.get("/admin", (c) => c.html(renderAdminPage()));

// Static Web Bluetooth pairing page — talks directly to the board over BLE,
// nothing device-specific happens on this worker. See ble_provisioning.h.
app.get("/provision", (c) => c.html(renderProvisionPage()));

// Device-facing — contract-critical, must match firmware/src/main.cpp exactly.
registerDeviceConfigRoute(app);
registerHashRoute(app);
registerImagePackedRoute(app);
registerCurrentRoute(app);
registerFirmwareBinRoute(app);
registerCrashReportRoute(app);

// Admin-facing — require Authorization: Bearer <session token> (one per passkey
// ceremony; see migrations/0023_user_sessions.sql).
registerAdminDeviceRoutes(app);
registerAdminBucketRoutes(app);
registerAdminImageRoutes(app);
registerAdminScheduleRoutes(app);
registerAdminAuthRoutes(app);
registerAdminSessionRoutes(app);
registerAdminFirmwareRoutes(app);
registerAdminCrashReportRoutes(app);
registerAdminNotificationRoutes(app);

// Public — passkey registration/login. The only way to create an account.
registerAuthPasskeyRoutes(app);
// Public — confirm/unsubscribe pages linked from alert emails (token-authenticated).
registerEmailLinkRoutes(app);

// The cron fires hourly (wrangler.toml); firmware sync only needs every 6h.
const FIRMWARE_SYNC_EVERY_HOURS = 6;

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Auto-catalogs new GitHub releases (D1 + KV) so "Cloudflare picks them up" without
    // a manual click — but never rolls anything out on its own. Actual device rollout
    // always requires an explicit /admin/firmware/target write. See routes/admin/firmware.ts.
    if (new Date(event.scheduledTime).getUTCHours() % FIRMWARE_SYNC_EVERY_HOURS === 0) {
      ctx.waitUntil(
        syncLatestFirmwareRelease(env).catch((err) => {
          console.error("Scheduled firmware sync failed:", err);
        })
      );
    }
    // Offline / low-battery alerts to owners' webhooks — see lib/health-check.ts.
    ctx.waitUntil(
      runDeviceHealthCheck(env).catch((err) => {
        console.error("Scheduled device health check failed:", err);
      })
    );
  },
};
