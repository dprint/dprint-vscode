import { DprintExecutable } from "../executable";
import { Logger } from "../logger";
import { EditorService } from "./EditorService";
import { EditorService4 as EditorService4 } from "./implementations";

export function createEditorService(
  schemaVersion: number,
  logger: Logger,
  dprintExecutable: DprintExecutable,
): EditorService {
  const currentSchemaVersion = 4;
  switch (schemaVersion) {
    case currentSchemaVersion:
      return new EditorService4(logger, dprintExecutable);
  }

  if (schemaVersion > currentSchemaVersion) {
    throw new Error(
      "Please upgrade your editor extension to be compatible with the installed version of dprint.",
    );
  } else {
    throw new Error(
      "Your installed version of dprint is out of date. Apologies, but please update to the latest version.",
    );
  }
}
