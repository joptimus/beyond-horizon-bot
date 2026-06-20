import { describe, it, expect } from "vitest";
import { renderWhereToStart, type CodeContext } from "../src/codeContextTypes.js";
import { toIssueBody, type Enriched } from "../src/ai.js";
import { toBugIssueBody, type EnrichedBug } from "../src/aiBug.js";

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

const idea: Enriched = {
  title: "Fleet warp queue",
  summary: "Let players queue warp jumps.",
  gameplayImpact: "Smoother fleet movement.",
  scope: { client: ["Add queue UI"], server: ["POST /warp/queue"], database: ["No changes"] },
  implementationNotes: ["note"], risks: ["risk"], telemetry: [], antiCheat: [], dependencies: [],
  openQuestions: [], tags: ["Fleet"],
};

describe("toIssueBody (idea)", () => {
  it("inserts Where to Start after Scope when codeContext is present", () => {
    const body = toIssueBody(idea, "user#1", "123", "raw idea", { codeContext: ctx });
    expect(body).toContain("**Where to Start**");
    expect(body).toContain("`game-server`");
    expect(body.indexOf("**Where to Start**")).toBeGreaterThan(body.indexOf("**Database**"));
    expect(body.indexOf("**Where to Start**")).toBeLessThan(body.indexOf("**Implementation Notes**"));
  });

  it("omits Where to Start when no codeContext", () => {
    const body = toIssueBody(idea, "user#1", "123", "raw idea");
    expect(body).not.toContain("**Where to Start**");
  });
});

const bug: EnrichedBug = {
  title: "Warp hangs",
  summary: "Fleet gets stuck warping.",
  stepsToReproduce: ["Start a jump-gate warp"],
  expectedBehavior: "Warp completes.",
  actualBehavior: "Fleet stuck mid-warp.",
  frequency: "sometimes",
  openQuestions: [],
};

describe("toBugIssueBody (revamp)", () => {
  it("renders Where to Start, Suspected cause and Affected Systems when codeContext present", () => {
    const body = toBugIssueBody(bug, "user#1", { raw: "raw bug text", qa: "Q: in-system or jump-gate?\nA: jump gate", codeContext: ctx });
    expect(body).toContain("## Where to Start");
    expect(body).toContain("**Suspected cause:** warp state never clears on jump-gate path");
    expect(body).toContain("## Affected Systems");
    expect(body).toContain("`Server`");
    expect(body).toContain("## Player Clarifications");
    expect(body).toContain("Q: in-system or jump-gate?");
    expect(body).toContain("> raw bug text");
    expect(body).toContain("*Reported via Discord by user#1*");
  });

  it("omits code sections and clarifications when absent (no 'Not specified' noise)", () => {
    const body = toBugIssueBody(bug, "user#1", { raw: "raw bug text" });
    expect(body).not.toContain("## Where to Start");
    expect(body).not.toContain("Suspected cause");
    expect(body).not.toContain("## Affected Systems");
    expect(body).not.toContain("## Player Clarifications");
    expect(body).toContain("## Summary");
    expect(body).toContain("> raw bug text");
  });
});
