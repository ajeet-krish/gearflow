// P2 review minors: nav geometric centering, skip link per route, Theory
// Cp sign, Re wording, KaTeX fallback plus TOC focus/hash, BrandMark
// decorative with no dead WASM badge, favicon explicit fill. Static markup
// plus source pins so the seam gaps stay closed.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import TopNav, { BrandMark } from "./TopNav";
import TheoryPage from "./TheoryPage";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const cssPath = resolve(here, "../styles.css");
const topNavPath = resolve(here, "./TopNav.tsx");
const theoryPath = resolve(here, "./TheoryPage.tsx");
const rootIcon = resolve(here, "../../icon.svg");
const publicIcon = resolve(here, "../../public/icon.svg");

const noop = () => {};

describe("P2 minors: nav 3-zone geometric centering", () => {
    it("pins a 3-zone grid with a truly centered middle zone", async () => {
        const css = await readFile(cssPath, "utf8");
        expect(css).toContain("grid-template-columns: 1fr auto 1fr");
        expect(css).toContain("justify-self: center");
        expect(css).toContain("justify-self: end");
        expect(css).toContain("justify-self: start");
    });

    it("renders brand, centered links, and right cluster zones", () => {
        const html = renderToStaticMarkup(
            <TopNav active="studio" onNav={noop} settingsOpen={false} onOpenSettings={noop} onToggleFocus={noop} />
        );
        const brand = html.indexOf("GearFlow");
        const studio = html.indexOf("STUDIO");
        const full = html.indexOf("FULL SCREEN");
        expect(brand).toBeGreaterThan(-1);
        expect(studio).toBeGreaterThan(brand);
        expect(full).toBeGreaterThan(studio);
    });
});

describe("P2 minors: skip link retargets per route", () => {
    it("points the skip link at the active main content", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain('href={activeNav === "theory" ? "#theory" : "#tunnel"}');
        expect(src).toContain("Skip to theory content");
        expect(src).toContain("Skip to flow canvas");
    });

    it("gives the theory page a matching focusable anchor", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain('id="theory"');
        expect(html).toContain('aria-label="Airfoil theory companion"');
    });
});

describe("P2 minors: Theory copy honesty", () => {
    it("states the suction peak with a negative sign", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("negative 2 to negative 4");
        expect(html).not.toContain("minimum Cp, often 2 to 4");
    });

    it("bands the 50,000 default as transitional, matching the regime band", () => {
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("transitional band");
        expect(html).toContain("50,000 sits in the transitional band");
        expect(html).not.toContain("sits in the laminar regime");
    });
});

describe("P2 minors: KaTeX fallback plus TOC focus and hash", () => {
    it("carries the tex as an accessible label and text fallback", async () => {
        const src = await readFile(theoryPath, "utf8");
        expect(src).toContain("aria-label={tex}");
        expect(src).toContain('role="img"');
        const html = renderToStaticMarkup(<TheoryPage />);
        expect(html).toContain("theoryInlineMath");
        expect(html).toContain("C_l");
    });

    it("moves focus and updates the hash on TOC activation", async () => {
        const src = await readFile(theoryPath, "utf8");
        expect(src).toContain("history.replaceState");
        expect(src).toContain("focus({ preventScroll: true })");
        expect(src).toContain("tabIndex={-1}");
    });
});

describe("P2 minors: BrandMark decorative, no dead WASM badge", () => {
    it("renders the mark decorative with no announcement", () => {
        const html = renderToStaticMarkup(<BrandMark />);
        expect(html).toContain('aria-hidden="true"');
        expect(html).not.toContain("role=\"img\"");
        expect(html).not.toContain("aria-label");
        expect(html).not.toContain("Tsunami/Storm surges");
    });

    it("carries no wasmActive prop or badge in source", async () => {
        const nav = await readFile(topNavPath, "utf8");
        expect(nav).not.toContain("wasmActive");
        expect(nav).not.toContain("wasmBadge");
        expect(nav).not.toContain(">WASM<");
        const app = await readFile(appPath, "utf8");
        expect(app).not.toContain("wasmActive");
    });
});

describe("P2 minors: favicon explicit fill, metadata stripped", () => {
    it("sets the explicit dark fill with rounded geometry in both icons", async () => {
        for (const path of [rootIcon, publicIcon]) {
            const svg = await readFile(path, "utf8");
            expect(svg).toContain('fill="#0d0d12"');
            expect(svg).toContain('fill="#f8f8f2"');
            expect(svg).toContain('rx="7"');
            expect(svg).toContain('stroke="#44475a"');
            expect(svg).not.toContain("SVG Repo");
            expect(svg).not.toContain("<metadata");
            expect(svg).not.toContain("style=\"fill:");
        }
    });
});
