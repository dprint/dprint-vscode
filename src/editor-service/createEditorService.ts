import { EditorService } from "./EditorService";
import { EditorService2, EditorService3 } from "./implementations";

export function createEditorService(schemaVersion: number): EditorService {
    switch (schemaVersion) {
        case 2:
            return new EditorService2();
        case 3:
            return new EditorService3();
    }

    if (schemaVersion > 2) {
        throw new Error(
            "Please upgrade your editor extension to be compatible with the installed version of dprint.",
        );
    } else {
        throw new Error("Your installed version of dprint is out of date. Please update it.");
    }
}
