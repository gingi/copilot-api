import { Hono } from "hono"

import { withTokenRetry } from "~/lib/error"

import { handleCompletion } from "./handler"

export const completionRoutes = new Hono()

completionRoutes.post("/", async (c) => {
  return await withTokenRetry(c, () => handleCompletion(c))
})
