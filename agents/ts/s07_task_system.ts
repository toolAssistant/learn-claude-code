#!/usr/bin/env tsx
/**
 * s07_task_system.ts - 任务系统
 *
 * 任务以 JSON 文件形式持久化到 .tasks/ 目录，因此可以在上下文压缩后继续存在。
 * 每个任务都有依赖图（blockedBy/blocks）。
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     依赖关系解析：
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | 已完成   |     | 被阻塞   |     | 被阻塞   |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- 完成 task 1 会将其从 task 2 的 blockedBy 中移除
 *
 * 关键洞察："状态在压缩后仍然存在 -- 因为它在对话之外。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 工作目录和任务目录
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const TASKS_DIR = path.join(WORKDIR, ".tasks");  // 任务持久化目录

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// -- 任务类型定义 --
/**
 * 任务接口
 * 每个任务都有唯一 ID、状态和依赖关系
 */
interface Task {
  id: number;                                      // 任务唯一标识
  subject: string;                                 // 任务标题
  description: string;                             // 任务详细描述
  status: "pending" | "in_progress" | "completed"; // 任务状态
  blockedBy: number[];                             // 阻塞此任务的任务 ID 列表
  blocks: number[];                                // 此任务阻塞的任务 ID 列表
  owner: string;                                   // 任务负责人
}

/**
 * TaskManager: 任务管理器
 *
 * 提供任务的 CRUD 操作和依赖图管理，所有任务持久化为 JSON 文件
 * 这样即使对话被压缩，任务状态也不会丢失
 */
class TaskManager {
  private dir: string;      // 任务存储目录
  private nextId: number;   // 下一个可用的任务 ID

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    // 确保任务目录存在
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    // 初始化下一个 ID（从现有任务中找到最大 ID + 1）
    this.nextId = this.maxId() + 1;
  }

  /**
   * 获取当前最大的任务 ID
   * @returns 最大任务 ID，如果没有任务则返回 0
   */
  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    if (files.length === 0) return 0;
    const ids = files.map((f) => parseInt(f.replace("task_", "").replace(".json", "")));
    return Math.max(...ids);
  }

  /**
   * 从磁盘加载任务
   * @param taskId - 任务 ID
   * @returns 任务对象
   */
  private load(taskId: number): Task {
    const filePath = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  /**
   * 保存任务到磁盘
   * @param task - 任务对象
   */
  private save(task: Task): void {
    const filePath = path.join(this.dir, `task_${task.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
  }

  /**
   * 创建新任务
   * @param subject - 任务标题
   * @param description - 任务描述（可选）
   * @returns 创建的任务的 JSON 字符串
   */
  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  /**
   * 获取任务详情
   * @param taskId - 任务 ID
   * @returns 任务的 JSON 字符串
   */
  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  /**
   * 更新任务状态和依赖关系
   *
   * @param taskId - 任务 ID
   * @param status - 新状态（可选）
   * @param addBlockedBy - 添加阻塞此任务的任务 ID 列表（可选）
   * @param addBlocks - 添加此任务阻塞的任务 ID 列表（可选）
   * @returns 更新后的任务的 JSON 字符串
   */
  update(
    taskId: number,
    status?: "pending" | "in_progress" | "completed",
    addBlockedBy?: number[],
    addBlocks?: number[]
  ): string {
    const task = this.load(taskId);

    // 更新状态
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      // 当任务完成时，将其从所有其他任务的 blockedBy 列表中移除
      if (status === "completed") {
        this.clearDependency(taskId);
      }
    }

    // 添加阻塞此任务的任务（去重）
    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    // 添加此任务阻塞的任务（双向更新）
    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      // 双向关系：同时更新被阻塞任务的 blockedBy 列表
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch {
          // 任务不存在，跳过
        }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 清除依赖关系：从所有任务的 blockedBy 列表中移除指定任务
   *
   * 当任务完成时调用，解除对其他任务的阻塞
   *
   * @param completedId - 已完成的任务 ID
   */
  private clearDependency(completedId: number): void {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(this.dir, file);
      const task: Task = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (task.blockedBy.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id) => id !== completedId);
        this.save(task);
      }
    }
  }

  /**
   * 列出所有任务
   *
   * 以简洁格式显示所有任务的状态和依赖关系
   * 格式：[状态标记] #ID: 标题 (blocked by: ...)
   *
   * @returns 任务列表的字符串表示
   */
  listAll(): string {
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) {
      return "No tasks.";
    }
    const tasks: Task[] = files.map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")));
    const lines: string[] = [];
    for (const t of tasks) {
      // 状态标记：[ ] 待处理, [>] 进行中, [x] 已完成
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${blocked}`);
    }
    return lines.join("\n");
  }
}

// 全局任务管理器实例
const TASKS = new TaskManager(TASKS_DIR);

// -- 基础工具实现 --

/**
 * 安全路径检查：防止路径遍历攻击
 * @param p - 相对路径
 * @returns 解析后的绝对路径
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
 * @param command - 要执行的 shell 命令
 * @returns 命令输出或错误信息
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
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    return "Error: Timeout (120s)";
  }
}

/**
 * 读取文件内容
 * @param filePath - 文件路径
 * @param limit - 可选：限制读取的行数
 * @returns 文件内容或错误信息
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more)`].join("\n").slice(0, 50000);
    }
    return text.slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件内容
 * @param filePath - 文件路径
 * @param content - 要写入的内容
 * @returns 成功消息或错误信息
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换指定文本
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本
 * @param newText - 新文本
 * @returns 成功消息或错误信息
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

// 工具处理函数类型定义
type ToolHandler = (input: any) => string;

// 工具调度映射：工具名称 -> 处理函数
// 包含基础文件操作工具和任务管理工具
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  task_create: (input) => TASKS.create(input.subject, input.description || ""),
  task_update: (input) => TASKS.update(input.task_id, input.status, input.addBlockedBy, input.addBlocks),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(input.task_id),
};

// 工具定义：基础文件操作 + 任务管理工具
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
        limit: { type: "integer" },
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
    name: "task_create",
    description: "Create a new task.",
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
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        addBlockedBy: { type: "array", items: { type: "integer" } },
        addBlocks: { type: "array", items: { type: "integer" } },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

/**
 * Agent 循环：标准的工具调用循环
 *
 * 与 s02 相同的循环，只是添加了任务管理工具
 * 任务状态持久化到磁盘，不受对话压缩影响
 *
 * @param messages - 消息历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({
      role: "user",
      content: results,
    });
  }
}

/**
 * 主函数：交互式 REPL 循环
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt("\x1b[36ms07 >> \x1b[0m");
      if (!query || ["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);

      const lastMessage = history[history.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof Error && error.message.includes("EOF")) {
        break;
      }
      throw error;
    }
  }

  rl.close();
}

// 仅在直接运行此文件时执行 main
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
