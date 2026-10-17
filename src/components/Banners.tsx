import { selectBanners, useSettingsStore } from "../state/settings";
import { selectStatusBanners, useStatusStore } from "../state/status";
import { mergeBanners, selectWorkspaceBanners, useWorkspaceStore } from "../state/workspace";

/**
 * The ambient attention strip across the top. Banners come straight from the settings and
 * workspace snapshots (settings first, then workspace, then the git-status mirror) and
 * vanish when their cause does (file fixed, binary found, viewport written); nothing to
 * dismiss. Ids are prefixed per module (`settings.*`, `workspace.*`, `status.*`,
 * `<binary>.*`), so the merged list has no key clashes. The strip stops at 30vh and scrolls;
 * long text wraps. The transient notice is not here: it lies over the canvas (`Notice`), so it
 * never resizes the canvas.
 */
export function Banners() {
  const settingsBanners = useSettingsStore(selectBanners);
  const workspaceBanners = useWorkspaceStore(selectWorkspaceBanners);
  const statusBanners = useStatusStore(selectStatusBanners);
  const banners = mergeBanners(mergeBanners(settingsBanners, workspaceBanners), statusBanners);
  if (banners.length === 0) return null;
  return (
    <div className="banners" role="status" aria-live="polite">
      {banners.map((banner) => (
        <div key={banner.id} className="banner">
          <span className="banner-mark" aria-hidden="true" />
          <span className="banner-text">{banner.text}</span>
        </div>
      ))}
    </div>
  );
}
