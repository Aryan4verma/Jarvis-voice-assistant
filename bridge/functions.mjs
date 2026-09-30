import { z } from 'zod'

/** Reuse the same validated handlers for agent MCP and chat function calls. */
export function functionTools(namespace, definitions, { vision = false } = {}) {
  return definitions.map(definition => {
    const schema = z.object(definition.inputSchema)
    return {
      name: `mcp__${namespace}__${definition.name}`,
      description: definition.description,
      parameters: z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }),
      vision,
      silent: namespace === 'jarvis_ui' || ['display', 'blade'].includes(definition.name),
      execute: args => definition.handler(schema.parse(args), {}),
    }
  })
}
