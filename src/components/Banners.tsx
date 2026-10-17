import { selectBanners, useSettingsStore } from "../state/settings";
import { selectStatusBanners, useStatusStore } from "../state/status";
import { useUiStore } from "../state/ui";
import { mergeBanners, selectWorkspaceBanners, useWorkspaceStore } from "../state/workspace";

/**
 * The ambient attention strip across the top. Banners come straight from the settings and
 * workspace snapshots (settings first, then workspace, then the git-status mirror) and
 * vanish when their cause does (file fixed, binary found, viewport written); nothing to
 * dismiss. Ids are prefixed per module (`settings.*`, `workspace.*`, `status.*`,
 * `<binary>.*`), so the merged list has no key clashes. Last comes the transient notice
 * (`ui.notice`: a stub saying what it will do, an action saying why it could not run), a
 * muted row without the accent: information, not attention.
 */
export function Banners() {
  const settingsBanners = useSettingsStore(selectBanners);
  const workspaceBanners = useWorkspaceStore(selectWorkspaceBanners);
  const statusBanners = useStatusStore(selectStatusBanners);
  const notice = useUiStore((s) => s.notice);
  const banners = mergeBanners(mergeBanners(settingsBanners, workspaceBanners), statusBanners);
  if (banners.length === 0 && notice === null) return null;
  return (
    <div className="banners" role="status" aria-live="polite">
      {banners.map((banner) => (
        <div key={banner.id} className="banner">
          <span className="banner-mark" aria-hidden="true" />
          <span className="banner-text">{banner.text}</span>
        </div>
      ))}
      {notice !== null && (
        <div key="ui.notice" className="banner is-notice">
          <span className="banner-mark" aria-hidden="true" />
          <span className="banner-text">{notice.text}</span>
        </div>
      )}
    </div>
  );
}
