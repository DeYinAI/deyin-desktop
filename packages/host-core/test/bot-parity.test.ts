import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ENUMS, SHAPES, SURFACES } from "./parity/table.js";
import { BEGIN_MARKER, END_MARKER, STATUS_LABEL, ourValue, renderParityBlock } from "./parity/render.js";
import {
  RECOVERED_ENUM_COUNT,
  RECOVERED_SHAPE_COUNT,
  REPO_ROOT,
  recoveredEnumValues,
  recoveredFieldNames,
  recoveredShapeNames,
} from "./parity/recovered.js";

const DOC = join(REPO_ROOT, "docs/PARITY-GROK-BOT.md");

describe("recovered fixtures", () => {
  it("are the whole recovered contract, not a trimmed copy", () => {
    assert.equal(RECOVERED_ENUM_COUNT, 414);
    assert.equal(RECOVERED_SHAPE_COUNT, 2928);
    assert.equal(recoveredShapeNames("GrokBot").length, 397);
  });
});

describe("enum parity", () => {
  for (const entry of ENUMS) {
    describe(entry.recovered, () => {
      const recovered = recoveredEnumValues(entry.recovered);
      const absent = entry.absent ?? {};

      it("every Deyin value is the recovered value it stands for, in the recovered order", () => {
        const expected = recovered.filter((value) => !(value in absent)).map((value) => ourValue(entry, value));
        assert.deepEqual([...entry.ours], expected);
      });

      it("names only values that exist in the recovered enum", () => {
        for (const value of [...Object.keys(entry.rename ?? {}), ...Object.keys(absent)]) {
          assert.ok(recovered.includes(value), `${entry.recovered} has no value ${value}`);
        }
      });

      it("states why when a value was renamed or left out", () => {
        const renamed = Object.keys(entry.rename ?? {}).length > 0 || Object.keys(absent).length > 0;
        if (renamed) assert.ok(entry.note || Object.keys(absent).length > 0, `${entry.recovered} differs without a note`);
      });
    });
  }

  it("covers each recovered Bot enum the product depends on", () => {
    const covered = new Set(ENUMS.map((entry) => entry.recovered));
    for (const name of [
      "GrokBotApprovalMode",
      "GrokBotToolPermission",
      "GrokBotVaultItemKind",
      "GrokBotAgentKind",
      "GrokBotAgentVisibility",
      "GrokBotAgentHarnessKind",
      "GrokBotAgentFileStore",
      "GrokBotSkillRevisionAuthor",
    ]) {
      assert.ok(covered.has(name), `${name} is not in the parity table`);
    }
  });
});

describe("shape parity", () => {
  for (const shape of SHAPES) {
    describe(shape.recovered, () => {
      const recovered = recoveredFieldNames(shape.recovered);
      const answered = Object.keys(shape.fields);
      const mappedKeys = new Set(
        Object.values(shape.fields).flatMap((answer) => ("ours" in answer ? [answer.ours as string] : [])),
      );

      it("answers every field of the recovered message", () => {
        const unanswered = recovered.filter((field) => !(field in shape.fields));
        assert.deepEqual(unanswered, [], `${shape.recovered} has fields nobody classified`);
      });

      it("answers no field the recovered message does not have", () => {
        assert.deepEqual(
          answered.filter((field) => !recovered.includes(field)),
          [],
        );
      });

      it("maps only to keys of the Deyin type", () => {
        for (const key of mappedKeys) assert.ok(key in shape.allKeys, `${shape.oursName} has no key ${key}`);
        for (const key of shape.additions) assert.ok(key in shape.allKeys, `${shape.oursName} has no key ${key}`);
      });

      it("places every key of the Deyin type: mapped to a recovered field or listed as an addition", () => {
        const placed = new Set<string>([...mappedKeys, ...shape.additions]);
        const unplaced = Object.keys(shape.allKeys).filter((key) => !placed.has(key));
        assert.deepEqual(unplaced, [], `${shape.oursName} has keys that are neither mapped nor listed as additions`);
      });

      it("lists an addition only when no recovered field maps to it", () => {
        for (const key of shape.additions) assert.ok(!mappedKeys.has(key), `${key} is both mapped and an addition`);
      });

      it("explains every gap", () => {
        for (const [field, answer] of Object.entries(shape.fields)) {
          if ("gap" in answer) assert.ok(answer.why.trim().length > 0, `${field} has a gap without a reason`);
        }
      });
    });
  }
});

describe("surfaces", () => {
  it("each name appears once", () => {
    const names = SURFACES.map((row) => row.surface);
    assert.equal(new Set(names).size, names.length);
  });

  it("a Done or Foundation surface points at files that exist", () => {
    for (const row of SURFACES) {
      if (row.status !== "done" && row.status !== "foundation") continue;
      assert.ok(row.evidence.length > 0, `${row.surface} claims to exist but names no file`);
    }
  });

  it("every named file exists", () => {
    for (const row of SURFACES) {
      for (const path of row.evidence) {
        const full = join(REPO_ROOT, path);
        assert.ok(existsSync(full) && statSync(full).isFile(), `${row.surface}: ${path} is not a file`);
      }
    }
  });

  it("a surface that is not built names no file, so the table cannot claim code that is not there", () => {
    for (const row of SURFACES.filter((candidate) => candidate.status === "not-built")) {
      assert.deepEqual(row.evidence, [], row.surface);
    }
  });

  it("anything short of Done says why", () => {
    for (const row of SURFACES) {
      if (row.status === "done") continue;
      assert.ok(row.note.trim().length > 0, `${row.surface} is ${STATUS_LABEL[row.status]} without a note`);
    }
  });

  it("every outward adapter is Foundation until it has run against the real service", () => {
    const adapters = SURFACES.filter((row) => /Slack|Microsoft Teams|@mentions|Email into/.test(row.surface));
    assert.equal(adapters.length, 4);
    for (const row of adapters) assert.equal(row.status, "foundation", row.surface);
  });
});

describe("docs/PARITY-GROK-BOT.md", () => {
  const doc = readFileSync(DOC, "utf8");

  it("holds exactly the tables the code produces (run test/parity/write.ts to refresh)", () => {
    const start = doc.indexOf(BEGIN_MARKER);
    const end = doc.indexOf(END_MARKER);
    assert.ok(start !== -1 && end > start, "markers missing");
    assert.equal(doc.slice(start, end + END_MARKER.length), renderParityBlock());
  });

  it("has no field left unclassified", () => {
    assert.ok(!doc.includes("unclassified"));
  });

  it("says where the recovered contract came from and that nothing was copied", () => {
    assert.match(doc, /docs\/rea\/grok-bot-1\.2\.3/);
    assert.match(doc, /no Grok Bot source/i);
  });
});
