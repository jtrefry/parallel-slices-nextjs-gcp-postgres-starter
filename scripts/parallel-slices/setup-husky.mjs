#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectPackageManager,
  includesHuskyCommand,
  packageManagerCommand,
} from "./project-quality.mjs";

function fail(message) {
  throw new Error(message);
}

function addHuskyScript(pkg, manager) {
  const scriptName = manager === "yarn" ? "postinstall" : "prepare";
  pkg.scripts ||= {};
  const existing = pkg.scripts[scriptName];
  if (!existing) pkg.scripts[scriptName] = "husky";
  else if (!includesHuskyCommand(existing))
    pkg.scripts[scriptName] = `${existing} && husky`;
  return scriptName;
}

function installHusky(root, manager) {
  const commands = {
    npm: ["install", "--save-dev", "husky@9.1.7"],
    pnpm: ["add", "--save-dev", "--workspace-root", "husky@9.1.7"],
    yarn: ["add", "--dev", "husky@9.1.7"],
    bun: ["add", "--dev", "husky@9.1.7"],
  };
  const managerArgs = commands[manager];
  if (!managerArgs) fail(`unsupported package manager: ${manager}`);
  const [command, args] = packageManagerCommand(manager, managerArgs);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`could not install Husky: ${result.error.message}`);
  if (result.status !== 0)
    fail(`Husky installation failed with exit code ${result.status}`);
}

function runLifecycle(root, manager, scriptName) {
  const [command, args] = packageManagerCommand(manager, ["run", scriptName]);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) fail(`could not initialize Husky: ${result.error.message}`);
  if (result.status !== 0)
    fail(`Husky initialization failed with exit code ${result.status}`);
}

export function configureHusky(root) {
  const packagePath = resolve(root, "package.json");
  let pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const manager = detectPackageManager(root);
  const hasHusky = Boolean(
    pkg.dependencies?.husky || pkg.devDependencies?.husky,
  );
  if (!hasHusky) installHusky(root, manager);
  else if (
    manager !== "yarn" &&
    !existsSync(resolve(root, "node_modules/.bin/husky"))
  ) {
    fail(
      "Husky is declared but not installed; run the locked dependency install, then rerun setup",
    );
  }
  pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const scriptName = addHuskyScript(pkg, manager);
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  runLifecycle(root, manager, scriptName);
  console.log(
    `Parallel Slices Husky configured through the root ${scriptName} script`,
  );
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    configureHusky(resolve(process.argv[2] || "."));
  } catch (error) {
    console.error(`HUSKY SETUP FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
