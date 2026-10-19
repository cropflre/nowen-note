#!/usr/bin/env node
/**
 * This guard never merges or publishes anything. It rejects stale or broken
 * stacked Studio PR ancestry before humans attempt a staged release merge.
 *
 * GitHub Actions grants read-only pull-requests/contents for this check.
 */
const repository = process.env.GITHUB_REPOSITORY || "";
const token = process.env.GITHUB_TOKEN || "";
const candidate = process.env.STUDIO_RC_HEAD || process.env.GITHUB_HEAD_REF || "feature/nowen-studio-rc-p3";
const expected = [
  { number: 873, head: "feature/nowen-studio-p0", base: "release/v1.5.3" },
  { number: 874, head: "feature/nowen-studio-ai-p1", base: "feature/nowen-studio-p0" },
  { number: 876, head: "feature/nowen-studio-release-gates-p2", base: "feature/nowen-studio-ai-p1" },
];
if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
  console.error("RC_LINEAGE_UNAVAILABLE: GitHub repository and read-only token required");
  process.exit(2);
}
const api = async (endpoint) => {
  const r = await fetch("https://api.github.com/repos/" + repository + endpoint, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("GitHub API status " + r.status + " for " + endpoint.split("?")[0]);
  return r.json();
};
const problems = [];
const pullRequests = [];
try {
  for (const item of expected) {
    const pr = await api("/pulls/" + item.number);
    if (pr.state !== "open") problems.push("#" + item.number + " must still be open for stacked acceptance");
    if (pr.head.ref !== item.head || pr.base.ref !== item.base) problems.push("#" + item.number + " unexpectedly changed its base/head");
    if (pr.head.repo.full_name !== repository || pr.base.repo.full_name !== repository) problems.push("#" + item.number + " cross-repository ref is unsupported");
    pullRequests.push(pr);
  }
  for (let i = 1; i < pullRequests.length; i++) {
    const parent = pullRequests[i - 1].head.sha;
    const next = pullRequests[i].head.sha;
    const compare = await api("/compare/" + parent + "..." + next);
    if (!["ahead", "identical"].includes(compare.status)) problems.push("#" + expected[i].number + " is not a descendant of its stacked parent");
  }
  const last = pullRequests.at(-1).head.sha;
  const rc = await api("/branches/" + encodeURIComponent(candidate));
  const ancestry = await api("/compare/" + last + "..." + rc.commit.sha);
  if (!["ahead", "identical"].includes(ancestry.status)) problems.push("RC head does not contain #876");
  const release = await api("/branches/release%2Fv1.5.3");
  if (release.commit.sha !== pullRequests[0].base.sha) problems.push("release/v1.5.3 advanced; rebase and redo all gates");
  const currentPr = await api("/pulls?head=" + encodeURIComponent(repository.split("/")[0] + ":" + candidate) + "&state=open");
  const rcPr = currentPr.find(p => p.head.ref === candidate);
  if (rcPr && rcPr.base.ref !== "feature/nowen-studio-release-gates-p2") {
    problems.push("RC PR must target P2 development branch until it is ready");
  }
  if (problems.length) {
    console.error("RC_LINEAGE_BLOCKED\n" + problems.map(s => "- " + s).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("RC_LINEAGE_PASS: release base, #873 → #874 → #876 and current RC branch match.");
    console.log("Does NOT authorize merging: Sync V2, native platform and release gates must also pass.");
  }
} catch (err) {
  console.error("RC_LINEAGE_UNVERIFIED:", err instanceof Error ? err.message : "unexpected error");
  process.exitCode = 2;
}
