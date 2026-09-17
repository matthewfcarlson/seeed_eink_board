import { describe, expect, it } from "vitest";
import { FIRMWARE_ASSET_NAMES, resolveBoardAsset, type GitHubRelease } from "../../src/lib/github-release";

function release(assets: GitHubRelease["assets"], tagName = "v1.2.3"): GitHubRelease {
  return { tag_name: tagName, assets };
}

describe("resolveBoardAsset", () => {
  it("finds a known board's asset by its exact name and strips the leading 'v' from the tag", () => {
    const rel = release([
      { name: "firmware-ee02-13in3.bin", browser_download_url: "https://example/ee02.bin", size: 123 },
    ]);
    expect(resolveBoardAsset(rel, "ee02-13in3")).toEqual({
      version: "1.2.3",
      tag: "v1.2.3",
      downloadUrl: "https://example/ee02.bin",
      size: 123,
    });
  });

  it("returns null when this release doesn't include the given board's asset yet", () => {
    const rel = release([{ name: "firmware-ee02-13in3.bin", browser_download_url: "https://example/ee02.bin", size: 1 }]);
    expect(resolveBoardAsset(rel, "ee04-7in3")).toBeNull();
  });

  it("throws for a board id that isn't in FIRMWARE_ASSET_NAMES at all", () => {
    const rel = release([]);
    expect(() => resolveBoardAsset(rel, "not-a-real-board")).toThrow(/Unknown board id/);
  });

  it("resolves each known board independently out of the same multi-asset release", () => {
    const rel = release([
      { name: "firmware-ee02-13in3.bin", browser_download_url: "https://example/ee02.bin", size: 100 },
      { name: "firmware-ee04-7in3.bin", browser_download_url: "https://example/ee04.bin", size: 200 },
    ]);
    for (const board of Object.keys(FIRMWARE_ASSET_NAMES)) {
      expect(resolveBoardAsset(rel, board)?.downloadUrl).toContain(board.startsWith("ee02") ? "ee02" : "ee04");
    }
  });

  it("tolerates a tag with no leading 'v'", () => {
    const rel = release([{ name: "firmware-ee02-13in3.bin", browser_download_url: "u", size: 1 }], "2.0.0");
    expect(resolveBoardAsset(rel, "ee02-13in3")?.version).toBe("2.0.0");
  });
});
