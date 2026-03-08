#!/usr/bin/env tsx
/**
 * s01_agent_loop.ts - Agent 循环
 *
 * AI 编码代理的核心秘密就在这一个模式中：
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)  // 调用 LLM
 *         execute tools                     // 执行工具
 *         append results                    // 追加结果
 *
 *     +----------+      +-------+      +---------+
 *     |   用户   | ---> |  LLM  | ---> |  工具   |
 *     |  提示词  |      |       |      |  执行   |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   工具结果     |
 *                           +---------------+
 *                           (循环继续)
 *
 * 这是核心循环：将工具执行结果反馈给模型，
 * 直到模型决定停止。生产环境的 agent 会在此基础上
 * 添加策略、钩子和生命周期控制。
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";

// 加载环境变量（从 .env 文件）
config({ override: true });

// 处理自定义 base URL（用于兼容其他 Anthropic API 提供商）
// if (process.env.ANTHROPIC_BASE_URL) {
//   delete process.env.ANTHROPIC_AUTH_TOKEN;
// }

// 初始化 Anthropic 客户端
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,  // 可选：自定义 API 端点
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,  // API 密钥
});

// 从环境变量获取模型 ID（如 claude-sonnet-4-6）
const MODEL = process.env.MODEL_ID!;

// 系统提示词：定义 agent 的角色和行为
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// 工具定义：告诉 LLM 可以使用哪些工具
// 这里只定义了一个 bash 工具，用于执行 shell 命令
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",  // 工具名称
    description: "Run a shell command.",  // 工具描述（LLM 会看到）
    input_schema: {  // 输入参数的 JSON Schema
      type: "object",
      properties: {
        command: { type: "string" },  // 必需参数：要执行的命令
      },
      required: ["command"],
    },
  },
];

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
    // 使用 execSync 同步执行命令
    const output = execSync(command, {
      cwd: process.cwd(),  // 在当前工作目录执行
      encoding: "utf-8",  // 输出编码
      timeout: 120000,  // 超时时间：120秒
      maxBuffer: 50000 * 1024,  // 最大输出缓冲：50MB
    });
    return output.trim() || "(no output)";
  } catch (error: any) {
    // 捕获错误（如命令失败、超时等）
    const stderr = error.stderr?.toString() || error.message;
    return stderr.slice(0, 50000);  // 限制错误信息长度
  }
}

/**
 * 核心模式：一个 while 循环，不断调用工具直到模型停止
 *
 * 这是整个 agent 系统的心脏：
 * 1. 调用 LLM 获取响应
 * 2. 如果 LLM 要求使用工具，执行工具
 * 3. 将工具结果反馈给 LLM
 * 4. 重复步骤 1-3，直到 LLM 不再需要工具
 *
 * @param messages - 对话历史（会被修改）
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 步骤 1：调用 LLM API
    const response = await client.messages.create({
      model: MODEL,  // 使用的模型
      system: SYSTEM,  // 系统提示词
      messages,  // 对话历史
      tools: TOOLS,  // 可用工具列表
      max_tokens: 8000,  // 最大生成 token 数
    });

    // 步骤 2：将 LLM 的响应追加到对话历史
    // 这样 LLM 就能"记住"它说过的话
    messages.push({
      role: "assistant",  // 角色：助手
      content: response.content,  // LLM 的响应内容
    });

    // 步骤 3：检查停止原因
    // 如果不是 "tool_use"，说明 LLM 已经完成任务，退出循环
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 步骤 4：执行 LLM 请求的每个工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        // 打印要执行的命令（黄色）
        console.log(`\x1b[33m$ ${block.input.command}\x1b[0m`);

        // 执行工具（这里是 bash 命令）
        const output = runBash(block.input.command as string);

        // 打印命令输出（前 200 个字符）
        console.log(output.slice(0, 200));

        // 收集工具执行结果
        results.push({
          type: "tool_result",  // 类型：工具结果
          tool_use_id: block.id,  // 关联到对应的工具调用
          content: output,  // 工具输出
        });
      }
    }

    // 步骤 5：将工具执行结果追加到对话历史
    // 这样 LLM 就能"看到"工具的执行结果
    messages.push({
      role: "user",  // 角色：用户（工具结果被视为用户输入）
      content: results,  // 所有工具的执行结果
    });

    // 循环继续：回到步骤 1，让 LLM 根据工具结果决定下一步
  }
}

/**
 * 主函数：实现交互式命令行界面
 *
 * 这是一个 REPL（Read-Eval-Print Loop）：
 * 1. 读取用户输入
 * 2. 调用 agent 循环处理
 * 3. 打印 LLM 的响应
 * 4. 重复
 */
async function main() {
  // 对话历史：存储所有消息（用户输入、LLM 响应、工具结果）
  const history: Anthropic.MessageParam[] = [];

  // 创建 readline 接口用于读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,  // 标准输入
    output: process.stdout,  // 标准输出
  });

  // 封装 readline.question 为 Promise
  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // 主循环：不断读取用户输入
  while (true) {
    try {
      // 显示提示符并等待用户输入（青色）
      const query = await prompt("\x1b[36ms01 >> \x1b[0m");

      // 检查退出命令
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
        break;
      }

      // 将用户输入添加到对话历史
      history.push({ role: "user", content: query });

      // 调用 agent 循环处理用户请求
      await agentLoop(history);

      // 提取并打印 LLM 的最终响应
      const lastMessage = history[history.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
          if (block.type === "text") {
            console.log(block.text);  // 打印文本内容
          }
        }
      }
      console.log();  // 空行分隔
    } catch (error) {
      // 处理 EOF（Ctrl+D）
      if (error instanceof Error && error.message.includes("EOF")) {
        break;
      }
      throw error;  // 其他错误继续抛出
    }
  }

  // 关闭 readline 接口
  rl.close();
}

// 仅当直接运行此文件时执行 main 函数
// （而不是被其他模块 import 时）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
