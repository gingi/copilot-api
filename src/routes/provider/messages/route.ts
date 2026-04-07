import { Hono } from "hono"

import { forwardError, withTokenRetry } from "~/lib/error"

import { handleProviderCountTokens } from "./count-tokens-handler"
import { handleProviderMessages } from "./handler"

export const providerMessageRoutes = new Hono()

providerMessageRoutes.post("/", async (c) => {
  return await withTokenRetry(c, () => handleProviderMessages(c))
})

providerMessageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleProviderCountTokens(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
