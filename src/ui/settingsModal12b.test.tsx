// SettingsModal Phase 12b: the time mean velocity toggle renders and
// reflects the persisted preference.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal from "./SettingsModal";
import { DEFAULT_DISPLAY_PREFS } from "@/contracts/types";

const noop = () => {};

function render(meanFields: boolean) {
    return renderToStaticMarkup(
        <SettingsModal
            open={true}
            onClose={noop}
            prefs={{ ...DEFAULT_DISPLAY_PREFS, meanFields }}
            onPatch={noop}
            gridMode="auto"
            activeGrid={256}
            onGridMode={noop}
        />,
    );
}

describe("SettingsModal mean fields", () => {
    it("renders the time mean velocity toggle unchecked by default", () => {
        const html = render(false);
        expect(html).toContain("Time mean velocity fields");
        expect(html).toContain('id="settingsMeanFields"');
    });

    it("checks the toggle when mean fields are on", () => {
        const html = render(true);
        const at = html.indexOf('id="settingsMeanFields"');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(at, at + 160)).toContain("checked");
    });

    it("leaves the toggle unchecked when mean fields are off", () => {
        const html = render(false);
        const at = html.indexOf('id="settingsMeanFields"');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(at, at + 160)).not.toContain("checked");
    });
});
