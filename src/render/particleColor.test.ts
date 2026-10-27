// Particle color resolution: auto returns null, fixed modes return
// exact normalized triples.

import { describe, expect, it } from "vitest";
import { particleRgb } from "@/render/particleColor";

describe("particleRgb", () => {
    it("returns null for auto", () => {
        expect(particleRgb("auto")).toBeNull();
    });

    it("returns exact triples for each fixed mode", () => {
        expect(particleRgb("white")).toEqual([1, 1, 1]);
        expect(particleRgb("black")).toEqual([0, 0, 0]);
        expect(particleRgb("cyan")).toEqual([0x8b / 255, 0xe9 / 255, 0xfd / 255]);
        expect(particleRgb("magenta")).toEqual([0xff / 255, 0x79 / 255, 0xc6 / 255]);
        expect(particleRgb("orange")).toEqual([0xff / 255, 0xb8 / 255, 0x6c / 255]);
    });
});
