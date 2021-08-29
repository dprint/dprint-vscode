import { DprintExecutable } from "../executable";
import { Logger } from "../logger";
import { EditorService } from "./EditorService";
import { EditorService2, EditorService3 } from "./implementations";

export function createEditorService(
  schemaVersion: number,
  logger: Logger,
  dprintExecutable: DprintExecutable,
): EditorService {
  switch (schemaVersion) {
    case 2:
      return new EditorService2(logger, dprintExecutable);
    case 3:
      return new EditorService3(logger, dprintExecutable);
  }

  if (schemaVersion > 2) {
    throw new Error(
      "Please upgrade your editor extension to be compatible with the installed version of dprint.",
    );
  } else {
    throw new Error("Your installed version of dprint is out of date. Please update it.");
  }
}
