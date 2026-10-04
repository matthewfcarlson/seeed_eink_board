import { describe, expect, it } from "vitest";
import type { DeviceAlert } from "../../src/lib/device-health";
import {
  alertSubject,
  buildAlertEmail,
  buildVerificationEmail,
  normalizeEmail,
  publicBaseUrl,
  randomToken,
  sendEmail,
} from "../../src/lib/email-alerts";
import type { Env } from "../../src/types";

const NOW = 1_800_000_000;
const offline: DeviceAlert = { kind: "offline", mac: "aabbccddeeff", label: "Kitchen", lastSeenAt: NOW - 30 * 3600, batteryVoltage: 3.41 };

describe("normalizeEmail", () => {
  it("trims and lowercases a plausible address", () => {
    expect(normalizeEmail("  Me@Example.COM ")).toBe("me@example.com");
  });

  it("rejects non-addresses and header-injection attempts", () => {
    for (const bad of ["", "me", "me@localhost", "a b@example.com", "me@example.com\r\nBcc: x@y.z", "<me@example.com>", "a,b@example.com", 42]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail("a".repeat(250) + "@x.io")).toBeNull();
  });
});

describe("alertSubject", () => {
  it("names the first alert and counts the rest", () => {
    expect(alertSubject([offline])).toBe("E-Ink frame: Kitchen is offline");
    expect(alertSubject([offline, { ...offline, kind: "low_battery" }])).toBe("E-Ink frame: Kitchen is offline (+1 more)");
  });

  it("strips control characters from labels", () => {
    expect(alertSubject([{ ...offline, label: "Evil\r\nBcc: x@y.z" }])).toBe("E-Ink frame: Evil Bcc: x@y.z is offline");
  });
});

describe("buildAlertEmail", () => {
  it("includes alert text, an escaped html body, and one-click unsubscribe headers", () => {
    const mail = buildAlertEmail([{ ...offline, label: "<b>Kitchen</b>" }], NOW, "https://eink.example.com", "tok123");
    expect(mail.text).toContain("hasn't checked in for 30 hours");
    expect(mail.text).toContain("https://eink.example.com/notifications/email/unsubscribe?token=tok123");
    expect(mail.html).toContain("&lt;b&gt;Kitchen&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Kitchen</b>");
    expect(mail.headers).toEqual({
      "List-Unsubscribe": "<https://eink.example.com/notifications/email/unsubscribe?token=tok123>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("omits List-Unsubscribe for a non-https base (local dev)", () => {
    expect(buildAlertEmail([offline], NOW, "http://localhost:8787", "t").headers).toEqual({});
  });

  it("labels test emails", () => {
    const mail = buildAlertEmail([offline], NOW, "https://x.io", "t", { test: true });
    expect(mail.subject).toBe("E-Ink frame: test alert");
    expect(mail.text.startsWith("This is a test alert.")).toBe(true);
  });
});

describe("buildVerificationEmail", () => {
  it("links to the confirm page with the token", () => {
    expect(buildVerificationEmail("https://x.io", "abc").text).toContain("https://x.io/notifications/email/verify?token=abc");
  });
});

describe("helpers", () => {
  it("makes url-safe, unique tokens", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("prefers PUBLIC_BASE_URL, falling back to the request origin", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://a.io/" } as Env, "https://b.io/x")).toBe("https://a.io");
    expect(publicBaseUrl({} as Env, "https://b.io/x?y")).toBe("https://b.io");
    expect(publicBaseUrl({} as Env)).toBeNull();
  });

  it("sendEmail reports a binding error instead of throwing", async () => {
    const env = {
      EMAIL_FROM: "alerts@x.io",
      EMAIL: {
        send: async () => {
          throw Object.assign(new Error("not verified"), { code: "E_SENDER_NOT_VERIFIED" });
        },
      },
    } as unknown as Env;
    const mail = buildVerificationEmail("https://x.io", "t");
    expect(await sendEmail(env, "me@example.com", mail)).toBe("E_SENDER_NOT_VERIFIED: not verified");
    expect(await sendEmail({} as Env, "me@example.com", mail)).toMatch(/isn't configured/);
  });
});
