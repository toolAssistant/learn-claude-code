#!/usr/bin/env tsx
/**
 * s05_skill_loading.ts - 技能加载（Skills）
 *
 * 两层技能注入机制，避免系统提示词膨胀：
 *
 *    第一层（低成本）：系统提示词中只包含技能名称（~100 tokens/技能）
 *    第二层（按需加载）：完整技能内容通过 tool_result 返回
 *
 *    skills/
 *      pdf/
 *        SKILL.md          <-- frontmatter（名称、描述）+ 正文
 *      code-review/
 *        SKILL.md
 *
 *    系统提示词：
 *    +--------------------------------------+
 *    | You are a coding agent.              |
 *    | Skills available:                    |
 *    |   - pdf: Process PDF files...        |  <-- 第一层：仅元数据
 *    |   - code-review: Review code...      |
 *    +--------------------------------------+
 *
 *    当模型调用 load_skill("pdf") 时：
 *    +--------------------------------------+
 *    | tool_result:                         |
 *    | <skill>                              |
 *    |   完整的 PDF 处理指令                |  <-- 第二层：完整内容
 *    |   步骤 1: ...                        |
 *   |   步骤 2: ...                        |
 *    | </skill>                             |
 *    +--------------------------------------+
 *
 * 关键洞察："不要把所有东西都放在系统提示词里。按需加载。"
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

// 工作目录和技能目录
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const SKILLS_DIR = path.join(WORKDIR, "skills");  // 技能文件存放目录

// -- SkillLoader: 扫描 skills/<name>/SKILL.md 并解析 YAML frontmatter --
/**
 * 技能元数据接口：从 YAML frontmatter 解析
 */
interface SkillMeta {
  name?: string;         // 技能名称
  description?: string;  // 技能描述
  tags?: string;         // 技能标签
}

/**
 * 技能接口：包含元数据、正文和文件路径
 */
interface Skill {
  meta: SkillMeta;  // 元数据（第一层：在系统提示词中显示）
  body: string;     // 正文（第二层：按需加载）
  path: string;     // 文件路径
}

/**
 * SkillLoader 类：管理技能的加载和访问
 *
 * 核心功能：
 * 1. 扫描 skills/ 目录，递归查找所有 SKILL.md 文件
 * 2. 解析 YAML frontmatter（元数据）和正文
 * 3. 提供两层访问接口：
 *    - getDescriptions(): 返回所有技能的简短描述（第一层）
 *    - getContent(name): 返回指定技能的完整内容（第二层）
 */
class SkillLoader {
  skills: Map<string, Skill> = new Map();  // 技能名称 -> 技能对象

  constructor(private skillsDir: string) {
    this.loadAll();  // 构造时立即加载所有技能
  }

  /**
   * 加载所有技能文件
   * 递归扫描 skills/ 目录，查找所有 SKILL.md 文件
   */
  private loadAll(): void {
    if (!fs.existsSync(this.skillsDir)) {
      return;  // 如果技能目录不存在，直接返回
    }

    // 递归查找所有 SKILL.md 文件
    const findSkills = (dir: string): string[] => {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // 递归搜索子目录
          results.push(...findSkills(fullPath));
        } else if (entry.name === "SKILL.md") {
          // 找到技能文件
          results.push(fullPath);
        }
      }
      return results;
    };

    // 加载并解析所有技能文件
    const skillFiles = findSkills(this.skillsDir).sort();
    for (const file of skillFiles) {
      const text = fs.readFileSync(file, "utf-8");
      const { meta, body } = this.parseFrontmatter(text);
      // 技能名称：优先使用 frontmatter 中的 name，否则使用目录名
      const name = meta.name || path.basename(path.dirname(file));
      this.skills.set(name, { meta, body, path: file });
    }
  }

  /**
   * 解析 YAML frontmatter
   *
   * SKILL.md 文件格式：
   * ---
   * name: pdf
   * description: Process PDF files
   * tags: document, conversion
   * ---
   * 正文内容...
   *
   * @param text - 文件内容
   * @returns 解析后的元数据和正文
   */
  private parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
    // 匹配 YAML frontmatter：--- ... ---
    const match = text.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) {
      // 如果没有 frontmatter，整个文件作为正文
      return { meta: {}, body: text };
    }

    // 解析 YAML（简单的 key: value 格式）
    const meta: SkillMeta = {};
    const frontmatter = match[1].trim();
    for (const line of frontmatter.split("\n")) {
      if (line.includes(":")) {
        const [key, ...rest] = line.split(":");
        meta[key.trim() as keyof SkillMeta] = rest.join(":").trim();
      }
    }
    return { meta, body: match[2].trim() };
  }

  /**
   * 获取所有技能的描述（第一层：注入到系统提示词）
   *
   * 返回格式：
   *   - pdf: Process PDF files [document, conversion]
   *   - code-review: Review code quality
   *
   * @returns 格式化的技能列表
   */
  getDescriptions(): string {
    if (this.skills.size === 0) {
      return "(no skills available)";
    }
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags || "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  /**
   * 获取指定技能的完整内容（第二层：按需加载）
   *
   * 返回格式：
   * <skill name="pdf">
   * 完整的技能指令...
   * </skill>
   *
   * @param name - 技能名称
   * @returns 技能内容或错误信息
   */
  getContent(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      const available = Array.from(this.skills.keys()).join(", ");
      return `Error: Unknown skill '${name}'. Available: ${available}`;
    }
    // 用 XML 标签包裹技能内容，便于 LLM 识别
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// 全局 SkillLoader 实例：启动时加载所有技能
const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// 第一层：技能元数据注入到系统提示词
// 这只消耗少量 tokens（每个技能约 100 tokens）
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

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
 * 工具调度映射：工具名 -> 处理函数
 * 新增了 load_skill 工具，用于按需加载技能内容（第二层）
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),
  read_file: (input) => runRead(input.path, input.limit),
  write_file: (input) => runWrite(input.path, input.content),
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),
  load_skill: (input) => SKILL_LOADER.getContent(input.name),  // 新增：技能加载工具
};

/**
 * 工具定义数组：告诉 LLM 可以使用哪些工具
 * 新增了 load_skill 工具，用于按需加载专业知识
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
    name: "load_skill",
    description: "Load specialized knowledge by name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
];

/**
 * 核心 agent 循环：标准的工具执行循环
 * 当模型调用 load_skill 时，完整的技能内容会通过 tool_result 返回
 *
 * @param messages - 对话历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,  // 系统提示词包含技能列表（第一层）
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
          content: output,  // 对于 load_skill，这是完整的技能内容（第二层）
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
 * 用户可以输入任务，agent 会在需要时自动加载相关技能
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
      const query = await prompt("\x1b[36ms05 >> \x1b[0m");
      if (!query || ["q", "exit"].includes(query.trim().toLowerCase())) {
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

// 仅在直接运行时执行（不是被 import 时）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
