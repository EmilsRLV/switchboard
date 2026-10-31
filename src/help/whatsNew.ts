// What's new after an update (Story 10.5): whether the muted `new in <version>` chip shows.

/**
 * Show the chip when the running version differs from the one last seen -- newer, older or a dev
 * build alike; a missing record (`null`, a profile from before this was kept) counts as a
 * difference. Never on a first run (that profile records the version silently), and never while
 * the running version is unknown.
 */
export function shouldShowWhatsNew(stored: string | null, current: string | null, firstRun: boolean): boolean {
  if (firstRun || current === null || current === "") return false;
  return stored !== current;
}
