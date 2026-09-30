import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DeviceAlert } from "../../src/lib/device-health";
import {
  buildWebhookRequest,
  describeAlert,
  generateSigningSecret,
  maskWebhookUrl,
  validateWebhookUrl,
} from "../../src/lib/notify";

const NOW = 1_800_000_000;
const offline: DeviceAlert = {
  kind: "offline",
  mac: "aabbccddeeff",
  label: "Kitchen",
  lastSeenAt: NOW - 5 * 3600,
  batteryVoltage: 3.41,
};

describe("validateWebhookUrl", () => {
  it("accepts https URLs", () => {
    expect(validateWebhookUrl(" https://ntfy.sh/my-topic ")).toBe("https://ntfy.sh/my-topic");
  });

  it("rejects http, embedded credentials, junk, and overlong URLs", () => {
    expect(validateWebhookUrl("http://example.com/hook")).toBeNull();
    expect(validateWebhookUrl("https://user:pass@example.com/hook")).toBeNull();
    expect(validateWebhookUrl("not a url")).toBeNull();
    expect(validateWebhookUrl(42)).toBeNull();
    expect(validateWebhookUrl("https://example.com/" + "a".repeat(3000))).toBeNull();
  });
});

describe("maskWebhookUrl", () => {
  it("hides the token-bearing path", () => {
    const masked = maskWebhookUrl("https://discord.com/api/webhooks/123/SECRETTOKENabcd");
    expect(masked).toBe("https://discord.com…abcd");
    expect(masked).not.toContain("SECRET");
  });
});

describe("describeAlert", () => {
  it("hints at a dead battery when an offline device was nearly empty", () => {
    expect(describeAlert(offline, NOW)).toBe(
      "⚠️ Kitchen hasn't checked in for 5 hours. Last battery reading was 3.41V, so it has probably run out of charge."
    );
  });

  it("points at WiFi/power when the battery was fine", () => {
    expect(describeAlert({ ...offline, batteryVoltage: 3.95 }, NOW)).toContain("check its WiFi or power");
  });

  it("falls back to the MAC when there's no label", () => {
    expect(describeAlert({ ...offline, kind: "back_online", label: null }, NOW)).toBe(
      "✅ aabbccddeeff is checking in again."
    );
  });
});

describe("buildWebhookRequest", () => {
  const secret = generateSigningSecret();

  it("signs the json format so receivers can verify it", async () => {
    const req = await buildWebhookRequest({ url: "https://example.com/h", format: "json", signing_secret: secret }, [offline], NOW);
    const body = await req.text();
    const ts = req.headers.get("X-Eink-Timestamp")!;
    const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(ts + "." + body).digest("hex");
    expect(req.headers.get("X-Eink-Signature")).toBe("sha256=" + expected);
    const parsed = JSON.parse(body);
    expect(parsed.type).toBe("device_alerts");
    expect(parsed.alerts[0]).toEqual({
      kind: "offline",
      device: { mac: "aabbccddeeff", label: "Kitchen" },
      last_seen_at: offline.lastSeenAt,
      battery_voltage: 3.41,
    });
  });

  it("escapes Slack control sequences in labels", async () => {
    const req = await buildWebhookRequest(
      { url: "https://hooks.slack.com/x", format: "slack", signing_secret: secret },
      [{ ...offline, label: "<!channel>" }],
      NOW
    );
    expect(JSON.parse(await req.text()).text).toContain("&lt;!channel&gt;");
  });

  it("disables Discord mentions", async () => {
    const req = await buildWebhookRequest(
      { url: "https://discord.com/api/webhooks/1/x", format: "discord", signing_secret: secret },
      [{ ...offline, label: "@everyone" }],
      NOW
    );
    const body = JSON.parse(await req.text());
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toContain("@everyone");
  });

  it("sends ntfy a plain-text body with ASCII headers", async () => {
    const req = await buildWebhookRequest({ url: "https://ntfy.sh/t", format: "ntfy", signing_secret: secret }, [offline], NOW);
    expect(await req.text()).toContain("Kitchen hasn't checked in");
    expect(req.headers.get("Priority")).toBe("high");
    expect(req.headers.get("Tags")).toBe("warning");
    expect(req.headers.get("Title")).toMatch(/^[\x20-\x7e]+$/);
  });
});
