export * from './client.js'
// Types are re-exported explicitly (not `export *`) because `FetchFn` collides
// with the identically-named types already exported by `alfred` and `serps`
// from the top-level `$lib` barrel. The jev flavour is available as `JevFetchFn`.
export type {
	FetchFn as JevFetchFn,
	JevAnswers,
	JevChoiceAnswer,
	JevDecideInput,
	JevNoulAnswer,
	JevQuestion,
	JevQuestionType,
} from './types.js'
