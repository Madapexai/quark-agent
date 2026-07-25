# Built-in Tools

Quark Agent ships with a composable toolset across 10 categories. You don't load them all - the `profile` parameter decides.

## Category × Profile Matrix

| Category | Tools | minimal | coding | research | full |
|---|---|:---:|:---:|:---:|:---:|
| File | `read_file` `write_file` `edit_file` `list_dir` | | ✅ | | ✅ |
| Search | `search_files` `find_files` | | ✅ | | ✅ |
| Shell | `shell` | | ✅ | | ✅ |
| Web | `web_search` `web_fetch` | | | ✅ | ✅ |
| Code | `run_code` | ✅ | ✅ | | ✅ |
| Image | `generate_image` | | | | ✅ |
| Task | `todo_write` `task_list` | | | ✅ | ✅ |
| Memory | `memory_save` `memory_search` | | | ✅ | ✅ |
| Computer Use | `screenshot` `click` `type` | | | | ✅ |
| Multimodal | `upload_file` `image_input` | | | | ✅ |

## Tool Reference

### File

#### `read_file`
Read a UTF-8 text file from the workspace.

```json
{ "path": "src/index.ts" }
```

#### `write_file`
Write content to a file (creates or overwrites).

```json
{ "path": "notes.md", "content": "# Notes\n..." }
```

#### `edit_file`
Replace a unique string in a file.

```json
{ "path": "src/index.ts", "old": "foo()", "new": "bar()" }
```

#### `list_dir`
List directory contents.

```json
{ "path": "src/" }
```

### Search

#### `search_files`
Grep for a pattern across files.

```json
{ "pattern": "TODO", "path": "src/" }
```

#### `find_files`
Find files by name pattern.

```json
{ "pattern": "*.test.ts" }
```

### Shell

#### `shell`
Execute a shell command in the workspace.

```json
{ "command": "npm test" }
```

### Web

#### `web_search`
Search the web (uses a public search API).

```json
{ "query": "OpenAI GPT-5 release date" }
```

#### `web_fetch`
Fetch a URL and return the markdown-rendered content.

```json
{ "url": "https://example.com" }
```

### Code

#### `run_code`
Execute JavaScript/TypeScript in a VM sandbox. Returns stdout, the last expression value, and any thrown error.

```json
{ "language": "typescript", "code": "1 + 1" }
```

### Image

#### `generate_image`
Generate an image via the configured image model.

```json
{ "prompt": "a cat in a spacesuit, 4k", "size": "1024x1024" }
```

### Task

#### `todo_write`
Create or update the agent's todo list.

```json
{ "todos": [{"id": "1", "content": "fix bug", "status": "in_progress"}] }
```

#### `task_list`
List current todos.

```json
{}
```

### Memory

#### `memory_save`
Persist a key/value to the SQLite memory store.

```json
{ "key": "user_prefers_dark_mode", "value": "true" }
```

#### `memory_search`
Semantic search over saved memories.

```json
{ "query": "user preferences" }
```

## Adding your own

A new tool is just a `defineAction`. See [defineAction API](../reference/define-action.md).
