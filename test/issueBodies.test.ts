import { describe, it, expect } from "vitest";
import { renderWhereToStart, type CodeContext } from "../src/codeContextTypes.js";

const ctx: CodeContext = {
  whereToStart: [
    { repo: "game-server", path: "src/fleet/warp.ts", symbol: "beginWarp", reason: "handles warp state transitions" },
    { repo: "SpaceMMORPG", path: "Assets/Scripts/Fleet/WarpController.cs", reason: "client-side warp VFX/state" },
  ],
  suspectedCause: "warp state never clears on jump-gate path",
  affectedSystems: ["Server", "Fleet", "Client-UI"],
  confidence: "medium",
};

describe("renderWhereToStart", () => {
  it("renders repo/path/symbol/reason lines with a confidence footnote", () => {
    const md = renderWhereToStart(ctx);
    expect(md).toContain("_(AI-generated from code index, confidence: medium)_");
    expect(md).toContain("`game-server` — `src/fleet/warp.ts` → `beginWarp()`: handles warp state transitions");
    expect(md).toContain("`SpaceMMORPG` — `Assets/Scripts/Fleet/WarpController.cs`: client-side warp VFX/state");
  });

  it("returns empty string when there are no pointers", () => {
    expect(renderWhereToStart({ whereToStart: [], affectedSystems: [], confidence: "low" })).toBe("");
  });
});
