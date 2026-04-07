import { Hono } from "hono"

import { withTokenRetry } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  return await withTokenRetry(c, () => handleResponses(c))
})
