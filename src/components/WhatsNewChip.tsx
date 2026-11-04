import { commandHint } from "../commands/keybindings";
import { runCommand } from "../commands/registry";
import { useWhatsNewStore, type WhatsNewState } from "../state/whatsNew";

/** The chip itself: `new in <version>`, which runs `help.whatsNew` (Help → Changelog). */
export function WhatsNewChipView({ version }: { version: string }) {
  return (
    <button
      type="button"
      className="corner-chip whats-new-chip"
      title={commandHint("help.whatsNew", "Open the changelog")}
      onClick={() => runCommand("help.whatsNew")}
    >
      new in {version}
    </button>
  );
}

/**
 * What's new after an update (Story 10.5): a muted chip at the canvas's bottom-left, beside the
 * Elsewhere chip, while the running version differs from the one last seen. It goes once the
 * Changelog is opened, by any route. No accent, no motion, no OS notification.
 */
export function WhatsNewChip() {
  const version = useWhatsNewStore(chipVersion);
  return version === null ? null : <WhatsNewChipView version={version} />;
}

/** The version the chip names, or `null` when it does not show. */
export function chipVersion(s: Pick<WhatsNewState, "show" | "version">): string | null {
  return s.show ? s.version : null;
}
