import { mcp } from '@orpc/mcp'
import { openapi } from '@orpc/openapi'
import { os } from '@orpc/server'
import { Schema, type Effect, type Layer } from 'effect'

import type { layer } from '../server/runtime.ts'

// The app's API with oRPC: one router of procedures over the Effect services, served as MCP tools
// (/mcp), OpenAPI (/api) and RPC (/rpc, the web pages' and scripts' typed client). See server.ts.

export type Services = Layer.Success<typeof layer>

// An Effect of the app's services run for a call: its failure an ORPCError (see server.ts)
export type Run = <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>

export interface ApiContext {
  readonly run: Run
  // The app's address as its clients see it (auth.ts's publicOrigin)
  readonly origin: string
}

export const base = os.$context<ApiContext>()

// An Effect schema as oRPC takes it: Standard Schema to validate, Standard JSON Schema for the
// MCP tools' and the OpenAPI document's schemas. Optional keys with Schema.optionalKey and numbers
// with Schema.Finite or Schema.Int keep the JSON Schema plain.
export const standard = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))

export const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).annotate({
  description: 'YYYY-MM-DD',
})

export interface ToolSpec {
  // The MCP tool's name, the OpenAPI operationId
  readonly name: string
  readonly title: string
  readonly description: string
  readonly method: 'GET' | 'POST' | 'DELETE'
  // Under /api; {key} is the input's key
  readonly path: `/${string}`
  readonly tags: ReadonlyArray<string>
  readonly readOnly: boolean
  // What it changes cannot be undone
  readonly destructive?: boolean
  readonly idempotent?: boolean
  // It reaches Garmin Connect, beyond the app's data
  readonly openWorld: boolean
}

// A procedure that is an MCP tool and an OpenAPI operation alike
export const tool = (spec: ToolSpec) =>
  base
    .meta(
      openapi({
        method: spec.method,
        path: spec.path,
        operationId: spec.name,
        summary: spec.title,
        description: spec.description,
        tags: [...spec.tags],
      })
    )
    .meta(
      mcp.tool({
        name: spec.name,
        title: spec.title,
        description: spec.description,
        annotations: {
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive ?? false,
          idempotentHint: spec.idempotent ?? spec.readOnly,
          openWorldHint: spec.openWorld,
        },
      })
    )
