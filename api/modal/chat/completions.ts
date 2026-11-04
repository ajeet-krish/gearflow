// Vercel serverless adapter for the Modal chat completions proxy.
// Thin wrapper: the gate order lives in createModalServerHandler, this
// file only pins requireOrigin for prod and sets the function timeout.

import { createModalServerHandler } from "../../../src/agent/modalServerHandler.js";

const handler = createModalServerHandler({ requireOrigin: true });

export default handler;

export const config = { maxDuration: 60 };
