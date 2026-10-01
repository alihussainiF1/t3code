import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Mode for files that hold settings, state, or credentials. */
export const OWNER_ONLY_FILE_MODE = 0o600;
/** Mode for directories T3 owns outright, such as the userdata state directory. */
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Clears group and other access from a path T3 owns when it has any, so other
 * local users cannot read state or secrets. Missing paths are skipped. Failures
 * only log: a path owned by another user must not stop the server. No-op on
 * Windows, where POSIX modes do not describe access.
 */
export const restrictToOwner = (path: string, mode: number) =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    if ((info.mode & 0o077) === 0) return;
    yield* fs.chmod(path, mode);
  }).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.void
        : Effect.logWarning("could not restrict permissions to the owner", { path, cause }),
    ),
  );

/**
 * Creates the file empty with owner-only access when it does not exist yet, so
 * whatever writes it next (SQLite, for one) starts from a private file instead
 * of the umask default. An existing file is only tightened.
 */
export const ensureOwnerOnlyFile = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.scoped(fs.open(path, { flag: "a", mode: OWNER_ONLY_FILE_MODE })).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("could not create a private file", { path, cause }),
      ),
    );
    yield* restrictToOwner(path, OWNER_ONLY_FILE_MODE);
  });
