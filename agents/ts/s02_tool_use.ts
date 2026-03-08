#!/usr/bin/env tsx
/**
 * s02_tool_use.ts - 工具使用
 *
 * s01 的 agent 循环没有改变。我们只是在数组中添加了工具，
 * 并用一个调度映射来路由调用。
 *
 *     +----------+      +-------+      +------------------+
 *     |   用户   | ---> |  LLM  | ---> | 工具调度         |
 *     |  提示词  |      |       |      | {                |
 *     +----------+      +---+---+      |   bash: run_bash |
 *                           ^          |   read: run_read |
 *                           |          |   write: run_wr  |
 *                           +----------+   edit: run_edit |
 *                           工具结果   | }                |
 *                                      +------------------+
 *
 * 关键洞察："循环完全没变。我只是添加了工具。"
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
// if (process.env.ANTHROPIC_BASE_URL) {
//   delete process.env.ANTHROPIC_AUTH_TOKEN;
// }

// 工作目录：所有文件操作都限制在此目录内
const WORKDIR = process.cwd();

// 初始化 Anthropic 客户端
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,  // API 密钥
});

const MODEL = process.env.MODEL_ID!;

// 系统提示词：现在 agent 可以使用多个工具
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

/**
 * 安全路径检查：防止路径遍历攻击
 * 确保所有文件操作都在工作目录内
 *
 * @param p - 相对路径
 * @returns 解析后的绝对路径
 * @throws 如果路径试图逃逸工作目录
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  // 检查解析后的路径是否在工作目录内
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

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
 * 读取文件内容
 * @param filePath - 文件路径（相对于工作目录）
 * @param limit - 可选：限制读取的行数
 * @returns 文件内容或错误信息
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);  // 安全检查
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");

    // 如果指定了行数限制且文件超过限制
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n").slice(0, 50000);
    }
    return text.slice(0, 50000);  // 限制总长度
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件
 * @param filePath - 文件路径
 * @param content - 要写入的内容
 * @returns 成功消息或错误信息
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    const dir = path.dirname(fullPath);
    // 确保目录存在（递归创建）
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes to ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换指定文本
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本（必须精确匹配）
 * @param newText - 新文本
 * @returns 成功消息或错误信息
 */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");

    // 检查旧文本是否存在
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }

    // 只替换第一次出现（使用 replace 而不是 replaceAll）
    fs.writeFileSync(fullPath, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// -- 工具调度映射：{工具名: 处理函数} --
// 这是关键设计：添加新工具只需要添加一个处理函数
type ToolHandler = (input: any) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),  // bash 命令
  read_file: (input) => runRead(input.path, input.limit),  // 读文件
  write_file: (input) => runWrite(input.path, input.content),  // 写文件
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),  // 编辑文件
};

// 工具定义数组：告诉 LLM 有哪些工具可用
// LLM 会根据这些描述决定何时使用哪个工具
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",  // 执行 shell 命令
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",  // 读取文件内容
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },  // 文件路径
        limit: { type: "integer" },  // 可选：行数限制
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",  // 写入文件
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },  // 文件路径
        content: { type: "string" },  // 文件内容
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",  // 编辑文件（精确替换）
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },  // 文件路径
        old_text: { type: "string" },  // 要替换的旧文本
        new_text: { type: "string" },  // 新文本
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];

/**
 * Agent 循环：与 s01 完全相同的循环逻辑
 * 唯一的区别是现在有更多工具可用
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,  // 现在有 4 个工具：bash, read_file, write_file, edit_file
      max_tokens: 8000,
    });

    // 追加 LLM 响应
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 检查是否需要工具
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        // 从调度映射中查找对应的处理函数
        const handler = TOOL_HANDLERS[block.name];
        // 执行工具（如果找不到处理函数则返回错误）
        const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;

        // 打印工具调用和结果（前 200 个字符）
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);

        // 收集结果
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // 将工具结果反馈给 LLM
    messages.push({
      role: "user",
      content: results,
    });
  }
}

/**
 * 主函数：交互式命令行界面
 * 与 s01 完全相同，只是提示符改为 "s02"
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      // 提示符显示 "s02" 表示这是第二个 session
      const query = await prompt("\x1b[36ms02 >> \x1b[0m");
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }

      history.push({ role: "user", content: query });
      await agentLoop(history);

      // 打印 LLM 的响应
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

// 仅当直接运行此文件时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
