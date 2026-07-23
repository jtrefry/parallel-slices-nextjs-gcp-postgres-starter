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
  cursor: "cursor-agent",
});

const providerLabels = Object.freeze({
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  cursor: "Cursor Agent CLI",
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
  cursor: ["CURSOR_API_KEY"],
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

function providerEnvironment(provider, billingPolicy) {
  const names = [...baseEnvironmentNames];
  if (provider === "codex") names.push("CODEX_HOME");
  if (provider === "claude-code") names.push("CLAUDE_CONFIG_DIR");
  if (provider === "cursor" && billingPolicy === "provider-managed") {
    names.push("CURSOR_API_KEY");
  }
  return Object.fromEntries(
    names
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

function providerProcessEnvironment(provider, billingPolicy) {
  return {
    env: providerEnvironment(provider, billingPolicy),
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
    cursor: [
      "Run `cursor-agent login`, complete the browser sign-in with the intended Cursor subscription, then retry.",
      "Run `cursor-agent status` to verify the cached login before starting review.",
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
    cursor: [
      "Install the official Cursor Agent CLI, then run `cursor-agent login`.",
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
    /CURSOR_MODEL_NOT_AVAILABLE|invalid model|unknown model|model(?: id)? (?:is )?not (?:available|supported|found)/i.test(
      detail,
    )
  ) {
    return problem(
      "MODEL_NOT_AVAILABLE",
      provider,
      `${providerLabels[provider]} cannot resolve every configured model id for this account.`,
      [
        "Choose a model id accepted by `cursor-agent --model`, then update .parallel-slices/review.json.",
      ],
    );
  }
  if (
    /CURSOR_AUTH_REQUIRED|not authenticated|not signed in|sign[ -]?in required|unauthorized|authentication required|login required|log in/i.test(
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
    ...providerProcessEnvironment(provider, options.billingPolicy),
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
  const version = await commandVersion(provider, {
    root,
    runProcess,
    billingPolicy: options.billingPolicy,
  });
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
    cursor: ["status"],
  }[provider];
  const result = await runProcess({
    command: providerCommands[provider],
    args: authCommand,
    cwd: root,
    timeoutMs: ["antigravity", "cursor"].includes(provider) ? 20_000 : 10_000,
    outputLimitBytes: 128 * 1024,
    ...providerProcessEnvironment(provider, options.billingPolicy),
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
  } else if (provider === "antigravity") {
    authKind = "cached-google-login";
    billingMode = "provider-account";
  } else {
    if (/not authenticated|not logged in|signed out/i.test(result.stdout)) {
      return problem(
        "AUTH_REQUIRED",
        provider,
        "Cursor Agent CLI requires browser authentication.",
        loginInstructions(provider),
      );
    }
    const usesApiKey =
      options.billingPolicy === "provider-managed" &&
      Boolean(process.env.CURSOR_API_KEY?.trim());
    authKind = usesApiKey ? "api-key" : "cached-browser-login";
    billingMode = usesApiKey ? "api" : "subscription";
  }
  if (
    options.billingPolicy === "subscription-only" &&
    (billingMode === "api" ||
      (provider === "cursor" && billingMode !== "subscription"))
  ) {
    const message =
      provider === "cursor"
        ? "Cursor is authenticated with an API key rather than the cached Cursor subscription login."
        : `${providerLabels[provider]} is authenticated for usage-based API billing rather than subscription access.`;
    return problem(
      "BILLING_MISMATCH",
      provider,
      message,
      loginInstructions(provider),
    );
  }
  if (provider === "cursor") {
    const modelsResult = await runProcess({
      command: providerCommands.cursor,
      args: ["--list-models"],
      cwd: root,
      timeoutMs: 20_000,
      outputLimitBytes: 256 * 1024,
      ...providerProcessEnvironment(provider, options.billingPolicy),
    });
    const processFailure = processProblem(
      modelsResult,
      provider,
      "model availability check",
    );
    if (processFailure) return processFailure;
    if (modelsResult.exitCode !== 0) {
      return classifyFailure(
        modelsResult,
        provider,
        "model availability check",
      );
    }
    const availableModels = new Set(
      modelsResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+-\s+/, 1)[0])
        .filter(Boolean),
    );
    const missingModels = (options.models || []).filter(
      (model) => !availableModels.has(model),
    );
    if (missingModels.length) {
      return problem(
        "MODEL_NOT_AVAILABLE",
        provider,
        `${providerLabels.cursor} cannot resolve configured model ids: ${missingModels.join(", ")}.`,
        [
          "Run `cursor-agent --list-models`, choose available model ids, then update .parallel-slices/review.json.",
        ],
      );
    }
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
  return `Read ${packetRelativePath} completely, inspect the authorized source snapshot without modifying it, and perform the requested review. Do not run mutating commands. Return only the structured reviewer response.`;
}

function markedJsonPrompt(packetRelativePath, schema) {
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
  } else if (reviewer.provider === "antigravity") {
    args = ["--sandbox"];
    if (reviewer.model) args.push("--model", reviewer.model);
    args.push("-p", markedJsonPrompt(packetRelativePath, responseSchema));
  } else {
    args = [
      "--print",
      "--output-format",
      "json",
      "--model",
      reviewer.model,
      markedJsonPrompt(packetRelativePath, responseSchema),
    ];
  }

  const result = await runProcess({
    command,
    args,
    cwd: snapshot.snapshotRoot,
    input,
    timeoutMs,
    outputLimitBytes: 2 * 1024 * 1024,
    ...providerProcessEnvironment(reviewer.provider, options.billingPolicy),
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
    } else if (reviewer.provider === "cursor") {
      const wrapper = parseJsonObject(result.stdout, "Cursor Agent response");
      if (wrapper.is_error === true || typeof wrapper.result !== "string") {
        throw new Error("Cursor Agent did not return a successful text result");
      }
      response = parseMarkedJson(wrapper.result);
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
