#!/usr/bin/env python3
"""
Extract 100 AgentBench tasks from the cloned repo data.
Categories: DB-Bench (40) + OS-Interaction (30) + Knowledge-Graph (20) + Lateral-Thinking (10)
Output: /workspace/micro-agent/e2e/bench-fixtures/agentbench-100.json
"""
import json, os, random

random.seed(42)
AGENTBENCH = "/tmp/AgentBench/data"
OUT = "/workspace/micro-agent/e2e/bench-fixtures/agentbench-100.json"

tasks = []

# === 1. DB-Bench (40 tasks) — table QA ===
with open(f"{AGENTBENCH}/dbbench/standard.jsonl") as f:
    dbbench = [json.loads(line) for line in f if line.strip()]
random.shuffle(dbbench)
for i, item in enumerate(dbbench[:50]):
    table = item.get("table", {})
    table_name = table.get("table_name", "table")
    table_info = table.get("table_info", {})
    columns = table_info.get("columns", [])
    rows = table_info.get("rows", [])
    add_desc = item.get("add_description", "")
    question = item["description"]
    label = item.get("label", [])
    expected = label[0] if label else ""

    # Build a readable prompt
    col_names = [c["name"] for c in columns]
    col_types = [c.get("type", "TEXT") for c in columns]
    header = ", ".join(col_names)
    data_rows = []
    for r in rows[:50]:  # limit to 50 rows
        data_rows.append(", ".join(str(v) for v in r))
    table_text = f"Table: {table_name}\nColumns: {header}\nDescription: {add_desc}\nRows:\n" + "\n".join(data_rows)

    prompt = f"""You have access to a data table. Answer the question based on the table.

{table_text}

Question: {question}

You can use the run_code tool to process the data. Reply with ONLY the answer, nothing else."""

    tasks.append({
        "id": f"AB-DB-{i+1:03d}",
        "category": "db_bench",
        "source": "AgentBench/DB-Bench",
        "question": question,
        "prompt": prompt,
        "expected": expected,
        "table_name": table_name,
        "sql": item.get("sql", {}).get("query", ""),
    })

# === 2. OS-Interaction (30 tasks) ===
with open(f"{AGENTBENCH}/os_interaction/data/dev.json") as f:
    os_dev = json.load(f)
# Also try training data
try:
    with open(f"{AGENTBENCH}/os_interaction/train_0317/training.json") as f:
        os_train = json.load(f)
    os_all = os_dev + os_train
except:
    os_all = os_dev
random.shuffle(os_all)
os_count = 0
for item in os_all:
    if os_count >= 30:
        break
    # OS interaction tasks have varying formats
    desc = item.get("description", item.get("task", item.get("question", "")))
    if not desc:
        continue
    expected = item.get("label", item.get("answer", item.get("ground_truth", "")))
    if isinstance(expected, list):
        expected = expected[0] if expected else ""
    if not expected:
        # Try to find expected in other fields
        expected = str(item.get("result", item.get("output", "")))

    prompt = f"""You are operating in a Linux environment. Complete the following task using the shell tool.

Task: {desc}

Use the shell tool to execute commands. Reply with the final answer."""
    tasks.append({
        "id": f"AB-OS-{os_count+1:03d}",
        "category": "os_interaction",
        "source": "AgentBench/OS-Interaction",
        "question": desc,
        "prompt": prompt,
        "expected": str(expected) if expected else "",
    })
    os_count += 1

# If we didn't get enough OS tasks, pad with more DB-Bench
if os_count < 30:
    extra = 30 - os_count
    for i, item in enumerate(dbbench[40:40+extra]):
        table = item.get("table", {})
        table_name = table.get("table_name", "table")
        table_info = table.get("table_info", {})
        columns = table_info.get("columns", [])
        rows = table_info.get("rows", [])
        add_desc = item.get("add_description", "")
        question = item["description"]
        label = item.get("label", [])
        expected = label[0] if label else ""
        col_names = [c["name"] for c in columns]
        header = ", ".join(col_names)
        data_rows = []
        for r in rows[:50]:
            data_rows.append(", ".join(str(v) for v in r))
        table_text = f"Table: {table_name}\nColumns: {header}\nDescription: {add_desc}\nRows:\n" + "\n".join(data_rows)
        prompt = f"""You have access to a data table. Answer the question based on the table.

{table_text}

Question: {question}

You can use the run_code tool to process the data. Reply with ONLY the answer, nothing else."""
        tasks.append({
            "id": f"AB-DB-{40+i+1:03d}",
            "category": "db_bench",
            "source": "AgentBench/DB-Bench",
            "question": question,
            "prompt": prompt,
            "expected": expected,
            "table_name": table_name,
            "sql": item.get("sql", {}).get("query", ""),
        })

# === 3. Knowledge Graph (20 tasks) ===
with open(f"{AGENTBENCH}/knowledgegraph/std.json") as f:
    kg = json.load(f)
random.shuffle(kg)
for i, item in enumerate(kg[:20]):
    desc = item.get("description", item.get("question", str(item)))
    expected = item.get("label", item.get("answer", item.get("ground_truth", "")))
    if isinstance(expected, list):
        expected = expected[0] if expected else ""
    prompt = f"""Answer the following knowledge graph reasoning question:

{desc}

Think step by step. Reply with ONLY the final answer."""
    tasks.append({
        "id": f"AB-KG-{i+1:03d}",
        "category": "knowledge_graph",
        "source": "AgentBench/KnowledgeGraph",
        "question": desc,
        "prompt": prompt,
        "expected": str(expected) if expected else "",
    })

# If KG didn't give enough, pad
if len([t for t in tasks if t["category"] == "knowledge_graph"]) < 20:
    # Add more DB-Bench tasks to compensate
    extra = 20 - len([t for t in tasks if t["category"] == "knowledge_graph"])
    existing_db = len([t for t in tasks if t["category"] == "db_bench"])
    for i, item in enumerate(dbbench[70:70+extra]):
        table = item.get("table", {})
        table_name = table.get("table_name", "table")
        table_info = table.get("table_info", {})
        columns = table_info.get("columns", [])
        rows = table_info.get("rows", [])
        add_desc = item.get("add_description", "")
        question = item["description"]
        label = item.get("label", [])
        expected = label[0] if label else ""
        col_names = [c["name"] for c in columns]
        header = ", ".join(col_names)
        data_rows = []
        for r in rows[:50]:
            data_rows.append(", ".join(str(v) for v in r))
        table_text = f"Table: {table_name}\nColumns: {header}\nDescription: {add_desc}\nRows:\n" + "\n".join(data_rows)
        prompt = f"""You have access to a data table. Answer the question based on the table.

{table_text}

Question: {question}

You can use the run_code tool to process the data. Reply with ONLY the answer, nothing else."""
        tasks.append({
            "id": f"AB-DB-{existing_db+i+1:03d}",
            "category": "db_bench",
            "source": "AgentBench/DB-Bench",
            "question": question,
            "prompt": prompt,
            "expected": expected,
        })

# Save
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(tasks, f, indent=2, ensure_ascii=False)

# Summary
cats = {}
for t in tasks:
    cats[t["category"]] = cats.get(t["category"], 0) + 1
print(f"Extracted {len(tasks)} AgentBench tasks")
for cat, count in sorted(cats.items()):
    print(f"  {cat}: {count}")
print(f"Saved to: {OUT}")
