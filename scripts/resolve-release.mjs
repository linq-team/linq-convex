import fs from "node:fs";
import { pathToFileURL } from "node:url";

export async function resolveRelease(pkg, head, fetcher = fetch) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error("Invalid package version");
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
  if (response.status === 404) return { publish: true, releaseSha: head };
  if (!response.ok) throw new Error(`npm version lookup failed: HTTP ${response.status}`);
  const published = await response.json();
  const repo = published.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  if (published.name !== pkg.name || published.version !== pkg.version ||
      repo !== "https://github.com/linq-team/linq-convex" || !/^[a-f0-9]{40}$/.test(published.gitHead ?? "")) {
    throw new Error("Published package source cannot be verified; repair release metadata manually");
  }
  return { publish: false, releaseSha: published.gitHead };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const result = await resolveRelease(pkg, process.env.GITHUB_SHA);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    `name=${pkg.name}`, `version=${pkg.version}`, `tag=v${pkg.version}`,
    `publish=${result.publish}`, `release_sha=${result.releaseSha}`, "",
  ].join("\n"));
}
