#!/usr/bin/env tsx
/**
 * s08_background_tasks.ts - 后台任务
 *
 * 在后台线程中运行命令。通知队列在每次 LLM 调用前被清空以传递结果。
 *
 *     主线程                    后台线程
 *     +-----------------+        +-----------------+
 *     | agent 循环      |        | 任务执行        |
 *     | ...             |        | ...             |
 *     | [LLM 调用] <---+------- | enqueue(result) |
 *     |  ^清空队列      |        +-----------------+
 *     +-----------------+
 *
 *     时间线：
 *     Agent ----[启动 A]----[启动 B]----[其他工作]----
 *                  |              |
 *                  v              v
 *               [A 运行]      [B 运行]        (并行)
 *                  |              |
 *                  +-- 通知队列 --> [结果注入]
 *
 * 关键洞察："发射后不管 -- agent 不会在命令运行时阻塞。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { exec } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- 后台任务类型定义 --

/**
 * 后台任务接口
 * 跟踪任务的执行状态和结果
 */
interface BackgroundTask {
  status: "running" | "completed" | "timeout" | "error";  // 任务状态
  result: string | null;                                   // 任务结果（完成后）
  command: string;                                         // 执行的命令
}

/**
 * 通知接口
 * 用于在任务完成时通知主线程
 */
interface Notification {
  task_id: string;   // 任务 ID
  status: string;    // 任务状态
  command: string;   // 执行的命令
  result: string;    // 任务结果
}

/**
 * BackgroundManager: 后台任务管理器
 *
 * 提供后台执行命令的能力，使用线程执行 + 通知队列模式
 * - 任务在后台异步执行，不阻塞主线程
 * - 完成的任务结果通过通知队列传递给主线程
 * - 支持查询任务状态和结果
 */
class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();  // 任务 ID -> 任务对象
  private notificationQueue: Notification[] = [];          // 待处理的通知队列

  /**
   * 启动后台任务
   *
   * @param command - 要执行的命令
   * @returns 任务启动确认消息（包含任务 ID）
   */
  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);  // 生成短 UUID 作为任务 ID
    this.tasks.set(taskId, {
      status: "running",
      result: null,
      command,
    });

    // 在后台执行命令
    this.execute(taskId, command);

    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  /**
   * 后台执行目标：运行子进程，捕获输出，推送到队列
   *
   * 使用 child_process.exec 异步执行命令
   * 完成后将结果推送到通知队列
   *
   * @param taskId - 任务 ID
   * @param command - 要执行的命令
   */
  private execute(taskId: string, command: string): void {
    exec(
      command,
      {
        cwd: WORKDIR,
        timeout: 300000, // 超时时间：300秒（5分钟）
        maxBuffer: 50000 * 1024,
      },
      (error, stdout, stderr) => {
        const task = this.tasks.get(taskId);
        if (!task) return;

        let output: string;
        let status: "completed" | "timeout" | "error";

        if (error) {
          if (error.killed) {
            // 进程被杀死（通常是超时）
            output = "Error: Timeout (300s)";
            status = "timeout";
          } else {
            // 其他错误
            output = `Error: ${error.message}`;
            status = "error";
          }
        } else {
          // 成功完成
          output = (stdout + stderr).trim().slice(0, 50000);
          status = "completed";
        }

        // 更新任务状态
        task.status = status;
        task.result = output || "(no output)";

        // 推送通知到队列
        this.notificationQueue.push({
          task_id: taskId,
          status,
          command: command.slice(0, 80),
          result: (output || "(no output)").slice(0, 500),
        });
      }
    );
  }

  /**
   * 检查任务状态
   *
   * @param taskId - 可选：任务 ID。如果不提供，列出所有任务
   * @returns 任务状态信息
   */
  check(taskId?: string): string {
    if (taskId) {
      // 查询单个任务
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result || "(running)"}`;
    }

    // 列出所有任务
    const lines: string[] = [];
    for (const [tid, task] of this.tasks.entries()) {
      lines.push(`${tid}: [${task.status}] ${task.command.slice(0, 60)}`);
    }
    return lines.length > 0 ? lines.join("\n") : "No background tasks.";
  }

  /**
   * 清空通知队列
   *
   * 返回所有待处理的完成通知，并清空队列
   * 在每次 LLM 调用前调用，将后台任务结果注入对话
   *
   * @returns 待处理的通知列表
   */
  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

// 全局后台管理器实例
const BG = new BackgroundManager();

// -- 工具实现 --

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
 * 执行 bash 命令（阻塞式）
 * @param command - 要执行的 shell 命令
 * @returns 命令输出或错误信息
 */
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const { execSync } = require("child_process");
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
// 包含基础文件操作工具和后台任务工具
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  background_run: (input) => BG.run(input.command),      // 启动后台任务
  check_background: (input) => BG.check(input.task_id),  // 检查后台任务状态
};

// 工具定义：基础文件操作 + 后台任务工具
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
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
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
    },
  },
];

/**
 * Agent 循环：带后台任务通知的执行循环
 *
 * 关键特性：
 * - 每次 LLM 调用前清空通知队列
 * - 将后台任务完成通知注入到对话中
 * - Agent 可以继续工作而不等待长时间运行的命令
 *
 * @param messages - 消息历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 清空后台通知队列，并在 LLM 调用前注入为系统消息
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      // 将通知作为用户消息注入
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      // Assistant 确认收到通知
      messages.push({
        role: "assistant",
        content: "Noted background results.",
      });
    }

    // 调用 LLM
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
      const query = await prompt("\x1b[36ms08 >> \x1b[0m");
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
