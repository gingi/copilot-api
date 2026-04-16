import { Hono } from "hono"

import { withTokenRetry } from "~/lib/error"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  return await withTokenRetry(c, async () => {
    const paylod = await c.req.json<EmbeddingRequest>()
    const response = await createEmbeddings(paylod)
    return c.json(response)
  })
})
