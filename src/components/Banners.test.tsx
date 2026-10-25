import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Banner } from "../ipc";

// A settings snapshot carrying a banner id the frontend has never heard of (Story 9.2's
// `tray.unavailable`): the strip shows any id Rust sends, by its text.
const TRAY_BANNER: Banner = { id: "tray.unavailable", text: "tray unavailable: closing the window quits" };

vi.mock("../state/settings", () => ({
  selectBanners: (state: { banners: Banner[] }) => state.banners,
  useSettingsStore: <T,>(select: (state: { banners: Banner[] }) => T) => select({ banners: [TRAY_BANNER] }),
}));

import { Banners } from "./Banners";

describe("Banners", () => {
  it("renders a banner with an id it does not know", () => {
    const html = renderToStaticMarkup(<Banners />);
    expect(html).toContain('class="banners"');
    expect(html).toContain("tray unavailable: closing the window quits");
  });
});
