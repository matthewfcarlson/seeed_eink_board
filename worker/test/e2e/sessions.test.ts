import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminClient } from "./lib/admin-client";
import { loginTestSession, registerTestAccount } from "./lib/virtual-authenticator";
import { startWranglerDev, type WranglerDevHandle } from "./lib/wrangler-dev";

/**
 * End-to-end coverage of per-login sessions (migrations/0023_user_sessions.sql
 * + routes/admin/sessions.ts), against a real disposable `wrangler dev`. This
 * is the regression test for the behavior the whole feature exists for: a
 * second login (previously a fresh api_key over users.api_key_hash) used to
 * invalidate the first session's token; now both must stay valid.
 */
describe("e2e: admin sessions", () => {
  let wrangler: WranglerDevHandle;

  beforeAll(async () => {
    wrangler = await startWranglerDev({ port: 8796 });
  }, 60_000);

  afterAll(async () => {
    await wrangler?.stop();
  });

  it("a second login does not invalidate the first session", async () => {
    const { apiKey: firstToken, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const firstClient = new AdminClient(wrangler.baseUrl, firstToken);
    expect((await firstClient.getMe()).id).toBeTruthy();

    // Second ceremony with the same passkey — a second browser, effectively.
    const secondToken = await loginTestSession(wrangler.baseUrl, credentialId);
    expect(secondToken).not.toEqual(firstToken);

    // The old session must still authenticate.
    expect((await new AdminClient(wrangler.baseUrl, firstToken).getMe()).id).toBeTruthy();
    expect((await new AdminClient(wrangler.baseUrl, secondToken).getMe()).id).toBeTruthy();
  });

  it("GET /admin/sessions lists all active sessions and marks the current one", async () => {
    const { apiKey: firstToken, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const secondToken = await loginTestSession(wrangler.baseUrl, credentialId);

    const firstClient = new AdminClient(wrangler.baseUrl, firstToken);
    const listing = await firstClient.getSessions();
    expect(listing.sessions).toHaveLength(2);
    expect(listing.current_session_id).toBeTruthy();
    const current = listing.sessions.find((s) => s.id === listing.current_session_id);
    expect(current?.is_current).toBe(true);
    expect(listing.sessions.filter((s) => s.is_current)).toHaveLength(1);
    // Same user, so both sessions resolve to the same account id.
    const secondMe = await new AdminClient(wrangler.baseUrl, secondToken).getMe();
    expect((await firstClient.getMe()).id).toEqual(secondMe.id);
  });

  it("DELETE /admin/sessions/:id revokes one session, scoped to the caller's account", async () => {
    const { apiKey: firstToken, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const secondToken = await loginTestSession(wrangler.baseUrl, credentialId);

    const firstClient = new AdminClient(wrangler.baseUrl, firstToken);
    const listing = await firstClient.getSessions();
    const other = listing.sessions.find((s) => !s.is_current);
    expect(other).toBeTruthy();

    await firstClient.revokeSession(other!.id);

    // Revoked session is dead...
    const dead = await fetch(`${wrangler.baseUrl}/admin/me`, {
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    expect(dead.status).toBe(401);
    // ...the caller's own session is untouched...
    expect((await firstClient.getMe()).id).toBeTruthy();
    // ...and it no longer appears in the listing.
    const after = await firstClient.getSessions();
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]!.id).toEqual(listing.current_session_id);
  });

  it("revoke-others keeps the calling session and kills the rest", async () => {
    const { apiKey: firstToken, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const secondToken = await loginTestSession(wrangler.baseUrl, credentialId);
    const thirdToken = await loginTestSession(wrangler.baseUrl, credentialId);

    const thirdClient = new AdminClient(wrangler.baseUrl, thirdToken);
    const result = await thirdClient.revokeOthers();
    expect(result.revoked).toBe(2);

    expect(
      (await fetch(`${wrangler.baseUrl}/admin/me`, { headers: { Authorization: `Bearer ${firstToken}` } })).status
    ).toBe(401);
    expect(
      (await fetch(`${wrangler.baseUrl}/admin/me`, { headers: { Authorization: `Bearer ${secondToken}` } })).status
    ).toBe(401);
    expect((await thirdClient.getMe()).id).toBeTruthy();
  });

  it("logout (DELETE /admin/sessions/current) revokes the calling session server-side", async () => {
    const { apiKey: token, credentialId } = await registerTestAccount(wrangler.baseUrl);
    const client = new AdminClient(wrangler.baseUrl, token);
    expect((await client.getMe()).id).toBeTruthy();

    await client.logout();

    const dead = await fetch(`${wrangler.baseUrl}/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dead.status).toBe(401);
  });
});
