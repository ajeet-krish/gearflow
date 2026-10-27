// GearFlow resize handle. Drag strip between the tunnel window and the
// instrument racks. Pointer plus keyboard accessible, reduced motion safe.
import { useRef } from "react";

export interface ResizeHandleProps {
    id: string;
    label: string;
    onNudge: (delta: number) => void;
    onDrag: (delta: number) => void;
}

export default function ResizeHandle({ id, label, onNudge, onDrag }: ResizeHandleProps) {
    const startX = useRef(0);
    const dragging = useRef(false);

    function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
        dragging.current = true;
        startX.current = e.clientX;
        (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
        if (!dragging.current) return;
        const delta = e.clientX - startX.current;
        startX.current = e.clientX;
        onDrag(delta);
    }

    function onPointerUp(): void {
        dragging.current = false;
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            onNudge(-12);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onNudge(12);
        } else if (e.key === "Home") {
            e.preventDefault();
            onNudge(-9999);
        } else if (e.key === "End") {
            e.preventDefault();
            onNudge(9999);
        }
    }

    return (
        <div
            id={id}
            className="resizeHandle"
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
        >
            <span className="resizeGrip" aria-hidden="true" />
        </div>
    );
}
