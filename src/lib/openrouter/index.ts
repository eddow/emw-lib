export * from './client.js'
// Types are re-exported explicitly (not `export *`) because `FetchFn` collides
// with the identically-named types already exported by `alfred` and `jev`
// from the top-level `$lib` barrel. The OpenRouter flavour is
// available as `OpenRouterFetchFn`.
export type {
	FetchFn as OpenRouterFetchFn,
	OpenRouterModel,
	OpenRouterModelArchitecture,
	OpenRouterModelPricing,
	OpenRouterModelsResponse,
	OpenRouterModelTopProvider,
} from './types.js'
