import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app";

describe("app store", () => {
  beforeEach(() => {
    useAppStore.setState({ appInfo: null });
  });

  it("starts with no app info", () => {
    expect(useAppStore.getState().appInfo).toBeNull();
  });

  it("setAppInfo stores the info reported by Rust", () => {
    useAppStore.getState().setAppInfo({ name: "switchboard", version: "0.1.0" });
    expect(useAppStore.getState().appInfo).toEqual({ name: "switchboard", version: "0.1.0" });
  });

  it("setAppInfo(null) clears it again", () => {
    useAppStore.getState().setAppInfo({ name: "switchboard", version: "0.1.0" });
    useAppStore.getState().setAppInfo(null);
    expect(useAppStore.getState().appInfo).toBeNull();
  });
});
