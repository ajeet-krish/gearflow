// P4 curriculum chips: static lessons beside the preset chips. Each chip
// carries one prompt that runs end to end through localAssistant, plus the
// concept and suggested field the tutor would teach. No React, no network.
// Never throws.

import type { FieldMode } from "@/contracts/types";
import type { TutorConcept } from "./tutorPolicy";

/** One static lesson: label renders on the chip, prompt sends as a normal
 *  user turn, concept plus suggestedField name the tutor teaching. */
export interface CurriculumChip {
    id: string;
    label: string;
    prompt: string;
    concept: TutorConcept;
    suggestedField: FieldMode;
}

/** Static lessons. Prompts use only paths localAssistant already handles
 *  (explain, sweep, Re plus field, NACA setup) so every chip runs offline
 *  with zero network. Never throws. */
export const CURRICULUM_CHIPS: ReadonlyArray<CurriculumChip> = [
    {
        id: "airfoil-lesson",
        label: "Airfoil lesson",
        prompt: "Explain this run for NACA 2412 at alpha 6",
        concept: "attached-lift",
        suggestedField: "speed",
    },
    {
        id: "stall-demo",
        label: "Stall demo",
        prompt: "Run the alpha sweep from -4 to 12 deg",
        concept: "stall-separation",
        suggestedField: "omega",
    },
    {
        id: "re-effect",
        label: "Re effect",
        prompt: "Set Re 200000 and show the cp field",
        concept: "suction-peak",
        suggestedField: "cp",
    },
];
