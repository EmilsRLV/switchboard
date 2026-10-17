import { describe, expect, it } from "vitest";
import { addFolderLabel, elsewhereName } from "./ElsewhereTray";

describe("Elsewhere tray rows", () => {
  it("name a row by its session name, else (blank or missing) by its id", () => {
    expect(elsewhereName({ name: "ai-b9", session_id: "0bec" })).toBe("ai-b9");
    expect(elsewhereName({ name: "   ", session_id: "0bec" })).toBe("0bec");
    expect(elsewhereName({ name: null, session_id: "0bec" })).toBe("0bec");
  });

  it("label each Add folder button with its folder and session", () => {
    expect(addFolderLabel({ name: "ai-b9", session_id: "0bec", cwd: "C:\\work\\other" })).toBe("Add folder C:\\work\\other for ai-b9");
    expect(addFolderLabel({ name: null, session_id: "0bec", cwd: "/work/other" })).toBe("Add folder /work/other for 0bec");
    const long = "C:\\Users\\emils\\Documents\\Novels\\Sage of Dreams\\drafts\\chapter-one";
    expect(addFolderLabel({ name: "x", session_id: "s", cwd: long })).toMatch(/^Add folder C:\\…\\.*chapter-one for x$/);
  });
});
