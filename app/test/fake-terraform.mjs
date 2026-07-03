#!/usr/bin/env node
/**
 * fake-terraform.mjs
 *
 * A scripted stand-in for the real terraform binary, used by the
 * integration test tier (and any orchestrator unit tests) to exercise
 * TerraformService against realistic stdout/stderr without shelling out
 * to real terraform or touching real AWS.
 *
 * Usage:
 *   FAKE_TERRAFORM_SCRIPT=/path/to/fixture.json node app/test/fake-terraform.mjs plan -out=tfplan
 *
 * The subcommand is whatever TerraformService would invoke terraform
 * with — e.g. init, plan, apply, destroy, output. Any extra CLI args
 * (-out=tfplan, -auto-approve, etc.) are accepted but ignored; this
 * script only cares about the subcommand name to look up the scripted
 * response.
 *
 * Fixture JSON shape is a plain object keyed by subcommand name, e.g.:
 *
 *   \{
 *     "plan": \{
 *       "exitCode": 0,
 *       "lines": [
 *         \{ "stream": "stdout", "text": "Refreshing state...", "delayMs": 10 \},
 *         \{ "stream": "stderr", "text": "Warning: deprecated argument", "delayMs": 5 \},
 *         \{ "stream": "stdout", "text": "Plan: 1 to add, 0 to change, 0 to destroy." \}
 *       ]
 *     \}
 *   \}
 *
 * "lines" is emitted strictly in array order regardless of which stream
 * each line targets, so callers can script realistic interleaving of
 * stdout/stderr. "delayMs" (default 0) is awaited immediately before that
 * line is written, so callers can simulate realistic terraform timing.
 * "exitCode" (default 0) is the process exit code once every line has
 * been written.
 */

import { readFileSync } from 'node:fs';

/** Subcommand names TerraformService is documented to invoke. */
const KNOWN_SUBCOMMANDS = ['init', 'plan', 'apply', 'destroy', 'output'];

/**
 * Writes a single fatal error message to stderr, prefixed for easy
 * identification in test failure output, and exits the process.
 *
 * @param message - Human-readable description of what went wrong.
 * @param exitCode - Process exit code, defaults to 1.
 */
function fail(message, exitCode = 1) {
  process.stderr.write(`fake-terraform: ${message}\n`);
  process.exit(exitCode);
}

/**
 * Sleeps for the given number of milliseconds.
 *
 * @param ms - Duration to sleep in milliseconds.
 * @returns A promise that resolves once the delay has elapsed.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Loads and parses the fixture JSON pointed at by FAKE_TERRAFORM_SCRIPT.
 * Exits the process with a clear stderr message on any failure (missing
 * env var, unreadable file, invalid JSON).
 *
 * @returns The resolved fixture path and its parsed contents.
 */
function loadFixture() {
  const scriptPath = process.env.FAKE_TERRAFORM_SCRIPT;
  if (!scriptPath) {
    fail(
      'FAKE_TERRAFORM_SCRIPT env var is not set. Point it at a JSON fixture file describing the scripted terraform output.',
    );
  }

  let raw;
  try {
    raw = readFileSync(scriptPath, 'utf8');
  } catch (err) {
    fail(`could not read fixture file at "${scriptPath}": ${err.message}`);
  }

  let fixture;
  try {
    fixture = JSON.parse(raw);
  } catch (err) {
    fail(`fixture file at "${scriptPath}" is not valid JSON: ${err.message}`);
  }

  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
    fail(`fixture file at "${scriptPath}" must contain a JSON object keyed by subcommand.`);
  }

  return { scriptPath, fixture };
}

/**
 * Emits every scripted line for the given subcommand entry, honoring each
 * line's delay and target stream, then resolves once all lines have been
 * written.
 *
 * @param entry - The scripted response for the invoked subcommand. Its
 *   "lines" array holds objects with "stream" ("stdout" or "stderr"),
 *   "text", and an optional "delayMs".
 */
async function emitLines(entry) {
  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  for (const line of lines) {
    const delayMs = typeof line.delayMs === 'number' ? line.delayMs : 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const stream = line.stream === 'stderr' ? process.stderr : process.stdout;
    stream.write(`${line.text}\n`);
  }
}

/**
 * Entry point: resolves the requested subcommand against the scripted
 * fixture and replays its stdout/stderr lines before exiting with the
 * scripted exit code.
 */
async function main() {
  const { scriptPath, fixture } = loadFixture();

  const subcommand = process.argv[2];
  if (!subcommand) {
    fail('no subcommand provided. Expected one of: ' + KNOWN_SUBCOMMANDS.join(', '));
  }

  const entry = fixture[subcommand];
  if (!entry || typeof entry !== 'object') {
    const scripted = Object.keys(fixture);
    fail(
      `no scripted response for subcommand "${subcommand}" in fixture "${scriptPath}". ` +
        `Scripted subcommands: ${scripted.length > 0 ? scripted.join(', ') : '(none)'}`,
    );
  }

  await emitLines(entry);

  const exitCode = typeof entry.exitCode === 'number' ? entry.exitCode : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  fail(`unexpected error: ${err.stack ?? err.message}`);
});
