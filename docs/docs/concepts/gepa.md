# Self-Evolution (GEPA)

GEPA (Grammar Evolution of Prompts and Actions) is Quark Agent's built-in prompt-and-tool-selection optimizer.

## The Idea

Hand the agent a set of eval cases, and let it tune its own system prompt and tool-selection policy over generations — like a genetic algorithm over prompts.

## Usage

```ts
import { Evolver } from "quark-agent";

const evolver = new Evolver({
  agent,
  evalCases: [
    { input: "What's 2+2?", expected: "4" },
    { input: "Read package.json and tell me the version", expected: "1.0.0" },
    // ... more cases
  ],
  generations: 10,
  populationSize: 8,
  mutationRate: 0.2,
});

const result = await evolver.evolve();
console.log(result.bestPrompt);
console.log(result.bestScore);
```

## What It Mutates

- **System prompt** — wording, ordering, emphasis of instructions
- **Tool descriptions** — how each tool is described to the LLM
- **Tool inclusion order** — which tools appear first in the prompt

## What It Doesn't Mutate

- Tool implementations (your `handler` code is sacred)
- The kernel
- Provider config

## Caveats

- GEPA makes **a lot** of LLM calls — `populationSize * generations * evalCases.length`. Budget accordingly.
- Best run overnight with a cheap model, then snapshot the winning prompt into your codebase.
- The eval cases should be representative — overfitting to a narrow set is a real risk.
