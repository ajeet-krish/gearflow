// Right rail tabs: Shape, Display, Validation, Export. Keep-alive panels so
// switching tabs never resets slider or ledger state.

import type { ReactNode } from "react";
import InstrumentTabs from "./InstrumentTabs";

export type RackTabId = "shape" | "display" | "validation" | "export";

export interface RackTabsProps {
    shape: ReactNode;
    display: ReactNode;
    validation: ReactNode;
    exportPanel: ReactNode;
    initial?: RackTabId;
}

export default function RackTabs({ shape, display, validation, exportPanel, initial = "shape" }: RackTabsProps) {
    return (
        <InstrumentTabs
            ariaLabel="Instrument rack tabs"
            initial={initial}
            tabs={[
                { id: "shape", label: "Shape", content: shape },
                { id: "display", label: "Display", content: display },
                { id: "validation", label: "Validation", content: validation },
                { id: "export", label: "Export", content: exportPanel },
            ]}
        />
    );
}
