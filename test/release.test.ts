import { expect, test } from "vitest";

// This is the registry gate executed by the publish workflow.
// @ts-expect-error Release script is JavaScript, executed directly by Node.
import { resolveRelease } from "../scripts/resolve-release.mjs";

const pkg = { name: "@linqapp/convex", version: "0.1.0" };
const head = "a".repeat(40);
test("only npm 404 starts a new publish", async () => {
  expect(await resolveRelease(pkg, head, async () => new Response(null, { status: 404 }))).toEqual({ publish: true, releaseSha: head });
  await expect(resolveRelease(pkg, head, async () => new Response(null, { status: 503 }))).rejects.toThrow("lookup failed");
});
test("existing versions retain their original verified source for release repair", async () => {
  const published = { ...pkg, gitHead: "b".repeat(40), repository: { url: "git+https://github.com/linq-team/linq-convex.git" } };
  expect(await resolveRelease(pkg, head, async () => Response.json(published))).toEqual({ publish: false, releaseSha: published.gitHead });
  await expect(resolveRelease(pkg, head, async () => Response.json({ ...published, repository: { url: "https://example.com/other" } }))).rejects.toThrow("source cannot be verified");
});
