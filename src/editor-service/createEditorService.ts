import { DprintExecutable } from "../executable";
import { Logger } from "../logger";
import { EditorService } from "./EditorService";
import { EditorService4, EditorService5 } from "./implementations";

export function createEditorService(
  schemaVersion: number,
  logger: Logger,
  dprintExecutable: DprintExecutable,
): EditorService {
  switch (schemaVersion) {
    case 4:
      return new EditorService4(logger, dprintExecutable);
    case 5:
      return new EditorService5(logger, dprintExecutable);
  }

  if (schemaVersion > 5) {
    throw new Error(
      "Please upgrade your editor extension to be compatible with the installed version of dprint.",
    );
  } else {
    throw new Error(
      "Your installed version of dprint is out of date. Sorry, it's too much for me to maintain support. Please upgrade it.",
    );
  }
}
