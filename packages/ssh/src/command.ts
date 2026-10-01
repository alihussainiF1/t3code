import * as NodeCrypto from "node:crypto";

import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";

const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 60_000;
const MAX_SSH_ERROR_OUTPUT_LENGTH = 4_000;

/**
 * ssh is a real executable everywhere (`ssh.exe` on Windows), so it is always
 * spawned directly — cmd.exe shell mode would re-tokenize arguments such as
 * identity-file paths containing spaces.
 */
const sshCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "ssh.exe" : "ssh";

export const resolveSshCommand = Effect.map(HostProcessPlatform, sshCommandForPlatform);

const encoder = new TextEncoder();

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunSshCommandOptions extends SshAuthOptions {
  /**
   * Leave `StrictHostKeyChecking` to the user's ssh config. Only `ssh -G`
   * needs this, so it reports the configured value rather than ours.
   */
  readonly configHostKeyChecking?: boolean;
  readonly preHostArgs?: ReadonlyArray<string>;
  readonly remoteCommandArgs?: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

export function remoteStateKey(target: DesktopSshEnvironmentTarget): string {
  return NodeCrypto.createHash("sha256")
    .update(targetConnectionKey(target))
    .digest("hex")
    .slice(0, 16);
}

function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export const buildSshHostSpecEffect = (
  target: DesktopSshEnvironmentTarget,
): Effect.Effect<string, SshInvalidTargetError> =>
  Effect.try({
    try: () => buildSshHostSpec(target),
    catch: (cause) =>
      new SshInvalidTargetError({
        message: cause instanceof Error ? cause.message : "SSH target is invalid.",
      }),
  });

/**
 * `StrictHostKeyChecking` per alias as the user's ssh config resolves it,
 * recorded by `resolveSshTarget` from `ssh -G` (which runs before every
 * desktop connect). Command-line `-o` beats ssh config, so this is how an
 * explicit user setting survives our default.
 */
const configuredHostKeyChecking = new Map<string, string>();

export function parseSshStrictHostKeyChecking(stdout: string): string | null {
  const match = /^stricthostkeychecking\s+(\S+)\s*$/imu.exec(stdout);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The app cannot answer ssh's interactive "continue connecting?" prompt, so
 * OpenSSH's default (`ask`) is replaced with `accept-new`: trust a host's key
 * the first time, refuse a key that changed. Any other configured value
 * (`yes`, `no`, `accept-new`) is the user's explicit choice and is kept.
 */
export function hostKeyCheckingArgs(configured: string | null | undefined): string[] {
  return configured === null || configured === undefined || configured === "ask"
    ? ["-o", "StrictHostKeyChecking=accept-new"]
    : [];
}

export function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: {
    readonly batchMode?: "yes" | "no";
    readonly configHostKeyChecking?: boolean;
  },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    ...(input?.configHostKeyChecking
      ? []
      : hostKeyCheckingArgs(configuredHostKeyChecking.get(target.alias.trim()))),
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

/**
 * Turns ssh's host-key refusals into an actionable message. A changed key
 * prints a wall of `@` warnings that otherwise reaches the UI verbatim.
 */
export function describeSshHostKeyFailure(
  stderr: string,
  target: Pick<DesktopSshEnvironmentTarget, "alias" | "hostname" | "port">,
): string | null {
  const destination = target.alias.trim() || target.hostname.trim();
  const knownHostsEntry =
    target.port !== null && target.port !== 22
      ? `[${target.hostname}]:${target.port}`
      : target.hostname;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr)) {
    return `The SSH host key for ${destination} has changed since it was first trusted, so T3 Code refused to connect. This happens when the server is reinstalled, but can also mean the connection is being intercepted. If you expect the change, remove the old key with \`ssh-keygen -R ${knownHostsEntry}\` and reconnect.`;
  }
  if (/Host key verification failed/iu.test(stderr)) {
    return `SSH host key verification failed for ${destination}. Connect once from a terminal with \`ssh ${destination}\` to review and trust its host key, then retry.`;
  }
  return null;
}

export function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

export const collectProcessOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function redactSshErrorOutput(output: string): string {
  const redacted = output.replace(
    /("(?:access_token|bearerToken|credential|pairingToken|token)"\s*:\s*")[^"]+(")/giu,
    "$1[redacted]$2",
  );
  return redacted.length > MAX_SSH_ERROR_OUTPUT_LENGTH
    ? `${redacted.slice(0, MAX_SSH_ERROR_OUTPUT_LENGTH)}\n[truncated]`
    : redacted;
}

function normalizeSshErrorMessage(input: {
  readonly target: DesktopSshEnvironmentTarget;
  readonly stdout?: string;
  readonly stderr: string;
  readonly fallbackMessage: string;
}): string {
  const hostKeyFailure = describeSshHostKeyFailure(input.stderr, input.target);
  if (hostKeyFailure !== null) {
    return hostKeyFailure;
  }
  const cleanedStderr = input.stderr.trim();
  if (cleanedStderr.length > 0) {
    return cleanedStderr;
  }

  const cleanedStdout = input.stdout?.trim() ?? "";
  return cleanedStdout.length > 0 ? cleanedStdout : input.fallbackMessage;
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function stdinStream(input: string | undefined) {
  return input === undefined ? Stream.empty : Stream.make(encoder.encode(input));
}

const runSshCommandInScope = Effect.fn("ssh/command.runSshCommand.inScope")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions,
  commandScope: Scope.Scope,
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const environment = yield* buildSshChildEnvironment({
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(target, {
      batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes"),
      ...(input.configHostKeyChecking ? { configHostKeyChecking: true } : {}),
    }),
    ...(input.preHostArgs ?? []),
    hostSpec,
    ...(input.remoteCommandArgs ?? []),
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sshCommand = yield* resolveSshCommand;
  yield* Effect.logDebug("ssh.command.start", {
    ...sshTargetLogFields(target),
    command: [sshCommand, ...args],
    hasStdin: input.stdin !== undefined,
    timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: environment,
        extendEnv: true,
        stdin: {
          stream: stdinStream(input.stdin),
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, commandScope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: [sshCommand, ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH command for ${hostSpec}.`,
            cause,
          }),
      ),
    );

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectProcessOutput(child.stdout),
      collectProcessOutput(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    const diagnosticStdout = redactSshErrorOutput(stdout);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
    });
    return yield* new SshCommandError({
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
      message: normalizeSshErrorMessage({
        target,
        stdout: diagnosticStdout,
        stderr,
        fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
      }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: ["ssh", ...args],
  });
  return { stdout, stderr };
});

export const runSshCommand = Effect.fn("ssh/command.runSshCommand")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions = {},
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return yield* Effect.scopedWith((commandScope) =>
    runSshCommandInScope(target, input, commandScope),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ssh.command.timedOut", {
              ...sshTargetLogFields(target),
              timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
              remoteCommandArgs: input.remoteCommandArgs ?? [],
              preHostArgs: input.preHostArgs ?? [],
              hasStdin: input.stdin !== undefined,
            });
            return yield* new SshCommandError({
              command: ["ssh"],
              exitCode: null,
              stderr: "",
              message: `SSH command timed out after ${input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS}ms.`,
            });
          }),
      }),
    ),
  );
});

export const resolveSshTarget = Effect.fn("ssh/command.resolveSshTarget")(function* (
  alias: string,
): Effect.fn.Return<
  DesktopSshEnvironmentTarget,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    return yield* new SshInvalidTargetError({ message: "SSH host alias is required." });
  }

  yield* Effect.logDebug("ssh.target.resolve.start", { alias: trimmedAlias });
  return yield* runSshCommand(
    {
      alias: trimmedAlias,
      hostname: trimmedAlias,
      username: null,
      port: null,
    },
    { preHostArgs: ["-G"], configHostKeyChecking: true },
  ).pipe(
    Effect.map((result) => {
      const configured = parseSshStrictHostKeyChecking(result.stdout);
      if (configured === null) {
        configuredHostKeyChecking.delete(trimmedAlias);
      } else {
        configuredHostKeyChecking.set(trimmedAlias, configured);
      }
      return parseSshResolveOutput(trimmedAlias, result.stdout);
    }),
    Effect.tap((target) =>
      Effect.logDebug("ssh.target.resolve.succeeded", sshTargetLogFields(target)),
    ),
    Effect.catch((cause) =>
      Effect.logDebug("ssh.target.resolve.fallback", { alias: trimmedAlias, cause }).pipe(
        Effect.as({
          alias: trimmedAlias,
          hostname: trimmedAlias,
          username: null,
          port: null,
        }),
      ),
    ),
  );
});
