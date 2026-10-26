// Frame source abstraction. Phase 1 ships FixtureFlowProvider only.
// Binary LBM1 and surrogate providers arrive in Phase 2.

import type { FlowField } from "@/contracts/types";

export interface FrameSource {
  readonly label: string;
  getFrame(): FlowField;
}

export class FixtureFlowProvider implements FrameSource {
  readonly label = "fixture";
  private field: FlowField;
  constructor(field: FlowField) {
    this.field = field;
  }
  getFrame(): FlowField {
    return this.field;
  }
}
