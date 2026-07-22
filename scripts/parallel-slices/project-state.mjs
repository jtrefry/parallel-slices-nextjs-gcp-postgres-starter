#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readArchitectureProfile } from "./architecture-profile.mjs";

export const projectStages = [
  "initialization-required",
  "contract-ready",
  "foundation-ready",
];

export function requiredProjectDocuments(root = process.cwd()) {
  return readArchitectureProfile(root).projectDocuments;
}

export function hasInitializationMarker(content) {
  return /Status:\s*INITIALIZATION_REQUIRED/.test(content);
}

function statePath(root) {
  return resolve(root, ".parallel-slices/project-state.json");
}

function validateProjectState(state) {
  if (state?.version !== 1 || !projectStages.includes(state.stage)) {
    throw new Error(
      ".parallel-slices/project-state.json has an invalid version or stage",
    );
  }
  return state;
}

function writeProjectState(root, state) {
  const path = statePath(root);
  const temporary = `${path}.tmp`;
  if (existsSync(temporary)) {
    const existing = lstatSync(temporary);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(
        `refusing unsafe project-state temporary file: ${temporary}`,
      );
    }
    unlinkSync(temporary);
  }
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, path);
}

export function readProjectState(root) {
  const path = statePath(root);
  if (!existsSync(path))
    throw new Error(".parallel-slices/project-state.json is missing");
  return validateProjectState(JSON.parse(readFileSync(path, "utf8")));
}

export function ensureProjectState(root) {
  if (existsSync(statePath(root))) return readProjectState(root);
  const state = { version: 1, stage: "initialization-required" };
  writeProjectState(root, state);
  return state;
}

export function advanceProjectState(root, nextStage) {
  const current = readProjectState(root);
  const currentIndex = projectStages.indexOf(current.stage);
  const nextIndex = projectStages.indexOf(nextStage);
  if (nextIndex < 0) throw new Error(`unknown project stage: ${nextStage}`);
  if (nextIndex < currentIndex) {
    throw new Error(
      `project stage cannot move backward from ${current.stage} to ${nextStage}`,
    );
  }
  if (nextIndex > currentIndex + 1) {
    throw new Error(
      `project stage cannot skip from ${current.stage} to ${nextStage}`,
    );
  }
  if (nextIndex > currentIndex)
    writeProjectState(root, { version: 1, stage: nextStage });
  return { version: 1, stage: nextStage };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  try {
    const command = process.argv[2];
    let state;
    if (command === "ensure" && process.argv.length <= 4) {
      state = ensureProjectState(resolve(process.argv[3] || "."));
    } else if (
      command === "advance" &&
      process.argv[3] &&
      process.argv.length <= 5
    ) {
      state = advanceProjectState(
        resolve(process.argv[4] || "."),
        process.argv[3],
      );
    } else {
      throw new Error(
        "usage: project-state.mjs ensure [root] | advance <stage> [root]",
      );
    }
    console.log(`project stage: ${state.stage}`);
  } catch (error) {
    console.error(`PROJECT STATE ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
