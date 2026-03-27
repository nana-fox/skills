# skills

> Cross-model verification skills for AI collaboration.

Single AI models fail silently by rationalizing errors fluently. These skills break echo chambers by introducing independent model verification.

**Core principle: Two models agreeing does not equal correctness. Truth comes from execution verification, not model consensus.**

---

## Available Skills

| Skill | Description |
|-------|-------------|
| [codex-buddy](./skills/codex-buddy/) | Claude-Codex cross-model verification with V0-V3 levels, evidence packaging, and Probe/Follow-up/Challenge protocols |

---

## Installation

### Claude Code (Plugin Marketplace)

```bash
/plugin marketplace add ddnio/skills
/plugin install buddy-skills@buddy-skills
```

### Manual Installation

```bash
# Clone the repo
git clone https://github.com/ddnio/skills.git

# Copy skill to personal skills directory
mkdir -p ~/.claude/skills/codex-buddy
cp skills/codex-buddy/SKILL.md ~/.claude/skills/codex-buddy/
```

### Prerequisites

Each buddy skill requires its corresponding CLI tool:

- **codex-buddy**: [Codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`)

---

## Architecture

```
skills/
├── .claude-plugin/
│   └── marketplace.json      # Plugin marketplace index
├── skills/
│   ├── codex-buddy/          # Claude-Codex verification
│   │   ├── SKILL.md          # Skill definition (runtime)
│   │   ├── references/       # CLI examples, workflow docs (runtime)
│   │   ├── scripts/          # Sync and verify scripts
│   │   ├── discussions/      # Cross-model dialogue records (dev only)
│   │   └── evals/            # Trigger evaluation tests (dev only)
│   └── ...                   # Future: gemini-buddy, etc.
└── README.md
```

**Runtime vs Development assets:**
- Runtime: `SKILL.md`, `references/`, `scripts/` -- distributed to users
- Development: `discussions/`, `evals/`, `STATUS.md`, `CHANGELOG.md` -- repo only

---

## License

[MIT](./LICENSE)
