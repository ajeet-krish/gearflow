// GearFlow Theory: airfoil companion textbook for the agent chat.
// Structure ports the Zenith TheoryPage verbatim (InlineMath/BlockMath,
// H2/H3/P/Note, TOC with anchors, KaTeX), copy is physics only: NACA
// 4-digit geometry, potential flow, lift and pressure coefficients,
// angle of attack, Reynolds number, stall and separation limits, and how
// to read the before/after comparison table. No solver stack talk.

import { useEffect, useRef } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/** Renders a LaTeX string as inline HTML with a text fallback. */
function InlineMath({ tex }: { tex: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (ref.current) {
            try {
                katex.render(tex, ref.current, { throwOnError: false });
            } catch {
                if (ref.current) ref.current.textContent = tex;
            }
        }
    }, [tex]);
    return (
        <span ref={ref} className="theoryInlineMath" role="img" aria-label={tex}>
            {tex}
        </span>
    );
}

/** Renders a LaTeX string as a display (block) equation with a text fallback. */
function BlockMath({ tex }: { tex: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (ref.current) {
            try {
                katex.render(tex, ref.current, { throwOnError: false, displayMode: true });
            } catch {
                if (ref.current) ref.current.textContent = tex;
            }
        }
    }, [tex]);
    return (
        <div ref={ref} className="theoryBlockMath" role="img" aria-label={tex}>
            {tex}
        </div>
    );
}

/** Section heading with anchor id. Tab index supports TOC focus moves. */
function H2({ id, children }: { id: string; children: React.ReactNode }) {
    return (
        <h2 id={id} tabIndex={-1} className="theoryH2 scroll-mt">
            {children}
        </h2>
    );
}

function H3({ id, children }: { id?: string; children: React.ReactNode }) {
    return (
        <h3 id={id} tabIndex={-1} className="theoryH3 scroll-mt">
            {children}
        </h3>
    );
}

function P({ children }: { children: React.ReactNode }) {
    return <p className="theoryP">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
    return (
        <div className="theoryNote">
            <span className="theoryNoteLabel">Note: </span>
            {children}
        </div>
    );
}

/** Table of contents entry. */
interface TOCEntry {
    id: string;
    label: string;
    sub?: { id: string; label: string }[];
}

const TOC: TOCEntry[] = [
    { id: "what-this-guide-is", label: "What this guide is" },
    {
        id: "naca-geometry",
        label: "1. NACA 4-Digit Geometry",
        sub: [
            { id: "naca-code", label: "Reading the code" },
            { id: "camber-thickness", label: "Camber and thickness" },
            { id: "reading-shape", label: "Reading the shape" },
        ],
    },
    {
        id: "potential-flow",
        label: "2. Potential Flow in One Page",
        sub: [
            { id: "continuity-irrotational", label: "Continuity and irrotationality" },
            { id: "kutta", label: "Kutta condition" },
            { id: "thin-airfoil", label: "Thin airfoil result" },
        ],
    },
    {
        id: "lift-coefficient",
        label: "3. Lift Coefficient (Cl)",
        sub: [
            { id: "what-cl-means", label: "What Cl means" },
            { id: "cl-vs-alpha", label: "Cl versus angle of attack" },
        ],
    },
    {
        id: "pressure-coefficient",
        label: "4. Pressure Coefficient (Cp)",
        sub: [
            { id: "what-cp-means", label: "What Cp means" },
            { id: "cp-curve", label: "Reading the Cp curve" },
        ],
    },
    {
        id: "angle-of-attack",
        label: "5. Angle of Attack",
        sub: [
            { id: "alpha-definition", label: "Definition" },
            { id: "small-alpha", label: "Small angles" },
        ],
    },
    {
        id: "reynolds-number",
        label: "6. Reynolds Number",
        sub: [
            { id: "what-re-means", label: "What Re means" },
            { id: "regimes", label: "Flow regimes" },
        ],
    },
    {
        id: "stall-limits",
        label: "7. Stall and Separation Limits",
        sub: [
            { id: "linear-range", label: "Where the linear range ends" },
            { id: "potential-limits", label: "What potential flow omits" },
        ],
    },
    {
        id: "before-after",
        label: "8. Reading the Before/After Table",
        sub: [
            { id: "worked-example", label: "Worked example" },
            { id: "agent-tips", label: "Questions to ask the agent" },
        ],
    },
];

/** Table of Contents sidebar. Activating a link scrolls, updates the
    hash, and moves focus to the target heading for assistive tech. */
function TableOfContents() {
    const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
        e.preventDefault();
        let smooth = true;
        try {
            smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch {
            smooth = true;
        }
        const target = document.getElementById(id);
        target?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
        try {
            window.history.replaceState(null, "", `#${id}`);
        } catch {
            try {
                window.location.hash = id;
            } catch {
                /* hash update is best effort, focus still moves below */
            }
        }
        if (target) {
            try {
                if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
                (target as HTMLElement).focus({ preventScroll: true });
            } catch {
                /* focus move is best effort, scroll already happened */
            }
        }
    };

    return (
        <nav className="theoryToc" aria-label="Theory contents">
            <div className="theoryTocTitle">On this page</div>
            <ul className="theoryTocList">
                {TOC.map((entry) => (
                    <li key={entry.id}>
                        <a
                            href={`#${entry.id}`}
                            onClick={(e) => handleClick(e, entry.id)}
                            className="theoryTocLink"
                        >
                            {entry.label}
                        </a>
                        {entry.sub && (
                            <ul className="theoryTocSub">
                                {entry.sub.map((sub) => (
                                    <li key={sub.id}>
                                        <a
                                            href={`#${sub.id}`}
                                            onClick={(e) => handleClick(e, sub.id)}
                                            className="theoryTocSubLink"
                                        >
                                            {sub.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </li>
                ))}
            </ul>
        </nav>
    );
}

/** TheoryPage: airfoil companion textbook for the agent chat. */
export default function TheoryPage() {
    return (
        <div className="theoryWrap" id="theory" tabIndex={-1} aria-label="Airfoil theory companion">
            <TableOfContents />
            <div className="theoryBody">
                <div className="theoryInner">
                    <h1 className="theoryH1">Airfoil Theory Companion</h1>
                    <p className="theorySub">
                        A short textbook for the agent chat: geometry, lift, pressure, and limits.
                    </p>

                    <H2 id="what-this-guide-is">What this guide is</H2>
                    <P>
                        This page is the reference behind the agent chat. When the console
                        explains a shape change, it is talking about the quantities defined
                        here: camber, thickness, angle of attack, lift coefficient, pressure
                        coefficient, and Reynolds number. Read it once, then ask the agent
                        to connect any row of the before/after table back to these ideas.
                    </P>
                    <P>
                        Everything below is steady, two-dimensional, incompressible flow
                        past a single airfoil at a small angle of attack. That is the regime
                        where the lift slope is nearly straight and the pressure story is
                        clean. Outside that regime the same words still apply, but the
                        numbers stop following the simple lines.
                    </P>

                    <H2 id="naca-geometry">1. NACA 4-Digit Geometry</H2>
                    <H3 id="naca-code">Reading the code</H3>
                    <P>
                        A code such as NACA 2412 reads as three design numbers. The first
                        digit is the maximum camber in percent of chord{" "}
                        <InlineMath tex="m = 0.02" />, the second digit is the position
                        of maximum camber in tenths of chord{" "}
                        <InlineMath tex="p = 0.4" />, and the last two digits are the
                        maximum thickness in percent of chord{" "}
                        <InlineMath tex="t = 0.12" />. NACA 0012 is the symmetric
                        member of the family: zero camber, twelve percent thick.
                    </P>
                    <H3 id="camber-thickness">Camber and thickness</H3>
                    <P>
                        Thickness is the half-width of the section normal to the camber
                        line. The standard 4-digit thickness distribution is:
                    </P>
                    <BlockMath tex="y_t = 5t\left(0.2969\sqrt{x} - 0.1260x - 0.3516x^2 + 0.2843x^3 - 0.1036x^4\right)" />
                    <P>
                        where <InlineMath tex="x" /> runs from 0 at the leading edge to
                        1 at the trailing edge, in units of chord. Camber is the curve
                        the thickness is built around, defined in two branches that meet
                        at <InlineMath tex="x = p" />:
                    </P>
                    <BlockMath tex="y_c = m\frac{x}{p^2}\left(2p - x\right) \quad (x < p), \qquad y_c = m\frac{1-x}{(1-p)^2}\left(1 + x - 2p\right) \quad (x \ge p)" />
                    <P>
                        More camber shifts the whole lift curve upward. More thickness
                        rounds the nose, softens the suction peak, and (up to about
                        twelve to fifteen percent) delays the stall.
                    </P>
                    <H3 id="reading-shape">Reading the shape</H3>
                    <P>
                        Look at three things on any section: how much the mean line
                        arches (camber), where that arch peaks (forward peak means a
                        sharper suction rise near the nose), and how full the nose is
                        (a thicker nose spreads the low pressure over more chord).
                    </P>

                    <H2 id="potential-flow">2. Potential Flow in One Page</H2>
                    <H3 id="continuity-irrotational">Continuity and irrotationality</H3>
                    <P>
                        Incompressible flow conserves volume, so the velocity field has
                        zero divergence. Irrotational flow has zero curl, so the velocity
                        is the gradient of a potential. Together they give Laplace's
                        equation for the potential:
                    </P>
                    <BlockMath tex="\nabla \cdot \mathbf{u} = 0, \qquad \nabla \times \mathbf{u} = 0, \qquad \nabla^2 \phi = 0" />
                    <P>
                        Solutions superpose: uniform stream plus vortices, sources, and
                        doublets can be added to build the flow around a section. Lift
                        comes from circulation, the net swirl bound to the airfoil.
                    </P>
                    <H3 id="kutta">Kutta condition</H3>
                    <P>
                        Of all the flows that satisfy the equations, nature selects the
                        one that leaves the trailing edge smoothly: the flow speed is
                        finite and equal from above and below at a sharp trailing edge.
                        Enforcing this picks the circulation, and therefore the lift.
                        A rounded or thick trailing edge weakens the argument, which is
                        one reason real sections stall from the rear first.
                    </P>
                    <H3 id="thin-airfoil">Thin airfoil result</H3>
                    <P>
                        For a thin section at a small angle, the theory collapses to one
                        line: lift grows linearly with angle of attack measured from the
                        zero-lift angle,
                    </P>
                    <BlockMath tex="C_l \approx 2\pi\left(\alpha - \alpha_0\right)" />
                    <P>
                        with <InlineMath tex="\alpha" /> in radians. Camber sets{" "}
                        <InlineMath tex="\alpha_0" /> (negative for positive camber, so
                        a cambered section lifts at zero angle). Thickness barely moves
                        the slope; it changes where the linear range ends.
                    </P>

                    <H2 id="lift-coefficient">3. Lift Coefficient (Cl)</H2>
                    <H3 id="what-cl-means">What Cl means</H3>
                    <P>
                        The lift coefficient normalizes lift by size and speed so
                        sections can be compared:
                    </P>
                    <BlockMath tex="C_l = \frac{L}{q_\infty c}, \qquad q_\infty = \tfrac{1}{2}\rho V_\infty^2" />
                    <P>
                        where <InlineMath tex="L" /> is lift per unit span,{" "}
                        <InlineMath tex="q_\infty" /> is the freestream dynamic
                        pressure, and <InlineMath tex="c" /> is the chord. A value of
                        0.6 at six degrees on a cambered section is ordinary; 1.2 is a
                        hard-working section near its limit; above about 1.5 at low
                        speed, ask whether the flow is still attached.
                    </P>
                    <H3 id="cl-vs-alpha">Cl versus angle of attack</H3>
                    <P>
                        Expect about 0.10 to 0.11 of Cl per degree (the{" "}
                        <InlineMath tex="2\pi" /> per radian slope) through the linear
                        range, roughly zero to eight degrees for common sections. The
                        curve bends over as the suction peak can no longer stay
                        attached, flattens at maximum lift, then falls at stall.
                    </P>
                    <Note>
                        A symmetric section (NACA 0012) passes through zero lift at zero
                        angle. A cambered section (NACA 2412) already lifts about 0.25
                        at zero angle, so the same Cl arrives at a smaller geometric
                        angle.
                    </Note>

                    <H2 id="pressure-coefficient">4. Pressure Coefficient (Cp)</H2>
                    <H3 id="what-cp-means">What Cp means</H3>
                    <P>
                        The pressure coefficient normalizes local pressure by the same
                        dynamic pressure:
                    </P>
                    <BlockMath tex="C_p = \frac{p - p_\infty}{q_\infty} = 1 - \left(\frac{V}{V_\infty}\right)^2" />
                    <P>
                        The second equality holds for incompressible, steady flow along
                        a streamline. Faster local flow means lower pressure:{" "}
                        <InlineMath tex="C_p = 1" /> is stagnation (flow brought to
                        rest at the nose), <InlineMath tex="C_p = 0" /> is freestream
                        pressure, and negative values are suction.
                    </P>
                    <H3 id="cp-curve">Reading the Cp curve</H3>
                    <P>
                        Trace the upper surface from leading edge to trailing edge. You
                        should see stagnation near the nose, a rapid fall to the
                        suction peak (the minimum Cp, often negative 2 to negative 4 at moderate lift),
                        then a gradual recovery toward the trailing edge. The area
                        enclosed between the upper and lower surface curves is the
                        lift: a fatter enclosed region means more Cl.
                    </P>
                    <P>
                        Watch the recovery slope. A long, gentle climb back to trailing
                        edge pressure stays attached. A steep climb after a deep, sharp
                        peak is the classic stall precursor: the boundary layer cannot
                        push against that pressure hill and separates.
                    </P>

                    <H2 id="angle-of-attack">5. Angle of Attack</H2>
                    <H3 id="alpha-definition">Definition</H3>
                    <P>
                        Angle of attack <InlineMath tex="\alpha" /> is the angle between
                        the freestream and the chord line, positive nose up. Lift
                        responds to the effective angle: geometric angle minus the
                        zero-lift angle,
                    </P>
                    <BlockMath tex="\alpha_{\text{eff}} = \alpha - \alpha_0" />
                    <P>
                        so two sections at the same geometric angle can carry very
                        different loads if their cambers differ.
                    </P>
                    <H3 id="small-alpha">Small angles</H3>
                    <P>
                        Between about zero and eight degrees the flow obliges the
                        theory: the suction peak deepens in place, the stagnation point
                        creeps onto the lower nose, and Cl climbs on the straight
                        line. Past roughly ten to twelve degrees (earlier for thin or
                        highly cambered sections), the recovery slope wins and the
                        upper surface separates from the rear.
                    </P>
                    <Note>
                        Negative angles are legal: the section simply lifts downward
                        once past its zero-lift angle. Symmetric sections are
                        antisymmetric, so negative stall mirrors positive stall.
                    </Note>

                    <H2 id="reynolds-number">6. Reynolds Number</H2>
                    <H3 id="what-re-means">What Re means</H3>
                    <P>
                        The Reynolds number is the ratio of inertial to viscous forces:
                    </P>
                    <BlockMath tex="Re = \frac{\rho V_\infty c}{\mu} = \frac{V_\infty c}{\nu}" />
                    <P>
                        where <InlineMath tex="\rho" /> is density,{" "}
                        <InlineMath tex="\mu" /> is dynamic viscosity, and{" "}
                        <InlineMath tex="\nu" /> is kinematic viscosity. Bigger chord,
                        faster flow, or thinner fluid all raise Re. The tunnel default
                        of 50,000 sits in the transitional band where the wake begins
                        to oscillate, so the honest expectation is early transitional
                        behavior rather than steady laminar flow.
                    </P>
                    <H3 id="regimes">Flow regimes</H3>
                    <P>
                        Below about 1,000 the flow is creeping and viscous throughout.
                        From roughly 1,000 to 20,000 it stays laminar and attached at
                        small angles. Through the transitional band (tens to low
                        hundreds of thousands) the wake begins to oscillate and
                        separation bubbles appear. Fully turbulent, high-Re flow
                        separates later but needs viscous modeling the potential
                        picture cannot supply.
                    </P>

                    <H2 id="stall-limits">7. Stall and Separation Limits</H2>
                    <H3 id="linear-range">Where the linear range ends</H3>
                    <P>
                        Three signs mark the edge: the Cl versus alpha curve bends away
                        from the straight line, the suction peak stops deepening and
                        instead broadens or collapses, and the trailing edge pressure
                        recovery steepens. Any one of them means margin is gone; two
                        together mean the section is stalled for practical purposes.
                    </P>
                    <H3 id="potential-limits">What potential flow omits</H3>
                    <P>
                        Potential flow has no viscosity, so it never separates, never
                        stalls, and never makes drag from a wake. Treat every number it
                        gives past the linear range as an extrapolation, not a
                        prediction. The honest statement is: attached, small-angle
                        numbers are trustworthy; post-stall numbers describe a flow
                        the model cannot produce.
                    </P>
                    <Note>
                        Camber raises the whole Cl curve but narrows the friendly
                        range. Thickness forgives: a twelve percent section stalls
                        several degrees later and more gently than a six percent
                        section at the same camber.
                    </Note>

                    <H2 id="before-after">8. Reading the Before/After Table</H2>
                    <P>
                        The agent chat compares two cases side by side: the shape you
                        started from and the shape it proposes. Each row holds the
                        geometry (NACA code, camber, thickness, angle), the operating
                        point (Reynolds number), and the outcomes (Cl and minimum Cp).
                        Read it the way you would read an experiment log: inputs on
                        the left, results on the right, one change at a time.
                    </P>
                    <H3 id="worked-example">Worked example</H3>
                    <P>
                        Suppose the table shows NACA 0012 at four degrees moving to
                        NACA 2412 at the same angle and Re. Expect Cl to rise by roughly
                        0.3 (the camber offset at nearly unchanged slope), and expect
                        the minimum Cp to deepen and shift slightly forward as the
                        suction peak strengthens. If Cl instead barely moves while the
                        peak sharpens, the section is likely near the end of its
                        linear range and extra camber is buying pressure trouble, not
                        lift.
                    </P>
                    <div className="theoryCard" role="table" aria-label="Before and after example">
                        <div className="theoryCardRow theoryCardHead" role="row">
                            <span role="columnheader">Case</span>
                            <span role="columnheader">Geometry</span>
                            <span role="columnheader">Cl</span>
                            <span role="columnheader">Min Cp</span>
                        </div>
                        <div className="theoryCardRow" role="row">
                            <span role="cell">Before</span>
                            <span role="cell">NACA 0012, 4 deg</span>
                            <span role="cell">0.44</span>
                            <span role="cell">-1.6</span>
                        </div>
                        <div className="theoryCardRow" role="row">
                            <span role="cell">After</span>
                            <span role="cell">NACA 2412, 4 deg</span>
                            <span role="cell">0.72</span>
                            <span role="cell">-2.4</span>
                        </div>
                    </div>
                    <H3 id="agent-tips">Questions to ask the agent</H3>
                    <ul className="theoryList">
                        <li>Which input changed, and is the Cl shift on the thin-airfoil slope?</li>
                        <li>Did the suction peak deepen in place (healthy) or sharpen and collapse (stall warning)?</li>
                        <li>Is the angle still inside the linear range for this thickness?</li>
                        <li>Does the Reynolds number support attached flow at this Cl?</li>
                    </ul>
                    <P>
                        If the agent cannot tie a row back to camber, angle, or Re,
                        ask it to try again with one change isolated. Two simultaneous
                        changes explain nothing.
                    </P>
                </div>
            </div>
        </div>
    );
}
