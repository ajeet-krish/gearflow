// Particle color resolution: every mode returns an exact normalized
// triple, white is the default. The Auto option is retired.

import { describe, expect, it } from "vitest";
import { PARTICLE_COLOR_OPTIONS, particleRgb } from "@/render/particleColor";

describe("particleRgb", () => {
    it("offers no Auto option with White first", () => {
        expect(PARTICLE_COLOR_OPTIONS.some((opt) => opt.id === ("auto" as never))).toBe(false);
        expect(PARTICLE_COLOR_OPTIONS[0].id).toBe("white");
        expect(PARTICLE_COLOR_OPTIONS).toHaveLength(5);
    });

    it("returns exact triples for each fixed mode", () => {
        expect(particleRgb("white")).toEqual([1, 1, 1]);
        expect(particleRgb("black")).toEqual([0, 0, 0]);
        expect(particleRgb("cyan")).toEqual([0x8b / 255, 0xe9 / 255, 0xfd / 255]);
        expect(particleRgb("magenta")).toEqual([0xff / 255, 0x79 / 255, 0xc6 / 255]);
        expect(particleRgb("orange")).toEqual([0xff / 255, 0xb8 / 255, 0x6c / 255]);
    });
});
