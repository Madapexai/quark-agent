# Contributing

Thanks for your interest! This is a small project — we like to keep it that way.

## Quick Path: Add a Skill

The highest-leverage contribution is a new `defineAction`. 60 seconds:

```ts
import { defineAction } from "quark-agent";

export const mySkill = defineAction({
  name: "my_skill",
  description: "What it does, when to use it",
  parameters: {
    foo: { type: "string", description: "what foo is" },
  },
  handler: async ({ foo }) => {
    return { ok: true };
  },
});
```

That's it. Auto-registers with the Agent, HTTP, CLI, MCP, A2A — no wiring.

## Development Setup

```bash
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent
npm install
cp e2e/.env.example e2e/.env   # fill in API keys
npx tsx e2e/demo-server.ts      # http://localhost:3456
```

## Before You Submit a PR

- [ ] `node e2e/test-tools.mjs` passes (13/13)
- [ ] `npx tsc --noEmit` passes
- [ ] If you added a tool, verify end-to-end against a real LLM
- [ ] Don't bump the kernel size — `packages/core` must stay <5KB gzipped
- [ ] No secrets in the diff (the pre-commit hook will catch them)

## Commit Messages

Light Conventional Commits:

```
<type>: <short description>
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`.

## Branching

Fork → branch from `master` → PR back to `master`. Branch name: `<type>/<short-slug>`.

## Releasing

Maintainers use [GitHub Releases](https://github.com/Madapexai/quark-agent/releases) with semver tags. Each release includes Highlights / New Features / Bug Fixes / Breaking Changes.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](https://github.com/Madapexai/quark-agent/blob/master/LICENSE).
