import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "./i18n";

afterEach(() => setLang("en"));

describe("workflow operation labels", () => {
  it("translates Spanish proposal operation counts and detail labels", () => {
    setLang("es");

    expect(
      `${1} ${t("workflow.create")}, ${2} ${t("workflow.edit")}, ${3} ${t("workflow.move")}.`,
    ).toBe("1 crear, 2 editar, 3 mover.");
    expect(`${t("workflow.create")}: wiki/new.md`).toBe("crear: wiki/new.md");
    expect(`${t("workflow.edit")}: wiki/existing.md`).toBe(
      "editar: wiki/existing.md",
    );
    expect(`${t("workflow.move")}: raw/source.md`).toBe("mover: raw/source.md");
  });
});

describe("configured integration labels", () => {
  it("uses the expected Spanish connected and key guidance copy", () => {
    setLang("es");

    expect(t("status.connected")).toBe("conectado");
    expect(t("ph.keySaved")).toBe(
      "clave configurada ✓: pega otra + Enter para cambiarla",
    );
  });
});
