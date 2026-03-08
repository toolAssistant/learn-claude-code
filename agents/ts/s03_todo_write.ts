#!/usr/bin/env tsx
/**
 * s03_todo_write.ts - TodoWrite（任务追踪）
 *
 * 模型通过 TodoManager 追踪自己的进度。当模型忘记更新时，
 * 一个"唠叨提醒"机制会强制它保持更新。
 *
 *    +----------+      +-------+      +---------+
 *    |   用户   | ---> |  LLM  | ---> |  工具   |
 *    |  提示词  |      |       |      | + todo  |
 *    +----------+      +---+---+      +----+----+
 *                          ^               |
 *                          |   工具结果     |
 *                          +---------------+
 *                                |
 *                    +-----------+-----------+
 *                    | TodoManager 状态      |
 *                    | [ ] 任务 A            |
 *                    | [>] 任务 B <- 进行中  |
 *                    | [x] 任务 C            |
 *                    +-----------------------+
 *                                |
 *                    if rounds_since_todo >= 3:
 *                      注入 <reminder>
 *
 * 关键洞察："agent 可以追踪自己的进度 —— 而且我能看到它。"
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

// 工作目录：所有文件操作都限制在此目录内
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
// 系统提示词：指导 agent 使用 todo 工具来规划多步骤任务
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// -- TodoManager: LLM 写入的结构化状态 --
/**
 * 待办事项接口
 * 每个任务有三种状态：待处理、进行中、已完成
 */
interface TodoItem {
  id: string;  // 任务 ID
  text: string;  // 任务描述
  status: "pending" | "in_progress" | "completed";  // 任务状态
}

/**
 * TodoManager 类：管理任务列表的状态
 *
 * 核心功能：
 * 1. 验证任务数据（最多20个任务，只能有1个进行中）
 * 2. 渲染任务列表为可读格式
 * 3. 追踪任务完成进度
 */
class TodoManager {
  items: TodoItem[] = [];  // 任务列表

  /**
   * 更新任务列表
   * @param items - 新的任务列表
   * @returns 渲染后的任务列表字符串
   * @throws 如果验证失败（超过20个任务、多个进行中任务等）
   */
  update(items: TodoItem[]): string {
    // 限制：最多 20 个任务
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }
    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    // 验证每个任务项
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const itemId = String(item.id || String(i + 1));

      // 验证：任务描述不能为空
      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }
      // 验证：状态必须是三种之一
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }
      // 统计进行中的任务数量
      if (status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id: itemId, text, status });
    }

    // 限制：同时只能有一个任务处于进行中状态
    // 这强制 agent 专注于一个任务，避免并行混乱
    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  /**
   * 渲染任务列表为可读字符串
   * @returns 格式化的任务列表
   *
   * 示例输出：
   * [ ] #1: 读取配置文件
   * [>] #2: 修改代码
   * [x] #3: 运行测试
   *
   * (1/3 completed)
   */
  render(): string {
    if (this.items.length === 0) {
      return "No todos.";
    }
    const lines: string[] = [];
    // 状态标记：[ ] 待处理, [>] 进行中, [x] 已完成
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    for (const item of this.items) {
      const marker = markers[item.status];
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }
    // 添加进度统计
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

// 全局 TodoManager 实例：在整个会话中保持状态
const TODO = new TodoManager();

// -- 工具实现 --
/**
 * 安全路径检查：防止路径遍历攻击
 * @param p - 相对路径
 * @returns 解析后的绝对路径
 * @throws 如果路径试图逃逸工作目录
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
  // 安全检查：阻止危险命令
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,  // 超时：120秒
      maxBuffer: 50000 * 1024,  // 最大输出：50MB
    });
    return output.trim() || "(no output)";
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message;
    return stderr.slice(0, 50000);  // 限制错误信息长度
  }
}

/**
 * 读取文件内容
 * @param filePath - 文件路径（相对于工作目录）
 * @param limit - 可选：限制读取的行数
 * @returns 文件内容或错误信息
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");
    // 如果指定了行数限制且文件超过限制
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n").slice(0, 50000);
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
    fs.mkdirSync(dir, { recursive: true });  // 确保目录存在
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换精确匹配的文本
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本（必须精确匹配）
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

// 工具处理函数类型
type ToolHandler = (input: any) => string;

/**
 * 工具调度映射：工具名 -> 处理函数
 * 新增了 todo 工具，用于更新任务列表
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  todo: (input) => TODO.update(input.items),  // 新增：任务管理工具
};

/**
 * 工具定义数组：告诉 LLM 可以使用哪些工具
 * 新增了 todo 工具，用于追踪多步骤任务的进度
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
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
  },
];

// -- Agent 循环 + 唠叨提醒注入 --
/**
 * 核心 agent 循环，带有"唠叨提醒"机制
 *
 * 唠叨提醒机制：
 * - 追踪自上次使用 todo 工具以来的轮数
 * - 如果连续 3 轮没有更新 todo，自动注入提醒消息
 * - 这强制 agent 保持任务列表的更新，避免"忘记"追踪进度
 *
 * @param messages - 对话历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  let roundsSinceTodo = 0;  // 追踪自上次使用 todo 以来的轮数
  while (true) {
    // 唠叨提醒会在下面与工具结果一起注入
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

    // 如果模型停止使用工具，循环结束
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行所有工具调用
    const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
    let usedTodo = false;  // 标记本轮是否使用了 todo 工具

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
        // 检测是否使用了 todo 工具
        if (block.name === "todo") {
          usedTodo = true;
        }
      }
    }

    // 更新计数器：如果使用了 todo 则重置，否则递增
    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;

    // 唠叨提醒：如果连续 3 轮没有更新 todo，注入提醒
    // 这个提醒会作为文本块插入到工具结果之前
    if (roundsSinceTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }

    messages.push({
      role: "user",
      content: results,
    });
  }
}

/**
 * 主函数：交互式 REPL 循环
 * 用户可以输入任务，agent 会使用 todo 工具追踪进度
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];  // 对话历史
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 封装 readline 的 question 为 Promise
  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt("\x1b[36ms03 >> \x1b[0m");
      // 退出命令
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);

      // 打印 agent 的最终响应
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

// 仅在直接运行时执行（不是被 import 时）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
