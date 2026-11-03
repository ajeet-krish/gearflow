// IdeStatusBar: 22px VS Code style status strip. Reduced to three honest
// items only: git branch, changed count, and error count. No engine, grid,
// Re, Cl, field, provenance, or LIVE state. Visual emulation only.

export interface IdeStatusBarProps {
    branch: string;
    changedCount: number;
    errorCount: number;
}

export default function IdeStatusBar({ branch, changedCount, errorCount }: IdeStatusBarProps) {
    return (
        <footer className="ideStatus" role="status" aria-label="IDE status bar">
            <span className="ideStatusGroup">
                <span className="ideStatusItem mono" aria-label={`Git branch ${branch}`}>
                    <span className="ideBranchGlyph" aria-hidden="true">
                        &#928;
                    </span>
                    <span className="mono">{branch}</span>
                </span>
                <span className="ideStatusItem mono" aria-label={`${changedCount} changed files`}>
                    <span aria-hidden="true">&#9679;</span>
                    <span className="mono">{changedCount} changed</span>
                </span>
                <span className="ideStatusItem" aria-label={`${errorCount} errors`}>
                    <span className="ideErrGlyph" aria-hidden="true">
                        &#8855;
                    </span>
                    <span className="mono">{errorCount}</span>
                </span>
            </span>
        </footer>
    );
}
