// scripts/tryCodeSearch.ts
// Manual end-to-end check against the live repowise instance.
// Usage: npm run try:codesearch -- "fleet gets stuck warping"
import "dotenv/config";
import { findCodePointers } from "../src/aiCodeContext.js";

async function main() {
  const text = process.argv.slice(2).join(" ").trim();
  if (!text) {
    console.error('Usage: npm run try:codesearch -- "your idea or bug text"');
    process.exit(1);
  }
  if (!process.env.REPOWISE_MCP_URL) {
    console.warn("REPOWISE_MCP_URL is not set — feature is disabled, result will be null.");
  }
  console.log(`Searching for: ${text}\n`);
  const ctx = await findCodePointers(text, "bug");
  console.log(JSON.stringify(ctx, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
