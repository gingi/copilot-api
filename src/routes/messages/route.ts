import { Hono } from "hono"

import { forwardError, withTokenRetry } from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  return await withTokenRetry(c, () => handleCompletion(c))
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
