import { Readable } from "stream";
import { unpackStream } from "./Unpack";
import * as chai from "chai";
import { expect } from "chai";
import * as chaiAsPromised from "chai-as-promised";
import { FileSet } from "../core/FileSet";

chai.use(chaiAsPromised);

describe("Unpack", () => {
  it("tar.gz", async () => {
    const input = Buffer.from(
      `H4sICKfHJGYAA3Rlc3QudGFyAO2UzY6bMBDHc85ToBz2VJuvAKs97aFSLz30CVI54A1OwFges2pU
        7bvXNiQBmranVdVqfgcMM/P3jMeTKFae2IHTI3Ry9U5EljzfujUusmi6OpI4z1fxNo8tebS1cXGa
        5OkqiN6roCk9GKaDYCVP/Cw5/DLuT/5/lO/rINhI1vLNU7B5fmF7HbrH5oOzv3INopPOFdF4sDWi
        5BJ8+Kcvn0lKI9Jp0jDDR1HdtVzZkXIRtTEKnsLwIEzd72nZteE1xRGGeCi1UAZsuKvFGva9aCqn
        NlD6EGszHIwzHd062hohvY2DewtAX6P9CaxHdhX/2nZV33AI6V7I0ABxRhccClnxb9TARVWJIceZ
        aRn4IoKHh8B/ufTXD5/XSt58+RVX3G4kS8EnZyjr7iQq5qvYpTSj6SWLErYLzJS1dyU0HRvrDsk0
        AaM5a0dZTIuLr5dWV3GidKe4NkOyzS72+kkxrx/v1vNszsr2oKyZ8LrtNO/ESRi4FK0A7q9gV9gi
        Hu8FQr8Hbq5FpIuY43hhu6SgWxotvO4OBmlB7WQlC/fPPVpucKdVywp+07HFbn4AyTBG4bAQ1fQH
        4Sd/l9E4WjZrJlFMA9d3YmftzqfWu32e6eYNzm81D0m9/ZEWSzspO/kiDnZzbuyZ9RiX3eLmN3Md
        sJkgsYLbWAKZaiadHn9NxI7dWOdkWG59GluQ0cxP6vpt/bf/9RAEQRAEQRAEQRAEQRAEQRAEQRAE
        QRAEQf4ffgC7sbEGACgAAA==`,
      "base64"
    );

    const ins = Readable.from(input);
    const result = await unpackStream(ins, "/tmp");
    expect(result.size).to.equal(1);
    const file = await result.get("package.json");
    console.log(file);
    expect(file?.hash).to.equal("ff344d6ce0cb6497bcc78b026420dee7538870af60809bab61e9a2e83b70a287");
  });
});
