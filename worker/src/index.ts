import { Hono } from "hono";
import type { Env } from "./types";
import { registerDeviceConfigRoute } from "./routes/device-config";
import { registerHashRoute } from "./routes/hash";
import { registerImagePackedRoute } from "./routes/image-packed";
import { registerCurrentRoute } from "./routes/current";
import { registerAdminDeviceRoutes } from "./routes/admin/devices";
import { registerAdminImageRoutes } from "./routes/admin/images";
import { registerAdminScheduleRoutes } from "./routes/admin/schedule";
import { registerAdminAuthRoutes } from "./routes/admin/auth";
import { registerAuthPasskeyRoutes } from "./routes/auth-passkey";
import { renderAdminPage } from "./admin-ui";
import { renderLandingPage } from "./landing-ui";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.html(renderLandingPage()));

// Static shell for the admin single-page app — no secrets server-side, the API
// key lives in the browser's localStorage and is sent per-request to /admin/*.
app.get("/admin", (c) => c.html(renderAdminPage()));

// Device-facing — contract-critical, must match firmware/src/main.cpp exactly.
registerDeviceConfigRoute(app);
registerHashRoute(app);
registerImagePackedRoute(app);
registerCurrentRoute(app);

// Admin-facing — require Authorization: Bearer <api_key>.
registerAdminDeviceRoutes(app);
registerAdminImageRoutes(app);
registerAdminScheduleRoutes(app);
registerAdminAuthRoutes(app);

// Public — passkey registration/login. The only way to create an account.
registerAuthPasskeyRoutes(app);

export default app;
