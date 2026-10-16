import { selectBanners, useSettingsStore } from "../state/settings";

/**
 * The ambient attention strip across the top. Banners come straight from the settings
 * snapshot and vanish when their cause does (file fixed, binary found); nothing to dismiss.
 */
export function Banners() {
  const banners = useSettingsStore(selectBanners);
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
