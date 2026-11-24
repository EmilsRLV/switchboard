import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "../commands/builtins";
import { clearCommands } from "../commands/registry";
import { PROMPT_HINT, usePaletteStore } from "../state/palette";
import { Palette, paletteKeyDown } from "./Palette";

describe("the palette as a text prompt (Story 12.3)", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltins();
    usePaletteStore.setState({ isOpen: false, pick: null, prompt: null, query: "", selected: 0 });
  });
  afterEach(() => {
    usePaletteStore.setState({ isOpen: false, pick: null, prompt: null, query: "", selected: 0 });
    clearCommands();
  });

  it("starts holding the prompt's text, and Enter hands what was typed to onSubmit", () => {
    const submitted: string[] = [];
    usePaletteStore.getState().openPrompt({ placeholder: "Group label", initial: "web", onSubmit: (text) => submitted.push(text) });
    // The input's `value` is the store's query (a static render reads zustand's initial state, so
    // the binding is checked through the store).
    expect(usePaletteStore.getState().query).toBe("web");
    expect(PROMPT_HINT).toBe("Enter to confirm · Esc to cancel");

    // Typing is the input's onChange (`setQuery`); then Enter in the input.
    usePaletteStore.getState().setQuery("site");
    let prevented = false;
    paletteKeyDown({ key: "Enter", preventDefault: () => (prevented = true) }, [], 0);
    expect(prevented).toBe(true);
    expect(submitted).toEqual(["site"]);
    expect(usePaletteStore.getState().isOpen).toBe(false);
    expect(renderToStaticMarkup(<Palette />)).toBe("");
  });

  it("a key that is typing leaves the prompt open with nothing submitted", () => {
    const submitted: string[] = [];
    usePaletteStore.getState().openPrompt({ placeholder: "Group label", initial: "", onSubmit: (text) => submitted.push(text) });
    paletteKeyDown({ key: "a", preventDefault: () => {} }, [], 0);
    expect(submitted).toEqual([]);
    expect(usePaletteStore.getState().prompt).not.toBeNull();
  });
});
