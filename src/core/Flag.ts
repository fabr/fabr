import { Name } from "../model/Name";
import { Computable } from "./Computable";
import { EMPTY_FILESET, FileSet, FileSource, IFile } from "./FileSet";

/**
 * A Flag is a special target that has no contents and exists purely as a named marker.
 */
export class Flag implements FileSource {
  public name: string;
  public provides: Flag[];

  constructor(name: string, provides: Flag[]) {
    this.name = name;
    this.provides = provides;
  }

  find(name: Name): Computable<FileSet> {
    return Computable.resolve(EMPTY_FILESET);
  }
  get(name: string): Computable<IFile | undefined> {
    return Computable.resolve(undefined);
  }
}
