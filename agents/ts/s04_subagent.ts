#!/usr/bin/env tsx
/**
 * s04_subagent.ts - 子代理（Subagents）
 *
 * 生成一个拥有全新 messages=[] 的子代理。子代理在自己的上下文中工作，
 * 共享文件系统，然后只返回摘要给父代理。
 *
 *    父代理                          子代理
 *    +------------------+             +------------------+
 *    | messages=[...]   |             | messages=[]      |  <-- 全新上下文
 *    |                  |  派发任务   |                  |
 *    | tool: task       | ---------->| while tool_use:  |
 *    |   prompt="..."   |            |   调用工具       |
 *    |   description="" |            |   追加结果       |
 *    |                  |  返回摘要   |                  |
 *    |   result = "..." | <--------- | return last text |
 *    +------------------+             +------------------+
 *              |
 *    父代理上下文保持干净。
 *    子代理上下文被丢弃。
 *
 * 关键洞察："进程隔离免费提供了上下文隔离。"
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

// 工作目录：父子代理共享同一个文件系统
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
// 父代理系统提示词：可以使用 task 工具委派子任务
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
// 子代理系统提示词：专注于完成任务并总结发现
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

// -- 父子代理共享的工具实现 --
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
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换精确匹配的文本
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

// 工具处理函数类型
type ToolHandler = (input: any) => string;

/**
 * 基础工具调度映射：父子代理都可以使用这些工具
 * 注意：子代理不能使用 task 工具（防止递归生成子代理）
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
};

/**
 * 子代理工具列表：包含所有基础工具，但不包含 task 工具
 * 这防止了递归生成子代理（子代理不能再生成子代理）
 */
const CHILD_TOOLS: Anthropic.Tool[] = [
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
];

// -- 子代理：全新上下文、过滤的工具、仅返回摘要 --
/**
 * 运行子代理：创建独立的上下文来执行子任务
 *
 * 核心特性：
 * 1. 全新的 messages=[]：子代理看不到父代理的对话历史
 * 2. 过滤的工具集：子代理不能使用 task 工具（防止递归）
 * 3. 仅返回摘要：父代理只收到最终文本，不会看到子代理的详细执行过程
 *
 * 这种设计的好处：
 * - 父代理的上下文保持干净，不会被子任务的细节污染
 * - 子代理可以自由探索，不受父代理历史的影响
 * - 减少 token 消耗：父代理只需要知道结果，不需要知道过程
 *
 * @param prompt - 给子代理的任务描述
 * @returns 子代理的最终摘要
 */
async function runSubagent(prompt: string): Promise<string> {
  // 全新的消息上下文：只包含任务提示词
  const subMessages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];

  // 安全限制：最多 30 轮，防止无限循环
  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,  // 使用子代理专用的系统提示词
      messages: subMessages,
      tools: CHILD_TOOLS,  // 使用过滤后的工具集（不包含 task）
      max_tokens: 8000,
    });

    subMessages.push({
      role: "assistant",
      content: response.content,
    });

    // 如果子代理停止使用工具，任务完成
    if (response.stop_reason !== "tool_use") {
      break;
    }

    // 执行子代理请求的工具
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
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

  // 关键：只返回最终文本给父代理 -- 子代理的上下文被丢弃
  // 父代理看不到子代理执行了哪些工具、读了哪些文件等细节
  const lastMessage = subMessages[subMessages.length - 1];
  if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
    const texts = lastMessage.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text);
    return texts.join("") || "(no summary)";
  }
  return "(no summary)";
}

// -- 父代理工具：基础工具 + task 调度器 --
/**
 * 父代理工具列表：包含所有基础工具 + task 工具
 * task 工具允许父代理生成子代理来处理子任务
 */
const PARENT_TOOLS: Anthropic.Tool[] = [
  ...CHILD_TOOLS,  // 继承所有基础工具
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },  // 给子代理的任务描述
        description: { type: "string", description: "Short description of the task" },  // 任务简短描述（用于日志）
      },
      required: ["prompt"],
    },
  },
];

/**
 * 父代理循环：标准的 agent 循环 + task 工具特殊处理
 *
 * 当父代理调用 task 工具时：
 * 1. 生成一个新的子代理（全新上下文）
 * 2. 等待子代理完成任务
 * 3. 将子代理的摘要作为工具结果返回给父代理
 *
 * @param messages - 父代理的对话历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,  // 使用父代理的系统提示词
      messages,
      tools: PARENT_TOOLS,  // 使用包含 task 工具的完整工具集
      max_tokens: 8000,
    });

    messages.push({
      role: "assistant",
      content: response.content,
    });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        // 特殊处理：task 工具调用子代理
        if (block.name === "task") {
          const desc = block.input.description || "subtask";
          console.log(`> task (${desc}): ${block.input.prompt.slice(0, 80)}`);
          // 异步运行子代理，等待其完成
          output = await runSubagent(block.input.prompt);
        } else {
          // 其他工具：直接调用处理函数
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        }
        console.log(`  ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,  // 对于 task 工具，这是子代理的摘要
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
 * 用户可以输入任务，父代理可以使用 task 工具委派子任务
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];  // 父代理的对话历史
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 封装 readline 的 question 为 Promise
  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt("\x1b[36ms04 >> \x1b[0m");
      // 退出命令
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);

      // 打印父代理的最终响应
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
