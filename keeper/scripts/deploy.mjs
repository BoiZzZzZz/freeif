// Deploys the pushed commit of `main` to the keeper's Railway service and waits for the result.
// Needs RAILWAY_API_TOKEN, RAILWAY_SERVICE_ID and RAILWAY_ENVIRONMENT_ID in the environment
// (on a developer machine they come from ~/.freeif/secrets.env, like every other setting).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const secrets = process.env.FREEIF_SECRETS ?? join(homedir(), ".freeif", "secrets.env");
if (existsSync(secrets)) process.loadEnvFile(secrets);

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};
const token = need("RAILWAY_API_TOKEN");
const serviceId = need("RAILWAY_SERVICE_ID");
const environmentId = need("RAILWAY_ENVIRONMENT_ID");

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
if (commit !== git("rev-parse", "origin/main")) {
  throw new Error("HEAD is not origin/main. Railway builds from GitHub: commit and push first.");
}

async function railway(query, variables) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const { serviceInstanceDeployV2: deploymentId } = await railway(
  "mutation($s: String!, $e: String!, $c: String) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e, commitSha: $c) }",
  { s: serviceId, e: environmentId, c: commit },
);
console.log(`deploying ${commit.slice(0, 7)} (deployment ${deploymentId})`);

let status = "";
for (;;) {
  const { deployment } = await railway("query($id: String!) { deployment(id: $id) { status staticUrl } }", { id: deploymentId });
  if (deployment.status !== status) {
    status = deployment.status;
    console.log(`${new Date().toISOString().slice(11, 19)} ${status}`);
  }
  if (status === "SUCCESS") {
    if (deployment.staticUrl) console.log(`live at https://${deployment.staticUrl}/health`);
    break;
  }
  if (["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(status)) {
    console.error("The deployment did not go live. The previous build keeps serving. See the build log in Railway.");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
