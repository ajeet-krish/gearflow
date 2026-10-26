import { useEffect, useState } from "react";
import FlowCanvas from "@/render/FlowCanvas";
import { loadDemoPack, type LoadedPack } from "@/meta/fixtures";

/**
 * GearFlow Phase 1 shell. The canvas is the hero. Everything else stays quiet.
 * Phase 2 controls render disabled with clear labels. Provenance badge is always visible.
 */
export default function App() {
  const [pack, setPack] = useState<LoadedPack | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDemoPack()
      .then(setPack)
      .catch((e: unknown) => {
        console.error("Fixture load failure:", e instanceof Error ? e.message : String(e));
        setError("Failed to load fixture. Check connection and retry.");
      });
  }, []);

  return (
    <div className="page">
      <a className="skip" href="#flow">Skip to flow canvas</a>
      <header className="masthead">
        <div>
          <p className="eyebrow">GearFlow: Phase 1, contracts and skeleton</p>
          <h1 className="display">Wind over a wing, live in the browser</h1>
          <p className="lede">
            A fixture flow field drives 3000 particles over a NACA 2412 at 6 degrees.
            Nothing here is physics yet, the badge below says so on purpose.
          </p>
        </div>
        <div className="provenance" role="status" aria-label="Data provenance">
          <span className="dot" aria-hidden="true" />
          <span>{pack ? pack.provenance.label : "Loading provenance"}</span>
        </div>
      </header>

      <main id="flow" className="layout">
        <section className="canvasCard" aria-label="Live fixture flow">
          {error && <p className="error">Fixture failed to load. Check connection and retry.</p>}
          {!pack && !error && <p className="loading">Loading fixture pack</p>}
          {pack && <FlowCanvas flow={pack.flow} airfoil={pack.airfoilPoints} colormap="viridis" />}
          <div className="canvasFoot">
            <span className="mono">{pack ? `${pack.grid.nx} x ${pack.grid.ny} grid, x [-0.5, 2.0] y [-1.0, 1.0]` : "Grid 128 x 128"}</span>
            <span className="mono">{pack ? `${pack.geometry.kind} ${pack.geometry.naca?.code ?? ""} a${pack.geometry.alphaDeg}` : "naca 2412 a6"}</span>
          </div>
        </section>

        <aside className="side" aria-label="Controls and Meta placeholders">
          <section className="card" aria-label="Phase 2 controls">
            <h2>Shape controls</h2>
            <p>Phase 2 unlocks these. Phase 1 fixtures are fixed.</p>
            <label className="field">
              <span>Camber m</span>
              <input type="range" min="0" max="0.09" step="0.01" value="0.02" disabled aria-label="Camber, disabled in Phase 1" />
            </label>
            <label className="field">
              <span>Thickness t</span>
              <input type="range" min="0.06" max="0.18" step="0.01" value="0.12" disabled aria-label="Thickness, disabled in Phase 1" />
            </label>
            <label className="field">
              <span>Angle deg</span>
              <input type="range" min="0" max="12" step="1" value="6" disabled aria-label="Angle of attack, disabled in Phase 1" />
            </label>
            <button type="button" disabled>Run surrogate (Phase 2)</button>
          </section>

          <section className="card meta" aria-label="Meta orchestration placeholders">
            <h2>Meta orchestration</h2>
            <ul>
              <li><strong>Spark</strong><span>Ranking and explanation placeholder</span></li>
              <li><strong>SAM</strong><span>Segmentation mask placeholder</span></li>
              <li><strong>Image</strong><span>Thumbnail render placeholder</span></li>
            </ul>
            <p className="mono">Offline demo pack ready. API keys stay in env.</p>
          </section>
        </aside>
      </main>

      <footer className="foot">
        <span className="mono">GearFlow 0.1.0, Phase 1 skeleton. No em dashes, commas and colons only.</span>
      </footer>
    </div>
  );
}
