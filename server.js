const express = require("express");
const fs = require("fs");
const path = require("path");
const {
  AlignmentType,
  Document,
  LineRuleType,
  Packer,
  Paragraph,
  TextRun,
  Footer,
  PageNumber,
} = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;

const rootDir = __dirname;

// Load system prompt template and doc schemas at startup
const systemPromptTemplate = fs.readFileSync(
  path.join(rootDir, "system_prompt.jinja"),
  "utf8"
);

const docSchemas = JSON.parse(
  fs.readFileSync(path.join(rootDir, "doc_schemas.json"), "utf8")
);

// Prefer built-in fetch (Node 18+), fallback to node-fetch for older versions
let fetchFn = global.fetch;

async function callDeepseekChatCompletions(payload, apiKey) {
  if (!fetchFn) {
    const mod = await import("node-fetch");
    fetchFn = mod.default;
  }

  return fetchFn("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
}

async function callDeepseekChatStream(payload, apiKey) {
  if (!fetchFn) {
    const mod = await import("node-fetch");
    fetchFn = mod.default;
  }

  const body = JSON.stringify({ ...payload, stream: true });

  return fetchFn("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });
}

function createStyledParagraph(kind, text) {
  // 固定行距：28 磅（28 * 20 = 560）
  const lineSpacing = 560;
  // 段前/段后：约 0.5 行（按 1 行 240 估算，即 120）
  const paragraphSpacing = 120;
  let alignment = AlignmentType.JUSTIFIED;
  let font = "仿宋_GB2312";
  let size = 32; // 三号（约 16pt）
  let bold = false;
  let indent = undefined;

  if (kind === "title") {
    alignment = AlignmentType.CENTER;
    font = "方正小标宋简体";
    size = 44; // 二号（约 22pt）
  } else if (kind === "h1") {
    font = "黑体";
    size = 32;
    bold = true;
  } else if (kind === "h2") {
    font = "楷体";
    size = 32;
    // 二级标题与正文保持一致的首行缩进
    indent = { firstLine: "11mm" };
  } else if (kind === "signature") {
    // 落款和日期：右对齐，字号保持与正文一致
    alignment = AlignmentType.RIGHT;
  } else if (kind === "body") {
    // 正文段落：首行缩进约两个汉字
    indent = { firstLine: "11mm" };
  }

  return new Paragraph({
    alignment,
    indent,
    // lineRule: EXACT => 固定行距（这里为 28 磅），段前/段后各约 0.5 行
    spacing: {
      line: lineSpacing,
      lineRule: LineRuleType.EXACT,
      before: paragraphSpacing,
      after: paragraphSpacing,
    },
    children: [
      new TextRun({
        text: text || "",
        font,
        size,
        bold,
      }),
    ],
  });
}

function buildDocFromPlainText(content) {
  const lines = String(content || "").split(/\r?\n/);
  const paragraphs = [];

   // 预先识别接近文末的“落款 + 日期”行，用于在 Word 中右对齐
  const trimmedLines = lines.map((raw) => String(raw || "").trim());
  const signatureLineIndices = new Set();

  // 从文末向上查找形如“XXXX年XX月XX日”的日期行
  let dateIndex = -1;
  for (let i = trimmedLines.length - 1; i >= 0; i--) {
    const t = trimmedLines[i];
    if (!t) continue;
    // 跳过附件行
    if (/^附件[:：]/.test(t)) {
      continue;
    }
    // 简单判断中文日期：同时包含“年”“月”“日”
    if (t.includes("年") && t.includes("月") && t.includes("日")) {
      dateIndex = i;
      break;
    }
  }

  if (dateIndex !== -1) {
    signatureLineIndices.add(dateIndex);
    // 日期上一行（非空且不含明显句子标点）视为单位名称行
    for (let j = dateIndex - 1; j >= 0; j--) {
      const t = trimmedLines[j];
      if (!t) continue;
      if (/^附件[:：]/.test(t)) {
        break;
      }
      // 避免把正常句子当成落款：含句号、冒号等则停止
      if (/[。！？?：:；;，,]/.test(t)) {
        break;
      }
      signatureLineIndices.add(j);
      break;
    }
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const line = (raw || "").trimEnd();

    if (!line.trim()) {
      continue;
    }

    // 解析带标签的行，支持【标签】或[标签]
    const tagMatch = line.match(/^[\u3010\[]([^】\]]+)[\u3011\]](.*)$/);
    if (tagMatch) {
      const tag = tagMatch[1].trim();
      const rest = tagMatch[2].trim();

      if (tag === "文种") {
        // 文种作为元信息，不直接写入文档
        continue;
      }

      if (tag === "标题") {
        const titleText = rest || line;
        paragraphs.push(createStyledParagraph("title", titleText));
        continue;
      }

      // 主送机关/对象：作为称呼行，不缩进
      if (
        tag === "主送机关" ||
        tag === "主送对象" ||
        tag === "主送单位"
      ) {
        const salutationText = rest || line;
        paragraphs.push(createStyledParagraph("salutation", salutationText));
        continue;
      }

      // 其他标签（主送机关等），去掉【】作为正文处理
      const bodyText = rest || line;
      const kind = signatureLineIndices.has(idx) ? "signature" : "body";
      paragraphs.push(createStyledParagraph(kind, bodyText));
      continue;
    }

    // 一级标题：形如“一、”“二、”
    if (/^[一二三四五六七八九十]+、/.test(line.trim())) {
      paragraphs.push(createStyledParagraph("h1", line.trim()));
      continue;
    }

    // 二级标题：形如“（一）”
    if (/^（[一二三四五六七八九十]+）/.test(line.trim())) {
      paragraphs.push(createStyledParagraph("h2", line.trim()));
      continue;
    }

    // 其他正文段落
    const kind = signatureLineIndices.has(idx) ? "signature" : "body";
    paragraphs.push(createStyledParagraph(kind, line));
  }

  return new Document({
    sections: [
      {
        properties: {
          // 页面设置：边距按毫米要求换算
          // Word 使用缇（twip，1/20 point），1 cm ≈ 567 twip
          page: {
            margin: {
              top: Math.round(3.7 * 567), // 37 mm
              bottom: Math.round(3.5 * 567), // 35 mm
              left: Math.round(2.8 * 567), // 28 mm
              right: Math.round(2.6 * 567), // 26 mm
            },
          },
        },
        children: paragraphs,
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                  }),
                ],
              }),
            ],
          }),
        },
      },
    ],
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(rootDir, "public")));

// Helper: build the system prompt content by injecting user input and optional hints
function buildSystemPrompt(userInput, mode, docType) {
  let mergedInput = userInput || "";

  if (docType && docType !== "auto") {
    mergedInput = `文种：${docType}\n` + mergedInput;
  }

  if (mode && mode !== "auto") {
    mergedInput = `模式：${mode}\n` + mergedInput;
  }

  // Simple replacement for the only jinja variable we use
  return systemPromptTemplate.replace("{{ user_input }}", mergedInput);
}

// Expose doc types and schemas to the frontend (for dropdowns, etc.)
app.get("/api/doc-schemas", (_req, res) => {
  res.json({
    docTypes: Object.keys(docSchemas),
    schemas: docSchemas,
  });
});

// Export plain text content to Word
app.post("/api/export-docx", async (req, res) => {
  try {
    const { content, filename } = req.body || {};
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content 字段必填且必须为字符串" });
      return;
    }

    // 优先使用显式传入的文件名，其次从内容中解析标题行
    let baseName = (filename && String(filename).trim()) || "";
    if (!baseName) {
      // 支持：【标题】XXX 或 [标题]XXX
      const m =
        String(content).match(/^[\u3010\[]标题[\u3011\]]([^\n\r]+)/m) ||
        String(content).match(/^[\u3010\[]\s*标题\s*[\u3011\]]\s*([^\n\r]+)/m);
      if (m && m[1]) {
        baseName = m[1].trim();
      }
    }
    if (!baseName) {
      baseName = "公文";
    }
    // 去掉文件名中的非法字符
    const safeName = baseName.replace(/[\\\/:*?"<>|]/g, "_");

    const doc = buildDocFromPlainText(content);
    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(safeName)}.docx"`
    );
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "生成 Word 文件失败" });
  }
});

// Streaming generation endpoint for chat-style UI
app.post("/api/generate-stream", async (req, res) => {
  try {
    const { input, mode = "auto", docType = "auto" } = req.body || {};

    if (!input || typeof input !== "string") {
      res.status(400).end("input 字段必填且必须为字符串");
      return;
    }

    const apiKey =
      process.env.DEEPSEEK_API_KEY ||
      "sk-4e048ca2952c49efafdd3b93c44f6b99";

    const systemPrompt = buildSystemPrompt(input, mode, docType);

    const payload = {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: "请严格按照系统提示中的要求生成或润色公文内容。",
        },
      ],
      temperature: 0.2,
    };

    const response = await callDeepseekChatStream(payload, apiKey);

    if (!response.ok || !response.body) {
      let text = "";
      try {
        text = await response.text();
      } catch (e) {
        text = "";
      }
      res
        .status(502)
        .end(
          text ||
            `调用 deepseek 接口失败，状态码 ${response.status}`
        );
      return;
    }

    // 前端按行解析，每行是一个 JSON，对应一个增量片段：
    // { type: "reasoning" | "content", delta: "..." }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    const decoder = new TextDecoder("utf-8");
    const reader = response.body.getReader();

    let buffer = "";
    let raw = "";
    let sentAny = false;
    let finished = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunkText = decoder.decode(value, { stream: true });
      raw += chunkText;
      buffer += chunkText;

      let lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr) {
          continue;
        }
        if (dataStr === "[DONE]") {
          finished = true;
          break;
        }
        try {
          const json = JSON.parse(dataStr);
          const choice = json.choices && json.choices[0];
          const delta = choice && choice.delta;
          if (!delta) {
            continue;
          }

          const reasoningToken =
            delta.reasoning_content || delta.thinking || "";
          const contentToken = delta.content || "";

          if (reasoningToken) {
            res.write(
              JSON.stringify({
                type: "reasoning",
                delta: reasoningToken,
              }) + "\n"
            );
            sentAny = true;
          }

          if (contentToken) {
            res.write(
              JSON.stringify({
                type: "content",
                delta: contentToken,
              }) + "\n"
            );
            sentAny = true;
          }
        } catch (e) {
          continue;
        }
      }

      if (finished) {
        break;
      }
    }

    if (!sentAny && raw) {
      let contentToSend = "";
      let reasoningToSend = "";
      try {
        const obj = JSON.parse(raw);
        const choice =
          obj.choices && obj.choices.length ? obj.choices[0] : null;
        const message = choice && choice.message;
        if (message) {
          contentToSend = message.content || "";
          reasoningToSend =
            message.reasoning_content || message.thinking || "";
        } else {
          contentToSend = "";
        }
      } catch (e) {
        contentToSend = raw;
      }
      if (reasoningToSend) {
        res.write(
          JSON.stringify({ type: "reasoning", delta: reasoningToSend }) +
            "\n"
        );
      }
      if (contentToSend) {
        res.write(
          JSON.stringify({ type: "content", delta: contentToSend }) + "\n"
        );
      }
    }

    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).end("服务器内部错误");
    } else {
      res.end();
    }
  }
});

// Main generation endpoint
app.post("/api/generate", async (req, res) => {
  try {
    const { input, mode = "auto", docType = "auto" } = req.body || {};

    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "input 字段必填且必须为字符串" });
    }

    // 优先使用环境变量，如未设置则使用写死的密钥（不推荐在生产环境使用）
    const apiKey =
      process.env.DEEPSEEK_API_KEY ||
      "sk-4e048ca2952c49efafdd3b93c44f6b99";

    const systemPrompt = buildSystemPrompt(input, mode, docType);

    const payload = {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: "请严格按照系统提示中的要求生成或润色公文内容。",
        },
      ],
      temperature: 0.2,
    };

    const response = await callDeepseekChatCompletions(payload, apiKey);

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({
        error: "调用 deepseek 接口失败",
        status: response.status,
        details: text.slice(0, 2000),
      });
    }

    const data = await response.json();
    const content =
      (data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      "";

    res.json({ content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "服务器内部错误" });
  }
});

app.listen(PORT, () => {
  console.log(`AI agent server is running at http://localhost:${PORT}`);
});
