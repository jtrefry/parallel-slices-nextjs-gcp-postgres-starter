#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

let credentialToRedact;

function parseArguments(argv) {
  const command = argv[0];
  if (command === "version") {
    if (argv.length !== 1) fail("version does not accept arguments");
    return { command };
  }
  if (command === "preflight") {
    const models = [];
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] !== "--model" || !argv[index + 1]) {
        fail(`unknown Cursor preflight argument: ${argv[index]}`);
      }
      models.push(argv[index + 1]);
      index += 1;
    }
    return { command, models: [...new Set(models)] };
  }
  if (command === "review") {
    if (argv.length !== 3 || argv[1] !== "--model" || !argv[2]) {
      fail("review requires --model <model-id>");
    }
    return { command, model: argv[2] };
  }
  fail("expected version, preflight, or review");
}

function apiKey() {
  const value = process.env.CURSOR_API_KEY?.trim();
  if (!value) {
    const error = new Error("CURSOR_API_KEY is required for Cursor SDK review");
    error.marker = "CURSOR_AUTH_REQUIRED";
    throw error;
  }
  credentialToRedact = value;
  delete process.env.CURSOR_API_KEY;
  return value;
}

function assertSupportedRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    const error = new Error(
      `@cursor/sdk requires Node.js 22.13 or newer; found ${process.version}`,
    );
    error.marker = "CURSOR_RUNTIME_UNSUPPORTED";
    throw error;
  }
}

async function loadSdk() {
  try {
    return await import("@cursor/sdk");
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" ||
      /Cannot find package ['"]@cursor\/sdk['"]/.test(error?.message || "")
    ) {
      error.marker = "CURSOR_SDK_NOT_INSTALLED";
    }
    throw error;
  }
}

function sdkVersion() {
  const entryPath = fileURLToPath(import.meta.resolve("@cursor/sdk"));
  let directory = dirname(entryPath);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      if (manifest.name === "@cursor/sdk" && manifest.version) {
        return manifest.version;
      }
    } catch {
      // Continue toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "version unavailable";
}

function modelIsAvailable(model, catalog) {
  return catalog.some(
    (entry) => entry.id === model || entry.aliases?.includes(model),
  );
}

function failureMarker(error) {
  if (error?.marker) return error.marker;
  const detail = `${error?.name || ""} ${error?.code || ""} ${error?.message || ""}`;
  if (
    /AuthenticationError|unauthorized|invalid api key|\b401\b/i.test(detail)
  ) {
    return "CURSOR_AUTH_REQUIRED";
  }
  if (/RateLimitError|rate.?limit|quota|usage limit|\b429\b/i.test(detail)) {
    return "CURSOR_QUOTA_EXHAUSTED";
  }
  if (
    /ConfigurationError|bad model|invalid model|model.+not.+available/i.test(
      detail,
    )
  ) {
    return "CURSOR_MODEL_NOT_AVAILABLE";
  }
  return "CURSOR_PROVIDER_ERROR";
}

function safeDiagnostic(error) {
  let value = error?.message || error?.name || "Cursor SDK operation failed";
  const secret = credentialToRedact || process.env.CURSOR_API_KEY;
  if (secret) value = value.replaceAll(secret, "[REDACTED]");
  for (const path of [process.cwd(), process.env.HOME].filter(Boolean)) {
    value = value.replaceAll(path, "<local-path>");
  }
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 500);
}

async function preflight(models) {
  const key = apiKey();
  const { Cursor } = await loadSdk();
  const user = await Cursor.me({ apiKey: key });
  const catalog = await Cursor.models.list({ apiKey: key });
  const missing = models.filter((model) => !modelIsAvailable(model, catalog));
  if (missing.length) {
    const error = new Error(
      `configured Cursor model ids are not available to this account: ${missing.join(", ")}`,
    );
    error.marker = "CURSOR_MODEL_NOT_AVAILABLE";
    throw error;
  }
  const userKey = user.userId !== undefined;
  process.stdout.write(
    `${JSON.stringify({
      authKind: userKey ? "user-api-key" : "service-account-api-key",
      billingMode: userKey ? "subscription" : "provider-account",
    })}\n`,
  );
}

async function review(model) {
  const key = apiKey();
  const { Agent } = await loadSdk();
  const prompt = readFileSync(0, "utf8");
  if (!prompt.trim()) fail("Cursor review prompt is empty");
  const result = await Agent.prompt(prompt, {
    apiKey: key,
    model: { id: model },
    local: {
      cwd: process.cwd(),
      sandboxOptions: { enabled: true },
      settingSources: [],
    },
  });
  if (result.status !== "finished" || typeof result.result !== "string") {
    const detail =
      result.error?.message || `run ended with status ${result.status}`;
    const error = new Error(detail);
    error.marker = "CURSOR_RUN_FAILED";
    throw error;
  }
  process.stdout.write(`${result.result}\n`);
}

async function main(argv) {
  const options = parseArguments(argv);
  assertSupportedRuntime();
  if (options.command === "version") {
    await loadSdk();
    console.log(`@cursor/sdk ${sdkVersion()}`);
  } else if (options.command === "preflight") {
    await preflight(options.models);
  } else {
    await review(options.model);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`${failureMarker(error)}: ${safeDiagnostic(error)}`);
  process.exitCode = 1;
});
