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
/plugin install codex-buddy@ddnio-skills
```

### Manual Installation

```bash
# Clone the repo
git clone https://github.com/ddnio/skills.git
cd skills

# Option 1: Symlink (auto-updates on git pull)
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/codex-buddy" ~/.claude/skills/codex-buddy

# Option 2: Copy (re-run after updates)
bash skills/codex-buddy/scripts/sync-skill.sh

# Verify installation
bash skills/codex-buddy/scripts/verify-install.sh
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
│   │   ├── .claude-plugin/plugin.json  # Plugin metadata (required for install)
│   │   ├── SKILL.md          # Skill definition (runtime)
│   │   ├── references/       # CLI examples (runtime)
│   │   ├── scripts/          # Sync, verify-repo, verify-install scripts
│   │   ├── docs/             # Development workflow docs (dev only)
│   │   ├── discussions/      # Cross-model dialogue records (dev only)
│   │   └── evals/            # Trigger evaluation tests (dev only)
│   └── ...                   # Future: gemini-buddy, etc.
└── README.md
```

**Runtime vs Development assets:**
- Runtime: `SKILL.md`, `references/` -- loaded by AI agents
- Development: `docs/`, `scripts/`, `discussions/`, `evals/`, `STATUS.md`, `CHANGELOG.md` -- repo only

---

## License

[MIT](./LICENSE)
