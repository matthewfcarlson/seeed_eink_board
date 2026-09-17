import { describe, expect, it } from "vitest";
import { computeAuthorizedPrincipals } from "../../src/lib/bucket-keys";

describe("computeAuthorizedPrincipals", () => {
  it("includes the owner plus every collaborator and device", () => {
    const principals = computeAuthorizedPrincipals("owner-1", ["collab-a", "collab-b"], ["aabbccddeeff"]);
    expect(principals).toEqual([
      { type: "user", id: "owner-1" },
      { type: "user", id: "collab-a" },
      { type: "user", id: "collab-b" },
      { type: "device", id: "aabbccddeeff" },
    ]);
  });

  it("de-duplicates a stale self-share row for the owner", () => {
    const principals = computeAuthorizedPrincipals("owner-1", ["owner-1", "collab-a"], []);
    expect(principals).toEqual([
      { type: "user", id: "owner-1" },
      { type: "user", id: "collab-a" },
    ]);
  });

  it("omits a collaborator or device once removed from the live tables", () => {
    // Simulates finalize recomputing the set fresh rather than reusing
    // whatever was live at rotate/start — a share/device removed mid-rotation
    // must not appear here even if it was passed to rotate/start earlier.
    const atStart = computeAuthorizedPrincipals("owner-1", ["collab-a", "collab-b"], ["mac-1", "mac-2"]);
    const atFinalize = computeAuthorizedPrincipals("owner-1", ["collab-a"], ["mac-1"]);
    expect(atStart).toHaveLength(5);
    expect(atFinalize).toEqual([
      { type: "user", id: "owner-1" },
      { type: "user", id: "collab-a" },
      { type: "device", id: "mac-1" },
    ]);
  });

  it("includes a share or device added mid-rotation", () => {
    const atStart = computeAuthorizedPrincipals("owner-1", [], []);
    const atFinalize = computeAuthorizedPrincipals("owner-1", ["new-collab"], ["new-mac"]);
    expect(atStart).toEqual([{ type: "user", id: "owner-1" }]);
    expect(atFinalize).toEqual([
      { type: "user", id: "owner-1" },
      { type: "user", id: "new-collab" },
      { type: "device", id: "new-mac" },
    ]);
  });

  it("returns just an empty list when there is no owner and no collaborators/devices", () => {
    expect(computeAuthorizedPrincipals(null, [], [])).toEqual([]);
  });
});
