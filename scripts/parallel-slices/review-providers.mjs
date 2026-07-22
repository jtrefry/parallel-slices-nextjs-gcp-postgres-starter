import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  containsMachineSpecificPath,
  containsPotentialSecret,
} from "./content-safety.mjs";
import {
  parseJsonObject,
  parseMarkedJson,
  validateReviewerResponse,
} from "./review-contract.mjs";
import { runSupervised } from "./review-process.mjs";

const providerCommands = Object.freeze({
  codex: "codex",
  "claude-code": "claude",
  antigravity: "agy",
});

const providerLabels = Object.freeze({
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
});

const subscriptionConflicts = Object.freeze({
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  "claude-code": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  antigravity: [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENAI_USE_VERTEXAI",
  ],
});

const baseEnvironmentNames = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

function providerEnvironment(provider) {
  const names = [...baseEnvironmentNames];
  if (provider === "codex") names.push("CODEX_HOME");
  if (provider === "claude-code") names.push("CLAUDE_CONFIG_DIR");
  return Object.fromEntries(
    names
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function providerProcessEnvironment(provider) {
  return {
    env: providerEnvironment(provider),
    replaceEnv: true,
  };
}

function firstLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 200);
}

function loginInstructions(provider) {
  return {
    codex: ["Run `codex login` and choose Sign in with ChatGPT."],
    "claude-code": [
      "Run `claude auth login` and choose the Claude subscription.",
    ],
    antigravity: [
      "Run `agy`, complete Google sign-in, accept required terms, and trust the repository when prompted.",
    ],
  }[provider];
}

function installInstructions(provider) {
  return {
    codex: ["Install the official Codex CLI, then run `codex login`."],
    "claude-code": [
      "Install the official Claude Code CLI, then run `claude auth login`.",
    ],
    antigravity: [
      "Install the official Antigravity CLI from https://antigravity.google/docs/cli-getting-started, then run `agy`.",
    ],
  }[provider];
}

function problem(code, provider, message, instructions = []) {
  return {
    ok: false,
    code,
    provider,
    label: providerLabels[provider],
    message,
    instructions,
  };
}

function processProblem(result, provider, phase) {
  if (result.outcome === "start_error") {
    if (result.error?.code === "ENOENT") {
      return problem(
        "CLI_NOT_INSTALLED",
        provider,
        `${providerLabels[provider]} CLI is not installed or not on PATH.`,
        installInstructions(provider),
      );
    }
    return problem(
      "PROVIDER_ERROR",
      provider,
      `${providerLabels[provider]} ${phase} could not start.`,
    );
  }
  if (result.outcome === "timed_out") {
    return problem(
      phase === "authentication check"
        ? "AUTH_CHECK_TIMEOUT"
        : "PROVIDER_TIMEOUT",
      provider,
      `${providerLabels[provider]} ${phase} timed out.`,
    );
  }
  if (result.outcome === "output_limit") {
    return problem(
      "PROVIDER_OUTPUT_LIMIT",
      provider,
      `${providerLabels[provider]} ${phase} exceeded the output limit.`,
    );
  }
  return null;
}

function classifyFailure(result, provider, phase) {
  const processFailure = processProblem(result, provider, phase);
  if (processFailure) return processFailure;
  const detail = `${result.stdout}\n${result.stderr}`;
  if (
    /not signed in|sign[ -]?in required|unauthorized|authentication required|login required|log in/i.test(
      detail,
    )
  ) {
    return problem(
      "AUTH_REQUIRED",
      provider,
      `${providerLabels[provider]} requires authentication.`,
      loginInstructions(provider),
    );
  }
  if (
    /terms|trust (?:this )?(?:folder|workspace|repository)|onboarding/i.test(
      detail,
    )
  ) {
    return problem(
      "INTERACTIVE_SETUP_REQUIRED",
      provider,
      `${providerLabels[provider]} requires interactive terms or workspace setup.`,
      loginInstructions(provider),
    );
  }
  if (
    /quota|rate.?limit|usage limit|credit.*exhaust|resource exhausted|\b429\b/i.test(
      detail,
    )
  ) {
    return problem(
      "QUOTA_EXHAUSTED",
      provider,
      `${providerLabels[provider]} has no available quota or credits.`,
    );
  }
  return problem(
    "PROVIDER_ERROR",
    provider,
    `${providerLabels[provider]} ${phase} failed with exit code ${result.exitCode ?? "unknown"}.`,
  );
}

async function commandVersion(provider, options) {
  const result = await options.runProcess({
    command: providerCommands[provider],
    args: ["--version"],
    cwd: options.root,
    timeoutMs: 10_000,
    outputLimitBytes: 32 * 1024,
    ...providerProcessEnvironment(provider),
  });
  const failure = processProblem(result, provider, "version check");
  if (failure) return failure;
  if (result.exitCode !== 0)
    return classifyFailure(result, provider, "version check");
  const value = firstLine(result.stdout) || "version unavailable";
  if (containsMachineSpecificPath(value) || containsPotentialSecret(value)) {
    return problem(
      "PROVIDER_ERROR",
      provider,
      `${providerLabels[provider]} returned unsafe version output.`,
    );
  }
  return {
    ok: true,
    version: value,
  };
}

export async function preflightProvider(provider, options = {}) {
  const runProcess = options.runProcess ?? runSupervised;
  const root = options.root;
  const version = await commandVersion(provider, { root, runProcess });
  if (!version.ok) return version;

  if (options.billingPolicy === "subscription-only") {
    const conflicts = subscriptionConflicts[provider].filter(
      (name) => process.env[name],
    );
    if (conflicts.length) {
      return problem(
        "BILLING_MISMATCH",
        provider,
        `${providerLabels[provider]} has API or cloud credential environment variables that can override subscription authentication: ${conflicts.join(", ")}.`,
        [
          "Unset the listed variables in the review runner terminal, then retry.",
        ],
      );
    }
  }

  const authCommand = {
    codex: ["login", "status"],
    "claude-code": ["auth", "status"],
    antigravity: ["models"],
  }[provider];
  const result = await runProcess({
    command: providerCommands[provider],
    args: authCommand,
    cwd: root,
    timeoutMs: provider === "antigravity" ? 20_000 : 10_000,
    outputLimitBytes: 128 * 1024,
    ...providerProcessEnvironment(provider),
  });
  const processFailure = processProblem(
    result,
    provider,
    "authentication check",
  );
  if (processFailure) return processFailure;
  if (result.exitCode !== 0) {
    return classifyFailure(result, provider, "authentication check");
  }

  let authKind;
  let billingMode;
  if (provider === "codex") {
    if (/API key/i.test(result.stdout)) {
      authKind = "api-key";
      billingMode = "api";
    } else if (/ChatGPT/i.test(result.stdout)) {
      authKind = "user-oauth";
      billingMode = "subscription";
    } else {
      return problem(
        "AUTH_STATUS_UNKNOWN",
        provider,
        "Codex authentication status was not recognized.",
      );
    }
  } else if (provider === "claude-code") {
    let status;
    try {
      status = JSON.parse(result.stdout);
    } catch {
      return problem(
        "AUTH_STATUS_UNKNOWN",
        provider,
        "Claude Code authentication status was not valid JSON.",
      );
    }
    if (status.loggedIn !== true) {
      return problem(
        "AUTH_REQUIRED",
        provider,
        "Claude Code requires authentication.",
        loginInstructions(provider),
      );
    }
    if (status.authMethod === "claude.ai") {
      authKind = "user-oauth";
      billingMode = "subscription-credit";
    } else {
      authKind = "provider-credential";
      billingMode = "api";
    }
  } else {
    authKind = "cached-google-login";
    billingMode = "provider-account";
  }
  if (options.billingPolicy === "subscription-only" && billingMode === "api") {
    return problem(
      "BILLING_MISMATCH",
      provider,
      `${providerLabels[provider]} is authenticated for usage-based API billing rather than subscription access.`,
      loginInstructions(provider),
    );
  }
  return {
    ok: true,
    provider,
    label: providerLabels[provider],
    version: version.version,
    authKind,
    billingMode,
  };
}

function reviewerPrompt(packetRelativePath) {
  return `Read ${packetRelativePath} completely, inspect the authorized source snapshot, and perform the requested review. Return only the structured reviewer response.`;
}

function antigravityPrompt(packetRelativePath, schema) {
  return `${reviewerPrompt(packetRelativePath)}

Your final output must contain exactly these markers and one JSON object that
conforms to the schema between them. Do not use Markdown fences.

PARALLEL_SLICES_REVIEW_JSON_BEGIN
<JSON matching this schema: ${JSON.stringify(schema)}>
PARALLEL_SLICES_REVIEW_JSON_END`;
}

export async function invokeProvider(options) {
  const {
    reviewer,
    root,
    snapshot,
    scratchRoot,
    timeoutMs,
    expectedFindingIds,
  } = options;
  const runProcess = options.runProcess ?? runSupervised;
  const installedResponseSchemaPath = resolve(
    root,
    ".parallel-slices/review-response.schema.json",
  );
  if (!existsSync(installedResponseSchemaPath)) {
    throw new Error(".parallel-slices/review-response.schema.json is missing");
  }
  const responseSchemaPath = resolve(
    snapshot.snapshotRoot,
    ".parallel-slices/review-response.schema.json",
  );
  const responseSchema = JSON.parse(readFileSync(responseSchemaPath, "utf8"));
  const packetRelativePath = ".parallel-slices-review-input/packet.md";
  let command = providerCommands[reviewer.provider];
  let args;
  let input = "";
  let outputPath;

  if (reviewer.provider === "codex") {
    outputPath = resolve(scratchRoot, `${reviewer.id}-response.json`);
    args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--output-schema",
      responseSchemaPath,
      "--output-last-message",
      outputPath,
      "-C",
      snapshot.snapshotRoot,
    ];
    if (reviewer.model) args.push("--model", reviewer.model);
    if (reviewer.effort) {
      args.push("-c", `model_reasoning_effort="${reviewer.effort}"`);
    }
    args.push("-");
    input = reviewerPrompt(packetRelativePath);
  } else if (reviewer.provider === "claude-code") {
    args = [
      "--print",
      "--safe-mode",
      "--disable-slash-commands",
      "--tools",
      "Read,Glob,Grep",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(responseSchema),
    ];
    if (reviewer.model) args.push("--model", reviewer.model);
    if (reviewer.effort) args.push("--effort", reviewer.effort);
    args.push(reviewerPrompt(packetRelativePath));
  } else {
    args = ["--sandbox"];
    if (reviewer.model) args.push("--model", reviewer.model);
    args.push("-p", antigravityPrompt(packetRelativePath, responseSchema));
  }

  const result = await runProcess({
    command,
    args,
    cwd: snapshot.snapshotRoot,
    input,
    timeoutMs,
    outputLimitBytes: 2 * 1024 * 1024,
    ...providerProcessEnvironment(reviewer.provider),
  });
  const processFailure = processProblem(
    result,
    reviewer.provider,
    "review turn",
  );
  if (processFailure) return { ok: false, problem: processFailure, result };
  if (result.exitCode !== 0) {
    return {
      ok: false,
      problem: classifyFailure(result, reviewer.provider, "review turn"),
      result,
    };
  }

  let response;
  try {
    if (reviewer.provider === "codex") {
      if (!existsSync(outputPath)) {
        throw new Error("Codex did not write its structured final response");
      }
      response = parseJsonObject(
        readFileSync(outputPath, "utf8"),
        "Codex response",
      );
    } else if (reviewer.provider === "claude-code") {
      const wrapper = parseJsonObject(result.stdout, "Claude Code response");
      response =
        wrapper.structured_output ??
        parseJsonObject(wrapper.result ?? "", "Claude Code structured result");
    } else {
      response = parseMarkedJson(result.stdout);
    }
    validateReviewerResponse(response, expectedFindingIds);
    const serializedResponse = JSON.stringify(response);
    if (containsPotentialSecret(serializedResponse)) {
      throw new Error("structured review contains a possible secret");
    }
    if (containsMachineSpecificPath(serializedResponse)) {
      throw new Error("structured review contains a machine-specific path");
    }
  } catch (error) {
    return {
      ok: false,
      problem: problem(
        "INVALID_RESPONSE",
        reviewer.provider,
        `${providerLabels[reviewer.provider]} returned an invalid structured review: ${error.message}`,
      ),
      result,
    };
  }
  return { ok: true, response, durationMs: result.durationMs };
}

export function providerRecoveryText(problemValue) {
  return [problemValue.message, ...problemValue.instructions].join("\n");
}

export const reviewProviderCommands = providerCommands;
