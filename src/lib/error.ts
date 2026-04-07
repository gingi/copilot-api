import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { refreshCopilotTokenIfExpired } from "./token"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

async function isExpiredTokenError(error: unknown): Promise<boolean> {
  if (!(error instanceof HTTPError)) return false
  if (error.response.status !== 401) return false
  const cloned = error.response.clone()
  const text = await cloned.text()
  return text.includes("token expired")
}

export async function withTokenRetry(
  c: Context,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler()
  } catch (error) {
    if (await isExpiredTokenError(error)) {
      const refreshed = await refreshCopilotTokenIfExpired()
      if (refreshed) {
        try {
          return await handler()
        } catch (retryError) {
          return await forwardError(c, retryError)
        }
      }
    }
    return await forwardError(c, error)
  }
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
      }
    }

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
