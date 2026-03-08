#!/usr/bin/env tsx
/**
 * s06_context_compact.ts - 上下文压缩
 *
 * 三层压缩管道，让 agent 可以永久运行：
 *
 *    每一轮：
 *    +------------------+
 *    | 工具调用结果     |
 *    +------------------+
 *            |
 *            v
 *    [第一层: micro_compact]        (静默执行，每轮都运行)
 *      将超过最近 3 个的旧 tool_result 内容
 *      替换为 "[Previous: used {tool_name}]"
 *            |
 *            v
 *    [检查: tokens > 50000?]
 *       |               |
 *      否              是
 *       |               |
 *       v               v
 *    继续        [第二层: auto_compact]
 *                  保存完整对话记录到 .transcripts/
 *                  让 LLM 总结对话内容
 *                  用总结替换所有消息
 *                        |
 *                        v
 *                [第三层: compact 工具]
 *                  模型调用 compact -> 立即总结
 *                  与自动压缩相同，但由模型手动触发
 *
 * 关键洞察："agent 可以策略性地遗忘，从而永久工作。"
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

// 压缩配置
const THRESHOLD = 50000;  // Token 阈值：超过此值触发自动压缩
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");  // 对话记录保存目录
const KEEP_RECENT = 3;  // 保留最近 N 个工具结果的完整内容

/**
 * 估算消息列表的 token 数量
 * 使用粗略估算：约 4 个字符 = 1 个 token
 *
 * @param messages - 消息列表
 * @returns 估算的 token 数量
 */
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length / 4;
}

/**
 * 第一层：微压缩 - 用占位符替换旧的工具结果
 *
 * 策略：保留最近 N 个工具结果的完整内容，将更早的结果替换为简短占位符
 * 这样可以在不丢失上下文的情况下减少 token 使用
 *
 * @param messages - 消息列表（会被原地修改）
 */
function microCompact(messages: Anthropic.MessageParam[]): void {
  // 收集所有 tool_result 条目的位置信息
  const toolResults: Array<{ msgIdx: number; partIdx: number; result: any }> = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (typeof part === "object" && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  // 如果工具结果总数不超过保留数量，无需压缩
  if (toolResults.length <= KEEP_RECENT) {
    return;
  }

  // 构建 tool_use_id -> tool_name 的映射
  // 通过匹配之前的 assistant 消息中的 tool_use 来找到工具名称
  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNameMap[block.id] = block.name;
        }
      }
    }
  }

  // 清理旧结果（保留最后 KEEP_RECENT 个）
  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { result } of toClear) {
    // 只压缩较长的内容（超过 100 字符）
    if (typeof result.content === "string" && result.content.length > 100) {
      const toolId = result.tool_use_id || "";
      const toolName = toolNameMap[toolId] || "unknown";
      result.content = `[Previous: used ${toolName}]`;
    }
  }
}

/**
 * 第二层：自动压缩 - 保存对话记录、总结、替换消息
 *
 * 当 token 数量超过阈值时触发，执行以下步骤：
 * 1. 将完整对话保存到磁盘（.transcripts/ 目录）
 * 2. 让 LLM 生成对话摘要
 * 3. 用摘要替换所有历史消息
 *
 * 这样可以在保留关键信息的同时大幅减少上下文长度
 *
 * @param messages - 当前消息列表
 * @returns 压缩后的新消息列表
 */
async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  // 保存完整对话记录到磁盘
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  }
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((msg) => JSON.stringify(msg)).join("\n");
  fs.writeFileSync(transcriptPath, lines);
  console.log(`[transcript saved: ${transcriptPath}]`);

  // 让 LLM 总结对话内容
  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.content.find((b) => b.type === "text")?.text || "";

  // 用压缩后的摘要替换所有消息
  // 返回一个简短的对话：用户提供摘要 + assistant 确认
  return [
    {
      role: "user",
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. Continuing.",
    },
  ];
}

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
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  compact: () => "Manual compression requested.",  // 手动压缩工具的占位符
};

// 工具定义：告诉 LLM 可以使用哪些工具
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
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "What to preserve in the summary" },
      },
    },
  },
];

/**
 * Agent 循环：核心执行逻辑
 *
 * 在每次循环中应用三层压缩策略：
 * 1. 每轮都执行微压缩（清理旧工具结果）
 * 2. Token 超过阈值时自动压缩
 * 3. 模型调用 compact 工具时手动压缩
 *
 * @param messages - 消息历史（会被原地修改）
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 第一层：每次 LLM 调用前执行微压缩
    microCompact(messages);

    // 第二层：如果 token 估算超过阈值，触发自动压缩
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    // 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // 将 LLM 响应添加到消息历史
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 如果 LLM 不需要使用工具，结束循环
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    let manualCompact = false;  // 标记是否触发手动压缩

    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;
        if (block.name === "compact") {
          // 模型请求手动压缩
          manualCompact = true;
          output = "Compressing...";
        } else {
          // 执行普通工具
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          } catch (error: any) {
            output = `Error: ${error.message}`;
          }
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // 将工具结果添加到消息历史
    messages.push({
      role: "user",
      content: results,
    });

    // 第三层：如果模型调用了 compact 工具，执行手动压缩
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

/**
 * 主函数：交互式 REPL 循环
 *
 * 提供命令行界面，让用户与 agent 交互
 * 所有对话历史都保存在 history 中，并应用压缩策略
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
      const query = await prompt("\x1b[36ms06 >> \x1b[0m");
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);

      // 显示 assistant 的文本响应
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
