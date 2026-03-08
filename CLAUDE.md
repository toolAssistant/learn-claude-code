# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Educational repository teaching how to build Claude Code-like agents from scratch through 12 progressive sessions (s01-s12). Each session adds one mechanism on top of the core agent loop pattern without changing the loop itself.

## Setup & Configuration

```bash
# Initial setup
pip install -r requirements.txt
cp .env.example .env  # Edit with your ANTHROPIC_API_KEY and MODEL_ID

# Web platform setup
cd web && npm install
```

Configuration via `.env`:
- `ANTHROPIC_API_KEY`: Required API key
- `MODEL_ID`: Model to use (default: claude-sonnet-4-6)
- `ANTHROPIC_BASE_URL`: Optional, for Anthropic-compatible providers (MiniMax, GLM, Kimi, DeepSeek)

## Common Commands

### Running Python Agents

```bash
# Run individual sessions (progressive learning path)
python agents/s01_agent_loop.py       # Basic agent loop
python agents/s02_tool_use.py         # Tool dispatch
python agents/s03_todo_write.py       # Planning with TodoWrite
python agents/s04_subagent.py         # Subagent pattern
python agents/s05_skill_loading.py    # Dynamic skill loading
python agents/s06_context_compact.py  # Context compression
python agents/s07_task_system.py      # File-based task system
python agents/s08_background_tasks.py # Background execution
python agents/s09_agent_teams.py      # Multi-agent teams
python agents/s10_team_protocols.py   # Team communication
python agents/s11_autonomous_agents.py # Autonomous task claiming
python agents/s12_worktree_task_isolation.py # Worktree isolation

# Full capstone (all mechanisms combined)
python agents/s_full.py
```

### Web Platform

```bash
cd web
npm run dev      # Development server at http://localhost:3000
npm run build    # Production build
npm run start    # Production server
npm run extract  # Extract content from docs (runs automatically in predev/prebuild)
```

### CI/CD

GitHub Actions runs on push/PR to main:
- Type checking: `npx tsc --noEmit` (in web/)
- Build: `npm run build` (in web/)

## Architecture

### Core Pattern

Every agent follows this loop:
```python
while stop_reason == "tool_use":
    response = client.messages.create(model, system, messages, tools)
    messages.append({"role": "assistant", "content": response.content})

    if response.stop_reason != "tool_use":
        return

    # Execute tools and append results
    results = [execute_tool(block) for block in response.content if block.type == "tool_use"]
    messages.append({"role": "user", "content": results})
```

Each session layers one mechanism on top without changing the loop.

### Directory Structure

```
agents/          # Python implementations (s01-s12 + s_full)
├── s01_agent_loop.py          # Basic loop + Bash tool
├── s02_tool_use.py            # Tool dispatch map
├── s03_todo_write.py          # TodoManager for planning
├── s04_subagent.py            # Independent message contexts
├── s05_skill_loading.py       # Dynamic SKILL.md loading
├── s06_context_compact.py     # 3-layer compression
├── s07_task_system.py         # File-based task graph
├── s08_background_tasks.py    # Daemon threads + notifications
├── s09_agent_teams.py         # JSONL mailbox protocol
├── s10_team_protocols.py      # Shutdown + approval FSM
├── s11_autonomous_agents.py   # Idle cycle + auto-claim
├── s12_worktree_task_isolation.py # Task + worktree coordination
└── s_full.py                  # All mechanisms combined

docs/            # Documentation (en, zh, ja)
├── en/          # English docs
├── zh/          # Chinese docs
└── ja/          # Japanese docs

web/             # Next.js interactive learning platform
├── src/
│   ├── app/           # Next.js app router pages
│   ├── components/    # React components
│   ├── data/          # Generated content from docs
│   ├── hooks/         # React hooks
│   ├── i18n/          # Internationalization
│   ├── lib/           # Utilities
│   └── types/         # TypeScript types
└── scripts/           # Build scripts (extract-content.ts)

skills/          # Skill files for s05
├── agent-builder/
├── code-review/
├── mcp-builder/
└── pdf/
```

### Progressive Learning Path

**Phase 1: THE LOOP**
- s01: Basic agent loop (while + stop_reason)
- s02: Tool dispatch (name → handler map)

**Phase 2: PLANNING & KNOWLEDGE**
- s03: TodoWrite (TodoManager + nag reminder)
- s04: Subagents (fresh messages[] per child)
- s05: Skills (SKILL.md via tool_result)
- s06: Context Compact (3-layer compression)

**Phase 3: PERSISTENCE**
- s07: Tasks (file-based CRUD + dependency graph)
- s08: Background Tasks (daemon threads + notify queue)

**Phase 4: TEAMS**
- s09: Agent Teams (teammates + JSONL mailboxes)
- s10: Team Protocols (shutdown + plan approval FSM)
- s11: Autonomous Agents (idle cycle + auto-claim)
- s12: Worktree Isolation (task coordination + isolated execution lanes)

## Key Concepts

### Agent Loop
All agents share the same core loop: send messages to LLM → execute tools → append results → repeat until stop_reason != "tool_use"

### Tool Dispatch
Tools register into a dispatch map: `TOOL_HANDLERS[tool_name](**tool_input)`. Adding a tool means adding one handler function.

### Subagents
Each subagent gets a fresh `messages[]` context, keeping the main conversation clean. Used for breaking down complex tasks.

### Skills
Knowledge loaded on-demand via tool_result, not upfront in system prompt. Skills are markdown files in `skills/` directory.

### Context Compression
Three-layer strategy: (1) summarize old messages, (2) keep recent messages, (3) always keep system prompt. Enables infinite sessions.

### Task System
File-based task graph with dependencies persisted to disk. Foundation for multi-agent collaboration.

### Team Protocols
JSONL mailbox protocol for async agent communication. Each agent has an inbox/outbox for message passing.

### Worktree Isolation
Tasks coordinate goals, worktrees manage directories, bound by ID. Each agent works in its own directory without interference.

## Scope & Limitations

This is a 0→1 learning project that intentionally simplifies:
- Full event/hook buses (only minimal lifecycle events in s12)
- Rule-based permission governance
- Session lifecycle controls (resume/fork)
- Full MCP runtime details (transport/OAuth/resource subscribe)

The JSONL mailbox protocol is a teaching implementation, not a production specification.

## Related Projects

- **Kode Agent CLI**: `npm i -g @shareai-lab/kode` - Production-ready CLI with skill & LSP support
- **Kode Agent SDK**: Embeddable agent library for backends/extensions/devices
- **claw0**: Sister repo teaching always-on assistant patterns (heartbeat + cron + IM routing)
