import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  /** Applied to the file before it replaces the target, so it is never visible with a looser mode. */
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      if (input.mode === undefined) {
        yield* fs.writeFileString(tempPath, input.contents);
      } else {
        yield* fs.writeFileString(tempPath, input.contents, { mode: input.mode });
        // The create mode is masked by the umask; chmod sets it exactly.
        yield* fs.chmod(tempPath, input.mode);
      }
      yield* fs.rename(tempPath, input.filePath);
    }),
  );
