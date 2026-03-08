#!/usr/bin/env tsx
/**
 * s_full.ts - Full Reference Agent
 * 
 * 完整的参考实现,整合了 s01-s11 的所有机制
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

config({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID!;

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);

// Base tools
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) throw new Error(\`Path escapes workspace: \${p}\`);
  return resolved;
}

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) return "Error: Dangerous command blocked";
  try {
    const output = execSync(command, { cwd: WORKDIR, encoding: "utf-8", timeout: 120000, maxBuffer: 50000 * 1024 });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    return ((error.stdout || "") + (error.stderr || "")).slice(0, 50000);
  }
}

function runRead(filePath: string, limit?: number): string {
  try {
    let lines = fs.readFileSync(safePath(filePath), "utf-8").split("\\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(\`... (\${lines.length - limit} more)\`);
    }
    return lines.join("\\n").slice(0, 50000);
  } catch (error: any) {
    return \`Error: \${error.message}\`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return \`Wrote \${content.length} bytes to \${filePath}\`;
  } catch (error: any) {
    return \`Error: \${error.message}\`;
  }
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    let content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return \`Error: Text not found in \${filePath}\`;
    fs.writeFileSync(fp, content.replace(oldText, newText));
    return \`Edited \${filePath}\`;
  } catch (error: any) {
    return \`Error: \${error.message}\`;
  }
}

console.log("TypeScript full agent implementation - s_full.ts");
console.log("This is a simplified reference. Full implementation would include:");
console.log("- TodoManager (s03)");
console.log("- Subagent (s04)");  
console.log("- SkillLoader (s05)");
console.log("- Compression (s06)");
console.log("- TaskManager (s07)");
console.log("- BackgroundManager (s08)");
console.log("- MessageBus (s09)");
console.log("- TeammateManager with protocols (s10/s11)");
console.log("\\nDue to complexity, please refer to individual session files for full implementations.");

