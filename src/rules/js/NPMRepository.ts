import { Computable } from "../../core/Computable";
import { fetchUrl, openUrlStream } from "../../core/Fetch";
import { FileSet, FileSource } from "../../core/FileSet";
import { TargetContext } from "../../model/BuildContext";
import { Name } from "../../model/Name";
import { unpackStream } from "../../support/Unpack";
import { registerTargetRule } from "../Registry";

interface ISignature {
  keyid: string;
  sig: string;
}
interface INPMPackageMetadata {
  dependencies: Record<string, string>;
  dist: {
    fileCount?: number;
    integrity: string;
    "npm-signature"?: string;
    shasum: string;
    signatures: ISignature[];
    tarball: string;
    unpackedSize?: number;
  };
  name: string;
  version: string;
  license: string;
  typings?: string;
  types?: string;
  /* and potentially lots of other stuff that we don't need */
}

interface INPMPackageVersions {
  name: string;
  description: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, INPMPackageMetadata>;
  license: string;
}

interface INPMError {
  code: string;
  message: string;
}

interface INPMError2 {
  error: string;
}

type INPMResponse = INPMError | INPMError2 | INPMPackageVersions | INPMPackageMetadata;

class NPMRepository implements FileSource {
  private url: string;
  private context: TargetContext;

  constructor(url: string, context: TargetContext) {
    this.url = url.replace(/\/+$/, "");
    this.context = context;
  }

  public find(name: Name): Computable<FileSet> {
    const prefix = name.getLiteralPathPrefix();
    const bits = prefix.replace(":", "/");
    return this.context.getCachedOrBuild(this.url + bits, targetDir => {
      return fetchUrl(this.url + "/" + bits).then(data => {
        const response = JSON.parse(data.toString()) as INPMResponse;
        if ("error" in response) {
          if (response.error === "Not Found") {
            throw new Error(`${prefix} not found in NPM repository`);
          } else {
            throw new Error(`NPM respository error on '${prefix}: ${response.error}`);
          }
        } else if ("code" in response) {
          throw new Error(`NPM respository error on '${prefix}': ${response.message}`);
        } else if ("versions" in response) {
          /* We've got a package with no version */
          throw new Error(`Name does not match a a package`);
        } else {
          /* Ok we've got an actual package */
          const tarball = response.dist.tarball;
          return openUrlStream(tarball)
            .then(ins => unpackStream(ins, targetDir))
            .then(fs => remapFilenames(fs, response.name));
        }
      });
    });
  }

  public get(name: string): Computable<undefined> {
    return Computable.resolve(undefined);
  }
}

function createRepository(context: TargetContext): Computable<NPMRepository> {
  return context.getRequiredString("url").then(url => new NPMRepository(url, context));
}

function remapFilenames(files: FileSet, packageName: string): FileSet {
  return files.remap(name => {
    const idx = name.indexOf("/");
    if (idx !== -1) {
      return packageName + name.substring(idx);
    } else {
      return undefined;
    }
  });
}

registerTargetRule("npm_repository", {}, createRepository);
