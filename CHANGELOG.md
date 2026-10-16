# Changelog

## Unreleased

- Disabling context management while a `new_context` request is pending now tells the model that the requested window will not be created, instead of dropping the request silently.
- Internal: one notes tool module (the unused second copy of every tool definition is gone), shared paging and bounds helpers, declarative history schemas and one tools-enabled check. The tool schemas the model sees are byte-identical.
- Tests mount the JSONL session backend through its plugin, so the suite runs on DSH 0.2.1-alpha.3 and later.
