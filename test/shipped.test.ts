import { describe, it, expect } from "vitest";
import {
  parseDiscordId,
  isAnnounceable,
  renderShippedMessage,
  TRACKED_LABELS,
  ANNOUNCED_LABEL,
  type GhIssueLite,
} from "../src/shipped.js";

const baseIssue = (over: Partial<GhIssueLite> = {}): GhIssueLite => ({
  number: 42,
  title: "Fleet warp queue",
  html_url: "https://github.com/o/r/issues/42",
  state: "closed",
  state_reason: "completed",
  body: "Submitted by **cmd#1** (Discord ID: 123456789012345678)\n\nSummary...",
  labels: [{ name: "idea" }],
  ...over,
});

describe("parseDiscordId", () => {
  it("extracts the Discord ID embedded in an issue body", () => {
    expect(parseDiscordId("Submitted by **cmd#1** (Discord ID: 123456789012345678)")).toBe(
      "123456789012345678"
    );
  });

  it("returns null when no Discord ID is present", () => {
    expect(parseDiscordId("A manually filed issue with no submitter tag")).toBeNull();
  });

  it("returns null for empty or null bodies", () => {
    expect(parseDiscordId("")).toBeNull();
    expect(parseDiscordId(null)).toBeNull();
  });
});

describe("isAnnounceable", () => {
  it("is true for a closed-as-completed tracked issue with a submitter and no announced label", () => {
    expect(isAnnounceable(baseIssue())).toBe(true);
  });

  it("is false when the issue is still open", () => {
    expect(isAnnounceable(baseIssue({ state: "open", state_reason: null }))).toBe(false);
  });

  it("is false when closed as not planned", () => {
    expect(isAnnounceable(baseIssue({ state_reason: "not_planned" }))).toBe(false);
  });

  it("is false when already announced", () => {
    expect(
      isAnnounceable(baseIssue({ labels: [{ name: "idea" }, { name: ANNOUNCED_LABEL }] }))
    ).toBe(false);
  });

  it("is false when it carries none of the tracked labels", () => {
    expect(isAnnounceable(baseIssue({ labels: [{ name: "documentation" }] }))).toBe(false);
  });

  it("is false when it is a pull request, not an issue", () => {
    expect(isAnnounceable(baseIssue({ pull_request: { url: "..." } }))).toBe(false);
  });

  it("is false when no submitter Discord ID can be parsed", () => {
    expect(isAnnounceable(baseIssue({ body: "no submitter here" }))).toBe(false);
  });

  it("accepts labels given as plain strings", () => {
    expect(isAnnounceable(baseIssue({ labels: ["bug"] }))).toBe(true);
  });

  it("treats every tracked label as eligible", () => {
    for (const name of TRACKED_LABELS) {
      expect(isAnnounceable(baseIssue({ labels: [{ name }] }))).toBe(true);
    }
  });
});

describe("renderShippedMessage", () => {
  it("mentions the submitter, the issue title, a closed-status line, and a release", () => {
    const msg = renderShippedMessage({
      issueTitle: "Fleet warp queue",
      issueNumber: 42,
      memberId: "123456789012345678",
    });
    expect(msg.description).toContain("<@123456789012345678>");
    expect(msg.description).toContain("Fleet warp queue");
    expect(msg.description).toContain("Status: Github issue #42 has been closed.");
    expect(msg.description.toLowerCase()).toContain("release");
    expect(msg.title.length).toBeGreaterThan(0);
  });

  it("does not leak the GitHub issue URL to players", () => {
    const msg = renderShippedMessage({
      issueTitle: "Fleet warp queue",
      issueNumber: 42,
      memberId: "123456789012345678",
    });
    expect(msg.description).not.toContain("github.com");
    expect(msg.description).not.toContain("http");
  });
});
