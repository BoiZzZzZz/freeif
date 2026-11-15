// Makes the keeper's Railway project again from nothing: project, service, variables, volume, settings,
// public domain, source repo. For the day Railway removes it (it did on Nov 15 2026: both projects of the
// trial workspace were removed by Railway's system 48 hours after they were made, volume included).
//
//   pnpm rehost [NAME=value ...]     then: pnpm ship
//
// Secrets are copied from secrets.env by name. Plain settings are given as NAME=value, for example
//   pnpm rehost CARDS_FROM_PROMO=0 STARTER_AMOUNT=5 EVENT_HINTS=NBA-2611152300-NYK-TOR-M
// A plain setting that is not given is taken from the newest backup of the vault (`pnpm backup` keeps
// latest-<vault>.json, which names the settings the keeper ran with), and the script says which.
// Needs RAILWAY_API_TOKEN and RAILWAY_WORKSPACE_ID in secrets.env. It writes RAILWAY_PROJECT_ID,
// RAILWAY_SERVICE_ID and RAILWAY_ENVIRONMENT_ID back into secrets.env (a copy is kept beside it), which
// is what `pnpm ship` reads. Each step is written to ~/.freeif/railway.json as it is done, so a run that
// stopped half way goes on from there; delete that file to start a new project.
// It prints ids, names and the plain settings, never a secret's value.
//
// What a new keeper does not have: its file. After `pnpm ship`, `pnpm backup --restore` puts the newest
// backup back. See README, "When the keeper's file is lost".
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const dir = join(homedir(), ".freeif");
const secretsPath = process.env.FREEIF_SECRETS ?? join(dir, "secrets.env");
process.loadEnvFile(secretsPath);

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`secrets.env has no ${name}`);
  return value;
};
const token = need("RAILWAY_API_TOKEN");
const workspaceId = need("RAILWAY_WORKSPACE_ID");
const REPO = "BoiZzZzZz/freeif";
const DOMAIN = "freeif-production.up.railway.app";
// Copied from secrets.env. The second list is optional: a keeper runs without them.
const SECRETS = ["VAULT_ADDRESS", "USDC_ADDRESS", "PRICER_PK", "ORACLE_PK", "RELAYER_PK", "ARC_RPC_URL"];
const OPTIONAL = ["QUICKNODE_ARC_RPC_URL", "CIRCLE_API_KEY", "CLAIM_TEST_KEY", "QUICKNODE_STREAM_SECRET", "GEMINI_SANDBOX_KEY", "GEMINI_SANDBOX_SECRET", "BACKUP_KEY"];
// Plain settings: given as NAME=value, or else taken from the newest backup of the vault.
const PLAIN = ["CARDS_FROM_PROMO", "STARTER_AMOUNT", "STARTER_BUDGET", "STARTER_FLOOR", "EVENT_HINTS"];

/** The plain settings the newest backup of the vault names (`pnpm backup` keeps it), and its file. */
function settingsFromBackup(vault) {
  const backups = process.env.FREEIF_BACKUP_DIR || join(dirname(secretsPath), "backups");
  const file = join(backups, `latest-${vault.toLowerCase()}.json`);
  if (!existsSync(file)) return { file: null, settings: {} };
  try {
    return { file, settings: JSON.parse(readFileSync(file, "utf8"))?.meta?.settings ?? {} };
  } catch (err) {
    console.log(`the backup ${file} cannot be read (${err.message}): plain settings only as given`);
    return { file, settings: {} };
  }
}

const statePath = join(dir, "railway.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 1));

async function railway(query, variables) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

async function step(name, run) {
  if (state[name]) return console.log("done before:", name);
  state[name] = (await run()) ?? true;
  save();
  console.log("done:", name, JSON.stringify(state[name]));
}

await step("project", async () => {
  const d = await railway("mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id environments { edges { node { id name } } } } }", {
    i: { name: "freeif", workspaceId, defaultEnvironmentName: "production" },
  });
  return { projectId: d.projectCreate.id, environmentId: d.projectCreate.environments.edges[0].node.id };
});
const { projectId, environmentId } = state.project;

await step("service", async () => {
  const d = await railway("mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }", { i: { projectId, environmentId, name: "freeif" } });
  return { serviceId: d.serviceCreate.id };
});
const { serviceId } = state.service;

// Before the source is connected, so the first build already has them.
await step("variables", async () => {
  const variables = { KEEPER_DATA_DIR: "/data", PORT: "8787" };
  for (const name of SECRETS) variables[name] = need(name);
  for (const name of OPTIONAL) if (process.env[name]) variables[name] = process.env[name];
  for (const arg of process.argv.slice(2)) {
    const at = arg.indexOf("=");
    if (at < 1) throw new Error(`"${arg}" is not NAME=value`);
    variables[arg.slice(0, at)] = arg.slice(at + 1);
  }
  // The plain settings not given: the ones the keeper ran with, as its newest backup names them.
  const backup = settingsFromBackup(variables.VAULT_ADDRESS);
  const fromBackup = [];
  for (const name of PLAIN) {
    const value = backup.settings[name];
    if (variables[name] !== undefined || typeof value !== "string" || value === "") continue;
    variables[name] = value;
    fromBackup.push(`${name}=${value}`);
  }
  if (backup.file === null) console.log(`no backup of vault ${variables.VAULT_ADDRESS} found: plain settings only as given`);
  else if (fromBackup.length > 0) console.log(`from the backup ${backup.file}: ${fromBackup.join(" ")}`);
  else console.log(`the backup ${backup.file} names no plain setting that was not given`);
  await railway("mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }", {
    i: { projectId, environmentId, serviceId, variables, skipDeploys: true },
  });
  return { names: Object.keys(variables) };
});

await step("volume", async () => {
  const d = await railway("mutation($i: VolumeCreateInput!) { volumeCreate(input: $i) { id name } }", { i: { projectId, environmentId, serviceId, mountPath: "/data" } });
  return d.volumeCreate;
});

await step("settings", async () => {
  await railway("mutation($s: String!, $e: String!, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }", {
    s: serviceId,
    e: environmentId,
    i: { rootDirectory: "keeper", healthcheckPath: "/health", restartPolicyType: "ON_FAILURE" },
  });
});

// Railway names the domain after the service and the environment, so the old address comes back when
// nobody has taken it. If it gives another, the rename is tried; if that is refused, the web app's
// NEXT_PUBLIC_KEEPER_URL has to change.
await step("domain", async () => {
  const d = await railway("mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { id domain } }", { i: { serviceId, environmentId, targetPort: 8787 } });
  const made = d.serviceDomainCreate;
  if (made.domain === DOMAIN) return made;
  try {
    await railway("mutation($i: ServiceDomainUpdateInput!) { serviceDomainUpdate(input: $i) }", {
      i: { serviceId, environmentId, serviceDomainId: made.id, domain: DOMAIN, targetPort: 8787 },
    });
    return { id: made.id, domain: DOMAIN };
  } catch (err) {
    console.log(`the address is ${made.domain}, not ${DOMAIN} (rename refused: ${err.message})`);
    return made;
  }
});

await step("source", async () => {
  await railway("mutation($id: String!, $i: ServiceConnectInput!) { serviceConnect(id: $id, input: $i) { id } }", { id: serviceId, i: { repo: REPO, branch: "main" } });
});

await step("secrets", async () => {
  copyFileSync(secretsPath, `${secretsPath}.before-rehost`);
  let text = readFileSync(secretsPath, "utf8");
  for (const [name, value] of [["RAILWAY_PROJECT_ID", projectId], ["RAILWAY_SERVICE_ID", serviceId], ["RAILWAY_ENVIRONMENT_ID", environmentId]]) {
    const line = new RegExp(`^${name}=.*$`, "m");
    text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.replace(/\n*$/, "\n")}${name}=${value}\n`;
  }
  writeFileSync(secretsPath, text);
});

console.log(`project ${projectId}, service ${serviceId}, environment ${environmentId}`);
console.log(`address https://${state.domain.domain}. Next: pnpm ship`);
