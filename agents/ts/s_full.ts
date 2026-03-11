#!/usr/bin/env tsx
/**
 * s_full.ts - 完整参考 Agent
 *
 * 整合 s01-s11 所有机制的顶点实现。
 * Session s12（任务感知的 worktree 隔离）单独教学。
 * 这不是教学 session —— 这是"整合一切"的参考实现。
 *
 *    +------------------------------------------------------------------+
 *    |                        完整 AGENT                                 |
 *    |                                                                   |
 *    |  系统提示词 (s05 技能, 任务优先 + 可选 todo 唠叨)                  |
 *    |                                                                   |
 *    |  每次 LLM 调用前:                                                 |
 *    |  +--------------------+  +------------------+  +--------------+  |
 *    |  | Microcompact (s06) |  | 排空后台 (s08)   |  | 检查收件箱   |  |
 *    |  | Auto-compact (s06) |  | 通知             |  | (s09)        |  |
 *    |  +--------------------+  +------------------+  +--------------+  |
 *    |                                                                   |
 *    |  工具调度 (s02 模式):                                             |
 *    |  +--------+----------+----------+---------+-----------+          |
 *    |  | bash   | read     | write    | edit    | TodoWrite |          |
 *    |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *    |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *    |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *    |  | plan   | idle     | claim    |         |           |          |
 *    |  +--------+----------+----------+---------+-----------+          |
 *    |                                                                   |
 *    |  子代理 (s04):  spawn -> work -> return summary                  |
 *    |  队友 (s09):    spawn -> work -> idle -> auto-claim (s11)        |
 *    |  关闭 (s10):    request_id 握手                                   |
 *    |  计划门控 (s10): submit -> approve/reject                         |
 *    +------------------------------------------------------------------+
 *
 *    REPL 命令: /compact /tasks /team /inbox
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// 加载环境变量
config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 工作目录和客户端初始化
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;

// 目录配置
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");

// 配置常量
const TOKEN_THRESHOLD = 100000; // Token 阈值触发自动压缩
const POLL_INTERVAL = 5; // 空闲轮询间隔（秒）
const IDLE_TIMEOUT = 60; // 空闲超时（秒）

// 有效消息类型
const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// === SECTION: base_tools (基础工具) ===

/**
 * 安全路径检查：防止路径遍历攻击
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * 执行 bash 命令
 */
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      maxBuffer: 50000 * 1024,
    });
    return output.trim() || "(no output)";
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message;
    return stderr.slice(0, 50000);
  }
}

/**
 * 读取文件
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more)`]
        .join("\n")
        .slice(0, 50000);
    }
    return text.slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件
 */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// === SECTION: todos (s03 - TodoManager) ===

/**
 * Todo 项接口
 */
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

/**
 * TodoManager 类：管理任务追踪列表
 */
class TodoManager {
  private items: TodoItem[] = [];

  /**
   * 更新 todo 列表
   */
  update(items: any[]): string {
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const activeForm = String(item.activeForm || "").trim();

      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${i}: invalid status '${status}'`);
      }
      if (!activeForm) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") inProgressCount++;

      validated.push({
        content,
        status: status as TodoItem["status"],
        activeForm,
      });
    }

    if (validated.length > 20) throw new Error("Max 20 todos");
    if (inProgressCount > 1) throw new Error("Only one in_progress allowed");

    this.items = validated;
    return this.render();
  }

  /**
   * 渲染 todo 列表
   */
  render(): string {
    if (this.items.length === 0) return "No todos.";

    const lines: string[] = [];
    for (const item of this.items) {
      const marker =
        item.status === "completed"
          ? "[x]"
          : item.status === "in_progress"
          ? "[>]"
          : "[ ]";
      const suffix =
        item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${marker} ${item.content}${suffix}`);
    }

    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }

  /**
   * 检查是否有未完成项
   */
  hasOpenItems(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// === SECTION: subagent (s04 - 子代理) ===

/**
 * 运行子代理：独立上下文执行任务
 */
async function runSubagent(
  prompt: string,
  agentType: string = "Explore"
): Promise<string> {
  // 子代理工具定义
  const subTools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: "Run command.",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read file.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];

  // 非 Explore 类型添加写入工具
  if (agentType !== "Explore") {
    subTools.push(
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      }
    );
  }

  // 子代理工具处理器
  const subHandlers: Record<string, (input: any) => string> = {
    bash: (input) => runBash(input.command),
    read_file: (input) => runRead(input.path),
    write_file: (input) => runWrite(input.path, input.content),
    edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  };

  // 子代理消息历史（独立上下文）
  const subMessages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  let resp: Anthropic.Message | null = null;

  // 子代理循环（最多 30 轮）
  for (let i = 0; i < 30; i++) {
    resp = await client.messages.create({
      model: MODEL,
      messages: subMessages,
      tools: subTools,
      max_tokens: 8000,
    });

    subMessages.push({
      role: "assistant",
      content: resp.content,
    });

    if (resp.stop_reason !== "tool_use") {
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type === "tool_use") {
        const handler = subHandlers[block.name] || (() => "Unknown tool");
        const output = handler(block.input);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output.slice(0, 50000),
        });
      }
    }

    subMessages.push({
      role: "user",
      content: results,
    });
  }

  // 返回最终文本摘要
  if (resp) {
    const textBlocks = resp.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("") || "(no summary)";
  }

  return "(subagent failed)";
}

// === SECTION: skills (s05 - 技能加载) ===

/**
 * 技能元数据接口
 */
interface SkillMeta {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

/**
 * 技能数据接口
 */
interface SkillData {
  meta: SkillMeta;
  body: string;
}

/**
 * SkillLoader 类：加载和管理技能文件
 */
class SkillLoader {
  private skills: Record<string, SkillData> = {};

  constructor(skillsDir: string) {
    if (fs.existsSync(skillsDir)) {
      const files = this.findSkillFiles(skillsDir);
      for (const file of files) {
        const text = fs.readFileSync(file, "utf-8");
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
        let meta: SkillMeta = {};
        let body = text;

        if (match) {
          // 解析 YAML 前置元数据
          const metaText = match[1].trim();
          for (const line of metaText.split("\n")) {
            if (line.includes(":")) {
              const [key, ...valueParts] = line.split(":");
              meta[key.trim()] = valueParts.join(":").trim();
            }
          }
          body = match[2].trim();
        }

        const name = meta.name || path.basename(path.dirname(file));
        this.skills[name] = { meta, body };
      }
    }
  }

  /**
   * 递归查找所有 SKILL.md 文件
   */
  private findSkillFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findSkillFiles(fullPath));
      } else if (entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }

    return results.sort();
  }

  /**
   * 获取所有技能的描述
   */
  descriptions(): string {
    if (Object.keys(this.skills).length === 0) return "(no skills)";
    return Object.entries(this.skills)
      .map(([name, skill]) => `  - ${name}: ${skill.meta.description || "-"}`)
      .join("\n");
  }

  /**
   * 加载指定技能
   */
  load(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      const available = Object.keys(this.skills).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// === SECTION: compression (s06 - 上下文压缩) ===

/**
 * 估算消息列表的 token 数量
 */
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

/**
 * 微压缩：清理旧的 tool_result 内容
 */
function microcompact(messages: Anthropic.MessageParam[]): void {
  const toolResults: any[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "tool_result"
        ) {
          toolResults.push(part);
        }
      }
    }
  }

  // 保留最近 3 个，清理其余
  if (toolResults.length > 3) {
    for (let i = 0; i < toolResults.length - 3; i++) {
      const part = toolResults[i];
      if (typeof part.content === "string" && part.content.length > 100) {
        part.content = "[cleared]";
      }
    }
  }
}

/**
 * 自动压缩：生成摘要并保存完整记录
 */
async function autoCompact(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  // 保存完整记录
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  fs.writeFileSync(transcriptPath, lines);

  // 生成摘要
  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content: `Summarize for continuity:\n${convText}`,
      },
    ],
    max_tokens: 2000,
  });

  const summary =
    resp.content.find((b): b is Anthropic.TextBlock => b.type === "text")
      ?.text || "(no summary)";

  return [
    {
      role: "user",
      content: `[Compressed. Transcript: ${transcriptPath}]\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. Continuing with summary context.",
    },
  ];
}

// === SECTION: file_tasks (s07 - 任务系统) ===

/**
 * 任务接口
 */
interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

/**
 * TaskManager 类：管理持久化任务
 */
class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  /**
   * 获取下一个任务 ID
   */
  private nextId(): number {
    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_"));
    const ids = files.map((f) => parseInt(f.split("_")[1]));
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
  }

  /**
   * 加载任务
   */
  private loadTask(taskId: number): Task {
    const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
    if (!fs.existsSync(taskPath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  }

  /**
   * 保存任务
   */
  private saveTask(task: Task): void {
    const taskPath = path.join(TASKS_DIR, `task_${task.id}.json`);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  }

  /**
   * 创建任务
   */
  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    this.saveTask(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 获取任务详情
   */
  get(taskId: number): string {
    return JSON.stringify(this.loadTask(taskId), null, 2);
  }

  /**
   * 更新任务
   */
  update(
    taskId: number,
    status?: string,
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.loadTask(taskId);

    if (status) {
      task.status = status as Task["status"];

      // 任务完成时，解除其他任务的阻塞
      if (status === "completed") {
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_"));
        for (const file of files) {
          const otherTask: Task = JSON.parse(
            fs.readFileSync(path.join(TASKS_DIR, file), "utf-8")
          );
          if (otherTask.blockedBy.includes(taskId)) {
            otherTask.blockedBy = otherTask.blockedBy.filter((id) => id !== taskId);
            this.saveTask(otherTask);
          }
        }
      }

      // 删除任务
      if (status === "deleted") {
        fs.unlinkSync(path.join(TASKS_DIR, `task_${taskId}.json`));
        return `Task ${taskId} deleted`;
      }
    }

    if (addBlockedBy) {
      const combined = [...task.blockedBy, ...addBlockedBy];
      task.blockedBy = Array.from(new Set(combined));
    }

    if (addBlocks) {
      const combined = [...task.blocks, ...addBlocks];
      task.blocks = Array.from(new Set(combined));
    }

    this.saveTask(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 列出所有任务
   */
  listAll(): string {
    const files = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => f.startsWith("task_"))
      .sort();

    if (files.length === 0) return "No tasks.";

    const tasks: Task[] = files.map((f) =>
      JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"))
    );

    const lines: string[] = [];
    for (const task of tasks) {
      const marker =
        task.status === "completed"
          ? "[x]"
          : task.status === "in_progress"
          ? "[>]"
          : "[ ]";
      const owner = task.owner ? ` @${task.owner}` : "";
      const blocked =
        task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy})` : "";
      lines.push(`${marker} #${task.id}: ${task.subject}${owner}${blocked}`);
    }

    return lines.join("\n");
  }

  /**
   * 认领任务
   */
  claim(taskId: number, owner: string): string {
    const task = this.loadTask(taskId);
    task.owner = owner;
    task.status = "in_progress";
    this.saveTask(task);
    return `Claimed task #${taskId} for ${owner}`;
  }
}

// === SECTION: background (s08 - 后台任务) ===

/**
 * 后台任务接口
 */
interface BackgroundTask {
  status: "running" | "completed" | "error";
  command: string;
  result: string | null;
}

/**
 * 通知接口
 */
interface Notification {
  task_id: string;
  status: string;
  result: string;
}

/**
 * BackgroundManager 类：管理后台任务
 */
class BackgroundManager {
  private tasks: Record<string, BackgroundTask> = {};
  private notifications: Notification[] = [];

  /**
   * 运行后台命令
   */
  run(command: string, timeout: number = 120): string {
    const taskId = this.generateId();
    this.tasks[taskId] = {
      status: "running",
      command,
      result: null,
    };

    // 使用 child_process.exec 后台执行
    exec(
      command,
      {
        cwd: WORKDIR,
        timeout: timeout * 1000,
        maxBuffer: 50000 * 1024,
      },
      (error, stdout, stderr) => {
        const output = (stdout + stderr).trim().slice(0, 50000);
        if (error) {
          this.tasks[taskId].status = "error";
          this.tasks[taskId].result = error.message;
        } else {
          this.tasks[taskId].status = "completed";
          this.tasks[taskId].result = output || "(no output)";
        }

        this.notifications.push({
          task_id: taskId,
          status: this.tasks[taskId].status,
          result: this.tasks[taskId].result!.slice(0, 500),
        });
      }
    );

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * 检查后台任务状态
   */
  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks[taskId];
      if (!task) return `Unknown: ${taskId}`;
      return `[${task.status}] ${task.result || "(running)"}`;
    }

    const lines = Object.entries(this.tasks).map(
      ([id, task]) => `${id}: [${task.status}] ${task.command.slice(0, 60)}`
    );
    return lines.length > 0 ? lines.join("\n") : "No bg tasks.";
  }

  /**
   * 排空通知队列
   */
  drain(): Notification[] {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}

// === SECTION: messaging (s09 - 消息总线) ===

/**
 * 消息接口
 */
interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: any;
}

/**
 * MessageBus 类：管理 JSONL 收件箱
 */
class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  /**
   * 发送消息
   */
  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = "message",
    extra?: Record<string, any>
  ): string {
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
      ...extra,
    };

    const inboxPath = path.join(INBOX_DIR, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  /**
   * 读取并清空收件箱
   */
  readInbox(name: string): Message[] {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];

    const text = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!text) return [];

    const messages = text
      .split("\n")
      .filter((line) => line)
      .map((line) => JSON.parse(line));

    // 清空收件箱
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  /**
   * 广播消息
   */
  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const name of names) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// === SECTION: shutdown + plan tracking (s10 - 关闭和计划跟踪) ===

/**
 * 关闭请求跟踪
 */
const shutdownRequests: Record<
  string,
  { target: string; status: string }
> = {};

/**
 * 计划请求跟踪
 */
const planRequests: Record<
  string,
  { from: string; status: string; [key: string]: any }
> = {};

// === SECTION: team (s09/s11 - 团队管理) ===

/**
 * 团队成员接口
 */
interface TeamMember {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

/**
 * 团队配置接口
 */
interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

/**
 * TeammateManager 类：管理自主队友
 */
class TeammateManager {
  private bus: MessageBus;
  private taskMgr: TaskManager;
  private configPath: string;
  private config: TeamConfig;

  constructor(bus: MessageBus, taskMgr: TaskManager) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.bus = bus;
    this.taskMgr = taskMgr;
    this.configPath = path.join(TEAM_DIR, "config.json");
    this.config = this.loadConfig();
  }

  /**
   * 加载团队配置
   */
  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  /**
   * 保存团队配置
   */
  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * 查找成员
   */
  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  /**
   * 生成队友
   */
  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);

    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }

    this.saveConfig();

    // 启动队友循环（异步）
    this.startLoop(name, role, prompt);

    return `Spawned '${name}' (role: ${role})`;
  }

  /**
   * 设置成员状态
   */
  private setStatus(name: string, status: TeamMember["status"]): void {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  /**
   * 队友主循环：工作阶段 + 空闲阶段
   */
  private async startLoop(
    name: string,
    role: string,
    prompt: string
  ): Promise<void> {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle when done with current work. You may auto-claim tasks.`;

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: prompt },
    ];

    // 队友工具定义
    const tools: Anthropic.Tool[] = [
      {
        name: "bash",
        description: "Run command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Edit file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message.",
        input_schema: {
          type: "object",
          properties: { to: { type: "string" }, content: { type: "string" } },
          required: ["to", "content"],
        },
      },
      {
        name: "idle",
        description: "Signal no more work.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim task by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "number" } },
          required: ["task_id"],
        },
      },
    ];

    while (true) {
      // -- 工作阶段（最多 50 轮）--
      for (let i = 0; i < 50; i++) {
        // 检查收件箱
        const inbox = this.bus.readInbox(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        // LLM 调用
        let response: Anthropic.Message;
        try {
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });
        } catch (error) {
          this.setStatus(name, "shutdown");
          return;
        }

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") {
          break;
        }

        // 工具执行
        const results: Anthropic.ToolResultBlockParam[] = [];
        let idleRequested = false;

        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;

            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase.";
            } else if (block.name === "claim_task") {
              output = this.taskMgr.claim(
                (block.input as any).task_id,
                name
              );
            } else if (block.name === "send_message") {
              const input = block.input as any;
              output = this.bus.send(name, input.to, input.content);
            } else {
              // 基础工具调度
              const dispatch: Record<string, (input: any) => string> = {
                bash: (input) => runBash(input.command),
                read_file: (input) => runRead(input.path),
                write_file: (input) => runWrite(input.path, input.content),
                edit_file: (input) =>
                  runEdit(input.path, input.old_text, input.new_text),
              };
              output = dispatch[block.name]?.(block.input) || "Unknown";
            }

            console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
          }
        }

        messages.push({ role: "user", content: results });

        if (idleRequested) {
          break;
        }
      }

      // -- 空闲阶段：轮询消息和未认领任务 --
      this.setStatus(name, "idle");
      let resume = false;

      const maxPolls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((resolve) =>
          setTimeout(resolve, POLL_INTERVAL * 1000)
        );

        // 检查收件箱
        const inbox = this.bus.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        // 检查未认领任务
        const unclaimed: Task[] = [];
        const files = fs
          .readdirSync(TASKS_DIR)
          .filter((f) => f.startsWith("task_"))
          .sort();

        for (const file of files) {
          const task: Task = JSON.parse(
            fs.readFileSync(path.join(TASKS_DIR, file), "utf-8")
          );
          if (
            task.status === "pending" &&
            !task.owner &&
            task.blockedBy.length === 0
          ) {
            unclaimed.push(task);
          }
        }

        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);

          // 身份重注入（用于压缩后的上下文）
          if (messages.length <= 3) {
            messages.unshift(
              {
                role: "user",
                content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>`,
              },
              {
                role: "assistant",
                content: `I am ${name}. Continuing.`,
              }
            );
          }

          messages.push({
            role: "user",
            content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description}</auto-claimed>`,
          });
          messages.push({
            role: "assistant",
            content: `Claimed task #${task.id}. Working on it.`,
          });

          resume = true;
          break;
        }
      }

      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }

      this.setStatus(name, "working");
    }
  }

  /**
   * 列出所有队友
   */
  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";

    const lines = [`Team: ${this.config.team_name}`];
    for (const member of this.config.members) {
      lines.push(`  ${member.name} (${member.role}): ${member.status}`);
    }
    return lines.join("\n");
  }

  /**
   * 获取所有成员名称
   */
  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

// === SECTION: global_instances (全局实例) ===

const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

// === SECTION: system_prompt (系统提示词) ===

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;

// === SECTION: shutdown_protocol (s10 - 关闭协议) ===

/**
 * 处理关闭请求
 */
function handleShutdownRequest(teammate: string): string {
  const reqId = Math.random().toString(36).substring(2, 10);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

// === SECTION: plan_approval (s10 - 计划审批) ===

/**
 * 处理计划审批
 */
function handlePlanReview(
  requestId: string,
  approve: boolean,
  feedback: string = ""
): string {
  const req = planRequests[requestId];
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;

  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });

  return `Plan ${req.status} for '${req.from}'`;
}

// === SECTION: tool_dispatch (s02 - 工具调度) ===

/**
 * 工具处理器映射
 */
const TOOL_HANDLERS: Record<string, (input: any) => string | Promise<string>> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  TodoWrite: (input) => TODO.update(input.items),
  task: async (input) => await runSubagent(input.prompt, input.agent_type),
  load_skill: (input) => SKILLS.load(input.name),
  compress: () => "Compressing...",
  background_run: (input) => BG.run(input.command, input.timeout),
  check_background: (input) => BG.check(input.task_id),
  task_create: (input) => TASK_MGR.create(input.subject, input.description),
  task_get: (input) => TASK_MGR.get(input.task_id),
  task_update: (input) =>
    TASK_MGR.update(
      input.task_id,
      input.status,
      input.add_blocked_by,
      input.add_blocks
    ),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: (input) => TEAM.spawn(input.name, input.role, input.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (input) =>
    BUS.send("lead", input.to, input.content, input.msg_type),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (input) => BUS.broadcast("lead", input.content, TEAM.memberNames()),
  shutdown_request: (input) => handleShutdownRequest(input.teammate),
  plan_approval: (input) =>
    handlePlanReview(input.request_id, input.approve, input.feedback),
  idle: () => "Lead does not idle.",
  claim_task: (input) => TASK_MGR.claim(input.task_id, "lead"),
};

/**
 * 工具定义数组
 */
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "TodoWrite",
    description: "Update task tracking list.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: { type: "string" },
            },
            required: ["content", "status", "activeForm"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "task",
    description: "Spawn a subagent for isolated exploration or work.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        agent_type: {
          type: "string",
          enum: ["Explore", "general-purpose"],
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "compress",
    description: "Manually compress conversation context.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "background_run",
    description: "Run command in background thread.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
    },
  },
  {
    name: "task_create",
    description: "Create a persistent file task.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "Update task status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        add_blocked_by: { type: "array", items: { type: "number" } },
        add_blocks: { type: "array", items: { type: "number" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent autonomous teammate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: {
          type: "string",
          enum: Array.from(VALID_MSG_TYPES),
        },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send message to all teammates.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
    },
  },
];

// === SECTION: agent_loop (主循环) ===

/**
 * Agent 主循环
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsWithoutTodo = 0;

  while (true) {
    // s06: 压缩管道
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // s08: 排空后台通知
    const notifs = BG.drain();
    if (notifs.length > 0) {
      const txt = notifs
        .map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${txt}\n</background-results>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
    }

    // s10: 检查 lead 收件箱
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
    }

    // LLM 调用
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 工具执行
    const results: Anthropic.ToolResultBlockParam[] = [];
    let usedTodo = false;
    let manualCompress = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") {
          manualCompress = true;
        }

        const handler = TOOL_HANDLERS[block.name];
        let output: string;

        try {
          const result = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          // 处理 Promise（如 task 工具）
          output = result instanceof Promise ? await result : result;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }

        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });

        if (block.name === "TodoWrite") {
          usedTodo = true;
        }
      }
    }

    // s03: nag reminder（仅当 todo 工作流活跃时）
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;

    let finalContent: Anthropic.MessageParam["content"];
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      // 添加 reminder 作为文本块
      finalContent = [
        { type: "text" as const, text: "<reminder>Update your todos.</reminder>" },
        ...results,
      ];
    } else {
      finalContent = results;
    }

    messages.push({ role: "user", content: finalContent });

    // s06: 手动压缩
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// === SECTION: repl (交互式命令行) ===

/**
 * 主函数：启动 REPL
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms_full >> \x1b[0m",
  });

  rl.prompt();

  rl.on("line", async (query: string) => {
    const trimmed = query.trim().toLowerCase();

    // 退出命令
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") {
      rl.close();
      return;
    }

    // /compact 命令
    if (query.trim() === "/compact") {
      if (history.length > 0) {
        console.log("[manual compact via /compact]");
        const compacted = await autoCompact(history);
        history.splice(0, history.length, ...compacted);
      }
      rl.prompt();
      return;
    }

    // /tasks 命令
    if (query.trim() === "/tasks") {
      console.log(TASK_MGR.listAll());
      rl.prompt();
      return;
    }

    // /team 命令
    if (query.trim() === "/team") {
      console.log(TEAM.listAll());
      rl.prompt();
      return;
    }

    // /inbox 命令
    if (query.trim() === "/inbox") {
      console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
      rl.prompt();
      return;
    }

    // 正常查询
    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });
}

// 启动主函数
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
