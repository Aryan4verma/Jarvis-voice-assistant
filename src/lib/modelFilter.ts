import type { Model } from './settings'
export const isFreeModel = (model: Model) => model.providerId === 'openrouter' && model.free !== false && model.inputPrice === 0 && model.outputPrice === 0
export function filterModels(models: Model[], query = '', free = false, vision = false, tools = false) {
  return models.filter(model => `${model.name} ${model.modelId}`.toLowerCase().includes(query.toLowerCase()) &&
    (!free || isFreeModel(model)) && (!vision || model.capabilities.vision === true) && (!tools || model.capabilities.toolCalling === true))
    .sort((a, b) => Number(isFreeModel(b)) - Number(isFreeModel(a)) || a.name.localeCompare(b.name)).slice(0, 50)
}
