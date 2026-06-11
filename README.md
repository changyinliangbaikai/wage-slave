# Xiao Niu Ma (小小牛马) 🐱

> "Life is short, make it sweet." — Inspired by Li Bai

A desktop pixel cat helper to accompany you at work.

📖 **中文版文档**：关于本项目的中译指南，请参阅 [README_CN.md](README_CN.md)。  
*(For the Chinese version, please refer to [README_CN.md](README_CN.md).)*

![Pixel Cat Preview](docs/imgs/cat_happy_2.png)

---

## About the Thing Called "Work"

We are taught to work hard, to be efficient, and to deliver output.

But rarely does anyone ask us: **Who are you working for?**

At the start of the day, you sit at your desk and open your computer. At the end of the day, you close it and leave. In between those 8, 10, or 12 hours—where did *you* go?

You completed tasks, replied to emails, and attended meetings. But did these things truly make up your day?

Sometimes you feel lost: *I was clearly busy all day, so why do I feel like I accomplished nothing?*

**This is not your fault. This is the nature of modern work—it devours time without leaving a trace.**

---

## Why We Get Lost

Work was meant to be a part of life, but now it has become all of it.

The first thing you do when you wake up is check work notifications. The last thing you think about before sleeping is work.

Weekends are meant for rest, but you are so exhausted from the week that you don't want to do anything at all.

When writing monthly summaries, you sift through chats and emails but still can't piece together what your month actually looked like.

**You have become a tool, rather than the person using it.**

---

## What Xiao Niu Ma Wants to Tell You

This is not a tool to help you "work more efficiently."

**This is a tool to remind you that "you are still alive."**

It won't make you a better wage slave. It wants you to realize: **You don't have to be one.**

---

## The Meaning of Logging

We do not write logs to prove what we have done.

We write them to **see ourselves**.

In the flood of busyness, it is so easy to forget who we are, to lose track of time, and to forget the texture of living.

Xiao Niu Ma helps you log your day, not so you can report it to someone else, but so that at some point, you can stop, look back, and see the path you have walked.

**These records are the footprints of your life.**

---

## What We Truly Want to Say

We hope that one day, you won't need this tool anymore.

We hope that one day, you will know exactly what you are doing and why you are doing it.

We hope that one day, you can log off on time, enjoy your weekends, and have time that truly belongs to you.

We hope that one day, you will no longer be a wage slave, but just yourself.

**But until that day comes, Xiao Niu Ma will be here to keep you company.**

---

## Data Security

- All data is stored locally on your machine and will never be uploaded to any server.
- API Keys are securely stored in the system credential manager (Windows Credential Manager / macOS Keychain) and are never written to files.
- Your work logs and todo lists are saved as standard JSON files, which you can view or back up at any time.

---

## Features

- **Morning Greetings**: Automatically pops up at the start of work. Input your plan in natural language and the AI will parse it into a structured Todo list.
- **Break Reminders**: Monitors continuous mouse and keyboard usage, reminding you to take a break when threshold is reached. Supports "Snooze".
- **Evening Reviews**: Pops up at the end of work to check off todos and record your daily log.
- **Periodic Summary**: Reads local logs to generate AI-driven monthly or quarterly work summaries.
- **Pixel Orange Cat**: Drags anywhere on the desktop, auto-hides at screen edges, and changes animation states based on application activity (Idle, Petting, Celebrate, Busy).
- **LLM Compatibility**: Supports any OpenAI API-compatible services (OpenAI, Claude, DeepSeek, local Ollama, etc.).
- **Utility Toolbox**: Built-in useful utilities including Spell Check (LLM-based) and a local Shell Task Scheduler.
- **AI Agent**: Autonomously plans and executes local file management, terminal command execution, and task scheduling using multi-round ReAct loops.
- **Skill Center**: Search, install, configure, and uninstall skills from the market or via files/zips/URLs.
- **Agent Cron**: Runs independent Agent-driven workflows on cron schedules, allowing the Agent to autonomously plan tasks when triggered.
- **Security Guard**: Built-in safety guards including command blacklists, double-confirmations for sensitive actions, and tool permission controls.

---

## Documentation

- [Development and Startup Guide](docs/develop.md)
- [Architecture Guide](docs/architecture.md)
- [Utility Toolbox Guide](docs/tools.md)
- [Agent Tools Guide](docs/agent-tools.md)
- [Pet Pack Specification](docs/pet-pack-spec.md)

---

## License

MIT
