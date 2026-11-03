// Static IDE explorer data for the P1 shell emulation. Visual emulation
// only, no vendored code. Names mirror the flow lab domain (cases, fields,
// validation) so the sidebar reads as project content, not a code clone.

export interface IdeFileItem {
    name: string;
    kind: "case" | "field" | "report" | "config";
    detail: string;
}

export interface IdeExplorerSection {
    id: string;
    title: string;
    items: IdeFileItem[];
}

export const IDE_EXPLORER_SECTIONS: ReadonlyArray<IdeExplorerSection> = [
    {
        id: "cases",
        title: "Cases",
        items: [
            { name: "naca2412.case", kind: "case", detail: "NACA 2412, alpha 6, Re 50k" },
            { name: "shedding.case", kind: "case", detail: "Cylinder, alpha 0, Re 100" },
            { name: "naca0012.case", kind: "case", detail: "NACA 0012, alpha 4, Re 1.2k" },
        ],
    },
    {
        id: "fields",
        title: "Fields",
        items: [
            { name: "speed.field", kind: "field", detail: "Velocity magnitude" },
            { name: "cp.field", kind: "field", detail: "Pressure coefficient" },
            { name: "vorticity.field", kind: "field", detail: "Out of plane vorticity" },
        ],
    },
    {
        id: "reports",
        title: "Reports",
        items: [
            { name: "validation.report", kind: "report", detail: "9 offline anchors" },
            { name: "export.report", kind: "report", detail: "PDF plus PNG snapshot" },
        ],
    },
];

export const IDE_OUTLINE_ITEMS: ReadonlyArray<{ name: string; detail: string }> = [
    { name: "Body", detail: "Active case geometry" },
    { name: "Alpha", detail: "Angle of attack in deg" },
    { name: "Reynolds", detail: "Freestream Re" },
    { name: "Field", detail: "Displayed quantity" },
    { name: "Provenance", detail: "Solver label" },
];

export const IDE_ACTIVITY_VIEWS = [
    { id: "explorer", label: "Explorer", glyph: "E" },
    { id: "source-control", label: "Source Control", glyph: "S" },
    { id: "extensions", label: "Extensions", glyph: "X" },
    { id: "analysis", label: "Analysis", glyph: "A" },
] as const;

export type IdeActivityView = (typeof IDE_ACTIVITY_VIEWS)[number]["id"];
