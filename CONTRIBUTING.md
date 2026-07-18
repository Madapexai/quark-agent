# Contributing to Quark Agent

Thanks for your interest in contributing! This is a small project with a small kernel — we like to keep it that way.

## Code of Conduct

Be kind. Disagree well. No harassment, spam, or self-promotion unrelated to the project.

## Ways to Contribute

- **Bug reports** — [open an issue](https://github.com/Madapexai/quark-agent/issues/new?template=bug_report.yml), include reproduction steps and your `.env` redacted.
- **Feature ideas** — start a [Discussion](https://github.com/Madapexai/quark-agent/discussions/categories/ideas) first; large features should get buy-in before a PR.
- **New Skill / Tool** — the highest-leverage contribution. A single `defineAction` is enough; see below.
- **Benchmark fixtures** — more tasks = more signal. Add to `e2e/bench-fixtures/` and update `e2e/full-eval.mjs`.
- **Docs & examples** — PRs to `docs/` or `examples/` are always welcome.

## Adding a Skill (the 60-second path)

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

That's it. The action auto-registers with the Agent, HTTP layer, CLI, MCP, and A2A — no extra wiring.

## Development Setup

```bash
git clone https://github.com/Madapexai/quark-agent.git
cd quark-agent
npm install
cp e2e/.env.example e2e/.env   # fill in API keys
npx tsx e2e/demo-server.ts      # http://localhost:3456
```

Requirements: Node.js ≥ 20, an OpenAI-compatible API key (or Model Proxy).

## Before You Submit a PR

- [ ] `node e2e/test-tools.mjs` passes (13/13)
- [ ] `npx tsc --noEmit` passes (no type errors)
- [ ] If you added a tool, verify it end-to-end against a real LLM
- [ ] Don't bump the kernel size — `packages/core` must stay <5KB gzipped
- [ ] No secrets in the diff (the pre-commit hook will catch them anyway)

## Commit Message Convention

We follow a light version of Conventional Commits:

```
<type>: <short description>

<body, optional>
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`.

## Branching

- Fork → branch from `master` → PR back to `master`.
- Branch name: `<type>/<short-slug>`, e.g. `feat/send-email-skill`.

## Releasing

Maintainers handle releases. We use [GitHub Releases](https://github.com/Madapexai/quark-agent/releases) with semver tags (`v0.1.0`, `v0.2.0`, …). Each release includes Highlights / New Features / Bug Fixes / Breaking Changes.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
