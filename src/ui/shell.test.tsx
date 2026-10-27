// GearFlow shell test: Zenith instrument-room layout pieces render with
// pure presentational props. DOM free via react-dom/server static markup.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TopNav from "./TopNav";
import SolverBar from "./SolverBar";
import FieldBar from "./FieldBar";
import TelemetryBar from "./TelemetryBar";
import AnalysisPanel from "./AnalysisPanel";
import VerticalColorbar from "./VerticalColorbar";

const noop = () => {};

describe("GearFlow shell", () => {
    it("renders a top navbar with the GearFlow wordmark", () => {
        const html = renderToStaticMarkup(
            <TopNav
                offline={false}
                active="studio"
                onNav={noop}
                theme="dark"
                onTheme={noop}
                wasmActive={false}
            />
        );
        expect(html).toContain("GearFlow");
        expect(html).toContain("STUDIO");
        expect(html).toContain("VALIDATE");
        expect(html).toContain("EXPORT");
    });

    it("solver bar contains both a BODY control and an RE control", () => {
        const html = renderToStaticMarkup(
            <SolverBar
                mode="analytic"
                onMode={noop}
                body="naca2412"
                onBody={noop}
                alpha={6}
                onAlpha={noop}
                reynolds={50000}
                onReynolds={noop}
                gridMode="auto"
                onGridMode={noop}
                live={true}
            />
        );
        expect(html).toContain("BODY");
        expect(html).toContain("RE");
        expect(html).toContain("NACA 2412");
    });

    it("field bar contains SPEED, PRESSURE, VORTICITY", () => {
        const html = renderToStaticMarkup(
            <FieldBar
                variable="speed"
                onVariable={noop}
                fieldVisible={true}
                onFieldVisible={noop}
                contours={false}
                onContours={noop}
                particleCount={3000}
                onParticles={noop}
                colormapName="viridis"
            />
        );
        expect(html).toContain("SPEED");
        expect(html).toContain("PRESSURE");
        expect(html).toContain("VORTICITY");
    });

    it("right panel renders all five section labels", () => {
        const html = renderToStaticMarkup(
            <AnalysisPanel
                sections={[
                    { id: "geometry", label: "GEOMETRY", content: <p>geom</p> },
                    { id: "display", label: "DISPLAY", content: <p>disp</p> },
                    { id: "validation", label: "VALIDATION", content: <p>val</p> },
                    { id: "eval", label: "EVAL LEDGER", content: <p>eval</p> },
                    { id: "export", label: "EXPORT", content: <p>exp</p> },
                ]}
                open={new Set(["geometry", "display"])}
                onToggle={noop}
            />
        );
        for (const label of ["GEOMETRY", "DISPLAY", "VALIDATION", "EVAL LEDGER", "EXPORT"]) {
            expect(html).toContain(label);
        }
        // Collapsed content stays mounted so slider and ledger state resets never.
        expect(html).toContain("val");
        expect(html).toContain("eval");
    });

    it("vertical colorbar carries an accessible label", () => {
        const html = renderToStaticMarkup(
            <VerticalColorbar
                flow={null}
                variable="speed"
                colormap="viridis"
                visible={true}
                min={0}
                max={2}
            />
        );
        expect(html).toContain('aria-label="Vertical colorbar"');
    });

    it("vertical colorbar hides when visible is false", () => {
        const html = renderToStaticMarkup(
            <VerticalColorbar
                flow={null}
                variable="speed"
                colormap="viridis"
                visible={false}
            />
        );
        expect(html).toBe("");
    });

    it("telemetry bar reports engine, grid, and validation counts", () => {
        const html = renderToStaticMarkup(
            <TelemetryBar
                engine="ANALYTIC"
                dotClass="analytic"
                gridLabel="256 x 256"
                cells={65536}
                solveMs={12.4}
                cl={0.62}
                cpMin={-1.2}
                regime="laminar, attached"
                provenanceLabel="analytic-potential, computed locally at 256"
                pass={3}
                warn={2}
                fail={0}
                isFixture={false}
            />
        );
        expect(html).toContain("ANALYTIC");
        expect(html).toContain("256 x 256");
        expect(html).toContain("CL");
        expect(html).toContain("CPMIN");
    });
});
