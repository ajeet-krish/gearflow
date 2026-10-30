// Vercel serverless adapter for the Baseten chat completions proxy.
// Thin wrapper: the gate order lives in createBasetenServerHandler, this
// file only pins requireOrigin for prod and sets the function timeout.

import { createBasetenServerHandler } from "../../../src/agent/basetenServerHandler";

const handler = createBasetenServerHandler({ requireOrigin: true });

export default handler;

export const config = { maxDuration: 60 };
